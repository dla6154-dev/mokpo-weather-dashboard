from __future__ import annotations

import asyncio
import json
import threading
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from .clients import WeatherApiClient
from .config import AppSettings
from .models import (
    AreaRow,
    AreaWarningEntry,
    AreaWarningSnapshot,
    Commentary,
    DashboardSnapshot,
    HealthResponse,
    Query1Snapshot,
    SnapshotMeta,
    SourceStatus,
)
from .parsers import (
    parse_commentary,
    parse_fct_afs_do,
    parse_kma_buoy,
    parse_kma_lhaws2,
    parse_marine_json,
    parse_marine_xml,
    parse_query1_rows,
    parse_sea_obs,
    parse_wrn_now_data,
)


@dataclass(slots=True)
class BuildResult:
    snapshot: DashboardSnapshot
    statuses: list[SourceStatus]
    warning_map_bytes: bytes | None


@dataclass(slots=True)
class Query1BuildResult:
    snapshot: Query1Snapshot
    statuses: list[SourceStatus]


@dataclass(slots=True)
class AreaWarningBuildResult:
    snapshot: AreaWarningSnapshot
    statuses: list[SourceStatus]
    warning_map_bytes: bytes | None


class RefreshError(RuntimeError):
    pass


def _parse_hhmm_to_minutes(value: str) -> int | None:
    text = str(value or "").strip()
    if len(text) != 4 or not text.isdigit():
        return None
    hour = int(text[:2])
    minute = int(text[2:])
    if hour > 23 or minute > 59:
        return None
    return hour * 60 + minute


def _normalize_region_label(value: str) -> str:
    return (
        str(value or "")
        .strip()
        .replace(" ", "")
        .replace("\t", "")
        .replace("·", "")
        .replace("ㆍ", "")
    )


def _read_query1_row_value(row: Any, snake_name: str, camel_name: str) -> str:
    if hasattr(row, snake_name):
        return str(getattr(row, snake_name) or "")
    if isinstance(row, dict):
        return str(row.get(snake_name, row.get(camel_name, "")) or "")
    return ""


def _summarize_query1_rows(rows: list[Any]) -> list[dict[str, Any]]:
    grouped: dict[str, list[str]] = defaultdict(list)
    for row in rows:
        observation_type = _read_query1_row_value(row, "observation_type", "observationType")
        hhmm = _read_query1_row_value(row, "hhmm", "hhmm")
        if observation_type:
            grouped[observation_type].append(hhmm)

    summaries: list[dict[str, Any]] = []
    for observation_type in sorted(grouped):
        hhmm_values = [value for value in grouped[observation_type] if value]
        minute_values = sorted({_parse_hhmm_to_minutes(value) for value in hhmm_values if _parse_hhmm_to_minutes(value) is not None})
        minute_values = [value for value in minute_values if value is not None]
        intervals = sorted({later - earlier for earlier, later in zip(minute_values, minute_values[1:]) if later > earlier})
        counts = Counter(hhmm_values)
        summaries.append(
            {
                "observationType": observation_type,
                "rowCount": len(hhmm_values),
                "displayTimes": sorted(counts),
                "displayTimeCounts": dict(sorted(counts.items())),
                "displayIntervalsMinutes": intervals,
            }
        )
    return summaries


class DashboardBuilder:
    CORE_SOURCES = {"wrn_now_data", "commentary", "sea_obs", "marine_json", "forecast_fallback"}

    def __init__(self, settings: AppSettings, client: WeatherApiClient) -> None:
        self.settings = settings
        self.client = client
        self.tz = ZoneInfo(settings.timezone_name)

    def build(self, now: datetime | None = None) -> BuildResult:
        current = now or self.client.now()
        missing = self.settings.missing_env_vars()
        if missing:
            raise RefreshError(f"Missing environment variables: {', '.join(missing)}")

        statuses: list[SourceStatus] = []

        def fetch(name: str, fn: Any, allow_empty: bool = False) -> Any:
            started = datetime.now(self.tz)
            try:
                value = fn()
                record_count = len(value) if isinstance(value, (bytes, str, list, dict)) else None
                statuses.append(SourceStatus(name=name, ok=True, fetched_at=started, record_count=record_count))
                if not allow_empty and value in ("", None):
                    raise RefreshError(f"{name} returned empty data")
                return value
            except Exception as exc:  # pragma: no cover - exercised in service tests
                statuses.append(SourceStatus(name=name, ok=False, fetched_at=started, error=str(exc)))
                if name in self.CORE_SOURCES:
                    raise RefreshError(f"{name} failed: {exc}") from exc
                return None

        warning_text = fetch("wrn_now_data", self.client.fetch_wrn_now_data)
        commentary_text = fetch("commentary", self.client.fetch_commentary)
        sea_obs_text = fetch("sea_obs", self.client.fetch_sea_obs)
        kma_lhaws2_text = fetch("kma_lhaws2", self.client.fetch_kma_lhaws2)
        kma_buoy_text = fetch("kma_buoy", self.client.fetch_kma_buoy)
        forecast_today_text = fetch("forecast_today", lambda: self.client.fetch_forecast_today(current), allow_empty=True)
        forecast_fallback_text = fetch("forecast_fallback", lambda: self.client.fetch_forecast_fallback(current))
        marine_json_text = fetch("marine_json", self.client.fetch_marine_json)
        marine_xml_text = fetch("marine_xml", self.client.fetch_marine_xml)
        marine_hajo_text = fetch("marine_hajo", self.client.fetch_marine_hajo)
        warning_map_bytes = fetch("warning_map", lambda: self.client.fetch_warning_map(current), allow_empty=True)

        warnings = parse_wrn_now_data(warning_text)
        commentary = parse_commentary(commentary_text)
        sea_obs = parse_sea_obs(sea_obs_text)
        _ = parse_kma_lhaws2(kma_lhaws2_text or "")
        _ = parse_kma_buoy(kma_buoy_text or "")

        observations = dict(sea_obs)
        for record in parse_marine_json(marine_json_text or "").values():
            observations[record.station_id] = record
        for record in parse_marine_xml(marine_xml_text or "").values():
            observations[record.station_id] = record
        for record in parse_marine_json(marine_hajo_text or "").values():
            observations[record.station_id] = record

        forecast_today = parse_fct_afs_do(forecast_today_text or "", self.settings.forecast_regions)
        forecast_fallback = parse_fct_afs_do(forecast_fallback_text, self.settings.forecast_regions)

        warning_lookup: dict[str, list] = {}
        for item in warnings:
            warning_lookup.setdefault(item.region_name, []).append(item)

        rows: list[AreaRow] = []
        for raw_row in self.settings.warning_rows:
            station_id = str(raw_row["station_id"])
            observation = observations.get(station_id)
            if observation is None:
                observation = observations.get(self.settings.station_aliases.get(station_id, ""))
            forecast_key = f"{raw_row['area_name']}/{raw_row['forecast_slot']}"
            forecast = forecast_today.get(forecast_key) or forecast_fallback.get(forecast_key)
            row = AreaRow(
                area_name=raw_row["area_name"],
                warning_region=raw_row["warning_region"],
                display_group=raw_row["display_group"],
                display_subgroup=raw_row["display_subgroup"],
                time_slot=raw_row["display_slot"],
                forecast_slot=raw_row["forecast_slot"],
                forecast_wind_direction=forecast.wind_direction if forecast and raw_row["show_forecast"] else "",
                forecast_wind_speed=forecast.wind_speed if forecast and raw_row["show_forecast"] else "",
                forecast_wave_height=forecast.wave_height if forecast and raw_row["show_forecast"] else "",
                forecast_weather=forecast.weather if forecast and raw_row["show_forecast"] else "",
                show_forecast=bool(raw_row["show_forecast"]),
                source_name=raw_row["source_name"],
                station_id=station_id,
                observed_at=observation.observed_at if observation else "",
                observed_wind_dir=observation.observed_wind_dir if observation else "",
                observed_wind_speed=observation.observed_wind_speed if observation else "",
                gust=observation.gust if observation else "",
                wave_height=observation.wave_height if observation else "",
                wave_height_max=observation.wave_height_max if observation else "",
                visibility=observation.visibility if observation else "",
                special_warnings=warning_lookup.get(raw_row["warning_region"], []),
            )
            rows.append(row)

        snapshot = DashboardSnapshot(
            meta=SnapshotMeta(
                generated_at=current,
                last_success_at=current,
                stale=False,
                stale_reason="",
                refresh_interval_seconds=self.settings.refresh_interval_seconds,
                client_refresh_interval_seconds=self.settings.client_refresh_interval_seconds,
                snapshot_age_seconds=0,
                missing_env_vars=[],
            ),
            warning_map_url="/api/dashboard/warning-map.png",
            warnings=warnings,
            commentary=commentary,
            rows=rows,
        )
        return BuildResult(snapshot=snapshot, statuses=statuses, warning_map_bytes=warning_map_bytes)


class DashboardService:
    def __init__(self, settings: AppSettings, client: WeatherApiClient | None = None) -> None:
        self.settings = settings
        self.client = client or WeatherApiClient(settings)
        self.builder = DashboardBuilder(settings, self.client)
        self._snapshot: DashboardSnapshot | None = None
        self._health = HealthResponse(meta=self._empty_meta(), sources=[])
        self._lock = threading.Lock()
        self._task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()
        self._load_cached_snapshot()

    def _empty_meta(self) -> SnapshotMeta:
        return SnapshotMeta(
            generated_at=None,
            last_success_at=None,
            stale=True,
            stale_reason="No successful refresh yet.",
            refresh_interval_seconds=self.settings.refresh_interval_seconds,
            client_refresh_interval_seconds=self.settings.client_refresh_interval_seconds,
            snapshot_age_seconds=None,
            missing_env_vars=self.settings.missing_env_vars(),
        )

    def _load_cached_snapshot(self) -> None:
        path = self.settings.snapshot_cache_path
        if not path.exists():
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            snapshot = DashboardSnapshot.model_validate(data)
            snapshot.meta.stale = True
            snapshot.meta.stale_reason = "Loaded from local cache. Waiting for live refresh."
            self._snapshot = snapshot
            self._health = HealthResponse(meta=snapshot.meta, sources=[])
        except Exception:
            pass

    def _save_snapshot(self, snapshot: DashboardSnapshot) -> None:
        self.settings.snapshot_cache_path.write_text(
            json.dumps(snapshot.model_dump(mode="json", by_alias=True), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def _save_warning_map(self, payload: bytes | None) -> None:
        if payload:
            self.settings.warning_map_cache_path.write_bytes(payload)

    async def start(self) -> None:
        await self.refresh_once()
        self._stop_event.clear()
        self._task = asyncio.create_task(self._refresh_loop())

    async def stop(self) -> None:
        self._stop_event.set()
        if self._task:
            await self._task

    async def _refresh_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=self.settings.runtime_config.get('dashboard_refresh_seconds'))
            except asyncio.TimeoutError:
                await self.refresh_once()

    async def refresh_once(self) -> None:
        try:
            result = await asyncio.to_thread(self.builder.build)
        except RefreshError as exc:
            with self._lock:
                if self._snapshot:
                    self._snapshot.meta.stale = True
                    self._snapshot.meta.stale_reason = str(exc)
                    self._snapshot.meta.snapshot_age_seconds = self._snapshot_age(self._snapshot.meta.generated_at)
                    self._health = HealthResponse(meta=self._snapshot.meta, sources=self._health.sources)
                else:
                    self._health = HealthResponse(meta=self._empty_meta(), sources=self._health.sources)
                    self._health.meta.stale_reason = str(exc)
            return

        snapshot = result.snapshot
        snapshot.meta.snapshot_age_seconds = 0
        self._save_snapshot(snapshot)
        self._save_warning_map(result.warning_map_bytes)
        with self._lock:
            self._snapshot = snapshot
            self._health = HealthResponse(meta=snapshot.meta, sources=result.statuses)

    def _snapshot_age(self, generated_at: datetime | None) -> int | None:
        if generated_at is None:
            return None
        now = datetime.now(ZoneInfo(self.settings.timezone_name))
        return int((now - generated_at).total_seconds())

    def get_snapshot(self) -> DashboardSnapshot | None:
        with self._lock:
            if not self._snapshot:
                meta = self._health.meta.model_copy(deep=True)
                meta.snapshot_age_seconds = self._snapshot_age(meta.generated_at)
                return DashboardSnapshot(
                    meta=meta,
                    warning_map_url="",
                    warnings=[],
                    commentary=Commentary(),
                    rows=[],
                )
            snapshot = self._snapshot.model_copy(deep=True)
            snapshot.meta.snapshot_age_seconds = self._snapshot_age(snapshot.meta.generated_at)
            snapshot.warning_map_url = f"/api/dashboard/warning-map.png?ts={int(datetime.now().timestamp())}"
            return snapshot

    def get_health(self) -> HealthResponse:
        with self._lock:
            health = self._health.model_copy(deep=True)
            health.meta.snapshot_age_seconds = self._snapshot_age(health.meta.generated_at)
            return health

    def get_warning_map_path(self) -> Path | None:
        path = self.settings.warning_map_cache_path
        return path if path.exists() else None


class Query1Builder:
    CORE_SOURCES = {"sea_obs", "kma_buoy"}

    def __init__(self, settings: AppSettings, client: WeatherApiClient) -> None:
        self.settings = settings
        self.client = client
        self.tz = ZoneInfo(settings.timezone_name)

    def _refresh_seconds(self) -> int:
        return self.settings.runtime_config.get("query1_refresh_seconds")

    def build(self, now: datetime | None = None, buoy_tm: str | None = None) -> Query1BuildResult:
        current = now or self.client.now()
        if not self.settings.kma_pub_auth_key:
            raise RefreshError("Missing environment variables: KMA_PUB_AUTH_KEY")

        statuses: list[SourceStatus] = []

        def fetch(name: str, fn: Any) -> str:
            started = datetime.now(self.tz)
            try:
                value = fn()
                statuses.append(
                    SourceStatus(
                        name=name,
                        ok=True,
                        fetched_at=started,
                        record_count=len(value) if isinstance(value, (bytes, str, list, dict)) else None,
                    )
                )
                if value in ("", None):
                    raise RefreshError(f"{name} returned empty data")
                return value
            except Exception as exc:
                statuses.append(SourceStatus(name=name, ok=False, fetched_at=started, error=str(exc)))
                if name in self.CORE_SOURCES:
                    raise RefreshError(f"{name} failed: {exc}") from exc
                return ""

        sea_obs_text = fetch(
            "sea_obs",
            lambda: self.client.fetch_sea_obs_at(buoy_tm or current.strftime("%Y%m%d%H%M")),
        )
        kma_buoy_text = fetch(
            "kma_buoy",
            lambda: self.client.fetch_kma_buoy_at(buoy_tm or current.strftime("%Y%m%d%H%M")),
        )
        marine_json_text = ""
        marine_hajo_text = ""
        buoy_station_info_text = ""
        if self.settings.kma_auth_key:
            buoy_station_info_text = fetch("station_info_buoy", lambda: self.client.fetch_station_info("BUOY"))
        if self.settings.marine_service_key_json:
            marine_json_text = fetch("marine_json", self.client.fetch_marine_json)
            marine_hajo_text = fetch("marine_hajo", self.client.fetch_marine_hajo)
        rows = parse_query1_rows(
            sea_obs_text,
            kma_buoy_text,
            marine_json_text,
            marine_hajo_text,
            buoy_station_info_text,
        )

        snapshot = Query1Snapshot(
            meta=SnapshotMeta(
                generated_at=current,
                last_success_at=current,
                stale=False,
                stale_reason="",
                refresh_interval_seconds=self._refresh_seconds(),
                client_refresh_interval_seconds=self._refresh_seconds(),
                snapshot_age_seconds=0,
                missing_env_vars=[],
            ),
            rows=rows,
        )
        return Query1BuildResult(snapshot=snapshot, statuses=statuses)


class Query1Service:
    def __init__(self, settings: AppSettings, client: WeatherApiClient | None = None) -> None:
        self.settings = settings
        self.client = client or WeatherApiClient(settings)
        self.builder = Query1Builder(settings, self.client)
        self.tz = ZoneInfo(settings.timezone_name)
        self._snapshot: Query1Snapshot | None = None
        self._health = HealthResponse(meta=self._empty_meta(), sources=[])
        self._lock = threading.Lock()
        self._task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()
        self._load_cached_snapshot()

    def _refresh_seconds(self) -> int:
        return self.settings.runtime_config.get("query1_refresh_seconds")

    def _empty_meta(self) -> SnapshotMeta:
        missing = []
        if not self.settings.kma_pub_auth_key:
            missing.append("KMA_PUB_AUTH_KEY")
        return SnapshotMeta(
            generated_at=None,
            last_success_at=None,
            stale=True,
            stale_reason="No successful refresh yet.",
            refresh_interval_seconds=self._refresh_seconds(),
            client_refresh_interval_seconds=self._refresh_seconds(),
            snapshot_age_seconds=None,
            missing_env_vars=missing,
        )

    def _load_cached_snapshot(self) -> None:
        path = self.settings.query1_snapshot_cache_path
        if not path.exists():
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            snapshot = Query1Snapshot.model_validate(data)
            snapshot.meta.stale = True
            snapshot.meta.stale_reason = "Loaded from local cache. Waiting for live refresh."
            self._snapshot = snapshot
            self._health = HealthResponse(meta=snapshot.meta, sources=[])
        except Exception:
            pass

    def _save_snapshot(self, snapshot: Query1Snapshot) -> None:
        self.settings.query1_snapshot_cache_path.write_text(
            json.dumps(snapshot.model_dump(mode="json", by_alias=True), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def _append_arrival_log(self, snapshot: Query1Snapshot, statuses: list[SourceStatus]) -> None:
        payload = {
            "loggedAt": datetime.now(self.tz).isoformat(),
            "generatedAt": snapshot.meta.generated_at.isoformat() if snapshot.meta.generated_at else None,
            "rowCount": len(snapshot.rows),
            "observationTypeSummary": _summarize_query1_rows(snapshot.rows),
            "sourceStatuses": [status.model_dump(mode="json", by_alias=True) for status in statuses],
            "rows": [row.model_dump(mode="json", by_alias=True) for row in snapshot.rows],
        }
        with self.settings.query1_arrival_log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False) + "\n")

    def _load_arrival_log_entries(self, limit: int = 288) -> list[dict[str, Any]]:
        path = self.settings.query1_arrival_log_path
        if not path.exists():
            return []
        entries: list[dict[str, Any]] = []
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except Exception:
            return []
        for raw in lines[-limit:]:
            raw = raw.strip()
            if not raw:
                continue
            try:
                entries.append(json.loads(raw))
            except Exception:
                continue
        return entries

    async def start(self) -> None:
        await self.refresh_once()
        self._stop_event.clear()
        self._task = asyncio.create_task(self._refresh_loop())

    async def stop(self) -> None:
        self._stop_event.set()
        if self._task:
            await self._task

    async def _refresh_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=self.settings.runtime_config.get('query1_refresh_seconds'))
            except asyncio.TimeoutError:
                await self.refresh_once()

    async def refresh_once(self) -> None:
        try:
            result = await asyncio.to_thread(self.builder.build)
        except RefreshError as exc:
            with self._lock:
                if self._snapshot:
                    self._snapshot.meta.stale = True
                    self._snapshot.meta.stale_reason = str(exc)
                    self._snapshot.meta.snapshot_age_seconds = self._snapshot_age(self._snapshot.meta.generated_at)
                    self._health = HealthResponse(meta=self._snapshot.meta, sources=self._health.sources)
                else:
                    self._health = HealthResponse(meta=self._empty_meta(), sources=self._health.sources)
                    self._health.meta.stale_reason = str(exc)
            return

        snapshot = result.snapshot
        snapshot.meta.snapshot_age_seconds = 0
        self._save_snapshot(snapshot)
        self._append_arrival_log(snapshot, result.statuses)
        with self._lock:
            self._snapshot = snapshot
            self._health = HealthResponse(meta=snapshot.meta, sources=result.statuses)

    def _snapshot_age(self, generated_at: datetime | None) -> int | None:
        if generated_at is None:
            return None
        now = datetime.now(ZoneInfo(self.settings.timezone_name))
        return int((now - generated_at).total_seconds())

    def get_snapshot(self) -> Query1Snapshot:
        with self._lock:
            if not self._snapshot:
                meta = self._health.meta.model_copy(deep=True)
                meta.snapshot_age_seconds = self._snapshot_age(meta.generated_at)
                return Query1Snapshot(meta=meta, rows=[])
            snapshot = self._snapshot.model_copy(deep=True)
            snapshot.meta.snapshot_age_seconds = self._snapshot_age(snapshot.meta.generated_at)
            return snapshot

    def get_health(self) -> HealthResponse:
        with self._lock:
            health = self._health.model_copy(deep=True)
            health.meta.snapshot_age_seconds = self._snapshot_age(health.meta.generated_at)
            return health

    def get_log_summary(self) -> dict[str, Any]:
        entries = self._load_arrival_log_entries()
        generated_times: list[datetime] = []
        for entry in entries:
            raw = entry.get("generatedAt")
            if not raw:
                continue
            try:
                generated_times.append(datetime.fromisoformat(raw))
            except ValueError:
                continue

        generated_times.sort()
        refresh_intervals = [
            int(round((later - earlier).total_seconds() / 60))
            for earlier, later in zip(generated_times, generated_times[1:])
            if later > earlier
        ]

        latest_rows: list[Any] = []
        latest_generated_at = None
        if entries:
            latest_rows = entries[-1].get("rows", [])
            latest_generated_at = entries[-1].get("generatedAt")
        elif self._snapshot:
            latest_rows = self._snapshot.rows
            latest_generated_at = self._snapshot.meta.generated_at.isoformat() if self._snapshot.meta.generated_at else None

        return {
            "logPath": str(self.settings.query1_arrival_log_path),
            "entryCount": len(entries),
            "latestGeneratedAt": latest_generated_at,
            "refreshIntervalsMinutes": sorted(set(refresh_intervals)),
            "latestRowSummary": _summarize_query1_rows(latest_rows),
        }


class AreaWarningBuilder:
    CORE_SOURCES = {"wrn_now_data"}

    def __init__(self, settings: AppSettings, client: WeatherApiClient) -> None:
        self.settings = settings
        self.client = client
        self.tz = ZoneInfo(settings.timezone_name)

    def build(self, now: datetime | None = None, warning_tm: str | None = None) -> AreaWarningBuildResult:
        current = now or self.client.now()
        if not self.settings.kma_auth_key:
            raise RefreshError("Missing environment variables: KMA_AUTH_KEY")

        statuses: list[SourceStatus] = []

        def fetch(name: str, fn: Any, allow_empty: bool = False) -> Any:
            started = datetime.now(self.tz)
            try:
                value = fn()
                record_count = len(value) if isinstance(value, (bytes, str, list, dict)) else None
                statuses.append(SourceStatus(name=name, ok=True, fetched_at=started, record_count=record_count))
                if not allow_empty and value in ("", None):
                    raise RefreshError(f"{name} returned empty data")
                return value
            except Exception as exc:
                statuses.append(SourceStatus(name=name, ok=False, fetched_at=started, error=str(exc)))
                if name in self.CORE_SOURCES:
                    raise RefreshError(f"{name} failed: {exc}") from exc
                return None

        warning_text = fetch("wrn_now_data", lambda: self.client.fetch_wrn_now_data_at(warning_tm))
        warning_map_bytes = fetch("warning_map", lambda: self.client.fetch_warning_map(current), allow_empty=True)

        warnings = parse_wrn_now_data(warning_text)
        warning_lookup: dict[str, list] = {}
        warning_name_lookup: dict[str, list] = {}
        for item in warnings:
            warning_lookup.setdefault(item.region_code, []).append(item)
            warning_name_lookup.setdefault(_normalize_region_label(item.region_name), []).append(item)

        entries: list[AreaWarningEntry] = []
        seen_codes: set[str] = set()
        for region in self.settings.area_warning_regions:
            area_code = region["area_code"]
            if area_code in seen_codes:
                continue
            seen_codes.add(area_code)

            matched_warnings = warning_lookup.get(area_code, [])
            if not matched_warnings:
                matched_warnings = warning_name_lookup.get(_normalize_region_label(region["area_name"]), [])
            matched_region_name = matched_warnings[0].region_name if matched_warnings else region["area_name"]
            parent_name = matched_warnings[0].parent_name if matched_warnings else ""

            entries.append(
                AreaWarningEntry(
                    selection_key=area_code,
                    area_code=area_code,
                    area_name=region["area_name"],
                    display_group="",
                    display_subgroup="",
                    area_label=region["area_name"],
                    warning_region=matched_region_name,
                    source_name=parent_name or "",
                    warnings=matched_warnings,
                )
            )

        snapshot = AreaWarningSnapshot(
            meta=SnapshotMeta(
                generated_at=current,
                last_success_at=current,
                stale=False,
                stale_reason="",
                refresh_interval_seconds=self.settings.refresh_interval_seconds,
                client_refresh_interval_seconds=self.settings.client_refresh_interval_seconds,
                snapshot_age_seconds=0,
                missing_env_vars=[],
            ),
            warning_map_url="/api/area-warnings/warning-map.png",
            entries=entries,
        )
        return AreaWarningBuildResult(snapshot=snapshot, statuses=statuses, warning_map_bytes=warning_map_bytes)


class AreaWarningService:
    def __init__(self, settings: AppSettings, client: WeatherApiClient | None = None) -> None:
        self.settings = settings
        self.client = client or WeatherApiClient(settings)
        self.builder = AreaWarningBuilder(settings, self.client)
        self._snapshot: AreaWarningSnapshot | None = None
        self._health = HealthResponse(meta=self._empty_meta(), sources=[])
        self._lock = threading.Lock()
        self._task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()
        self._load_cached_snapshot()

    def _empty_meta(self) -> SnapshotMeta:
        missing = []
        if not self.settings.kma_auth_key:
            missing.append("KMA_AUTH_KEY")
        return SnapshotMeta(
            generated_at=None,
            last_success_at=None,
            stale=True,
            stale_reason="No successful refresh yet.",
            refresh_interval_seconds=self.settings.refresh_interval_seconds,
            client_refresh_interval_seconds=self.settings.client_refresh_interval_seconds,
            snapshot_age_seconds=None,
            missing_env_vars=missing,
        )

    def _load_cached_snapshot(self) -> None:
        path = self.settings.area_warning_snapshot_cache_path
        if not path.exists():
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            snapshot = AreaWarningSnapshot.model_validate(data)
            snapshot.meta.stale = True
            snapshot.meta.stale_reason = "Loaded from local cache. Waiting for live refresh."
            self._snapshot = snapshot
            self._health = HealthResponse(meta=snapshot.meta, sources=[])
        except Exception:
            pass

    def _save_snapshot(self, snapshot: AreaWarningSnapshot) -> None:
        self.settings.area_warning_snapshot_cache_path.write_text(
            json.dumps(snapshot.model_dump(mode="json", by_alias=True), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def _save_warning_map(self, payload: bytes | None) -> None:
        if payload:
            self.settings.warning_map_cache_path.write_bytes(payload)

    async def start(self) -> None:
        await self.refresh_once()
        self._stop_event.clear()
        self._task = asyncio.create_task(self._refresh_loop())

    async def stop(self) -> None:
        self._stop_event.set()
        if self._task:
            await self._task

    async def _refresh_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=self.settings.runtime_config.get('area_warning_refresh_seconds'))
            except asyncio.TimeoutError:
                await self.refresh_once()

    async def refresh_once(self) -> None:
        try:
            result = await asyncio.to_thread(self.builder.build)
        except RefreshError as exc:
            with self._lock:
                if self._snapshot:
                    self._snapshot.meta.stale = True
                    self._snapshot.meta.stale_reason = str(exc)
                    self._snapshot.meta.snapshot_age_seconds = self._snapshot_age(self._snapshot.meta.generated_at)
                    self._health = HealthResponse(meta=self._snapshot.meta, sources=self._health.sources)
                else:
                    self._health = HealthResponse(meta=self._empty_meta(), sources=self._health.sources)
                    self._health.meta.stale_reason = str(exc)
            return

        snapshot = result.snapshot
        snapshot.meta.snapshot_age_seconds = 0
        self._save_snapshot(snapshot)
        self._save_warning_map(result.warning_map_bytes)
        with self._lock:
            self._snapshot = snapshot
            self._health = HealthResponse(meta=snapshot.meta, sources=result.statuses)

    def _snapshot_age(self, generated_at: datetime | None) -> int | None:
        if generated_at is None:
            return None
        now = datetime.now(ZoneInfo(self.settings.timezone_name))
        return int((now - generated_at).total_seconds())

    def get_snapshot(self) -> AreaWarningSnapshot:
        with self._lock:
            if not self._snapshot:
                meta = self._health.meta.model_copy(deep=True)
                meta.snapshot_age_seconds = self._snapshot_age(meta.generated_at)
                return AreaWarningSnapshot(meta=meta, warning_map_url="", entries=[])
            snapshot = self._snapshot.model_copy(deep=True)
            snapshot.meta.snapshot_age_seconds = self._snapshot_age(snapshot.meta.generated_at)
            snapshot.warning_map_url = f"/api/area-warnings/warning-map.png?ts={int(datetime.now().timestamp())}"
            return snapshot

    def get_health(self) -> HealthResponse:
        with self._lock:
            health = self._health.model_copy(deep=True)
            health.meta.snapshot_age_seconds = self._snapshot_age(health.meta.generated_at)
            return health

    def get_warning_map_path(self) -> Path | None:
        path = self.settings.warning_map_cache_path
        return path if path.exists() else None


TIDE_STATIONS = [
    ("DT_0007", "목포"),
    ("SO_0631", "암태"),
    ("SO_0565", "향화"),
    ("SO_1248", "옥도"),
    ("SO_0555", "서망"),
    ("SO_1264", "계마"),
]

TIDE_REFRESH_SECONDS = 3600  # tide forecast changes daily; refresh once per hour


@dataclass(slots=True)
class TideBuildResult:
    snapshot: "TideSnapshot"
    statuses: list[SourceStatus]


class TideBuilder:
    def __init__(self, settings: AppSettings, client: WeatherApiClient) -> None:
        self.settings = settings
        self.client = client
        self.tz = ZoneInfo(settings.timezone_name)

    def build(self, now: datetime | None = None) -> TideBuildResult:
        from .models import TideEntry, TideSnapshot

        current = now or self.client.now()
        if not self.settings.tide_service_key:
            raise RefreshError("Missing environment variables: TIDE_SERVICE_KEY")

        req_date = current.strftime("%Y%m%d")
        statuses: list[SourceStatus] = []
        entries: list[TideEntry] = []

        for obs_code, station_name in TIDE_STATIONS:
            started = datetime.now(self.tz)
            try:
                data = self.client.fetch_tide(obs_code, req_date)
                items = data.get("body", {}).get("items", {}).get("item", [])
                statuses.append(
                    SourceStatus(name=f"tide_{obs_code}", ok=True, fetched_at=started, record_count=len(items))
                )
                for item in items:
                    raw_dt = str(item.get("predcDt", ""))
                    time_str = raw_dt[11:16] if len(raw_dt) >= 16 else raw_dt
                    extr = str(item.get("extrSe", ""))
                    tide_type = "고조" if extr in ("1", "3") else "저조" if extr in ("2", "4") else extr
                    try:
                        level_cm = float(item.get("predcTdlvVl", ""))
                    except (TypeError, ValueError):
                        level_cm = None
                    entries.append(
                        TideEntry(
                            station_name=station_name,
                            tide_type=tide_type,
                            time_str=time_str,
                            level_cm=level_cm,
                        )
                    )
            except Exception as exc:
                statuses.append(SourceStatus(name=f"tide_{obs_code}", ok=False, fetched_at=started, error=str(exc)))

        snapshot = TideSnapshot(
            meta=SnapshotMeta(
                generated_at=current,
                last_success_at=current,
                stale=False,
                stale_reason="",
                refresh_interval_seconds=TIDE_REFRESH_SECONDS,
                client_refresh_interval_seconds=TIDE_REFRESH_SECONDS,
                snapshot_age_seconds=0,
                missing_env_vars=[],
            ),
            date_str=current.strftime("%Y년 %m월 %d일"),
            entries=entries,
        )
        return TideBuildResult(snapshot=snapshot, statuses=statuses)


class TideService:
    def __init__(self, settings: AppSettings, client: WeatherApiClient | None = None) -> None:
        from .models import TideSnapshot

        self.settings = settings
        self.client = client or WeatherApiClient(settings)
        self.builder = TideBuilder(settings, self.client)
        self._snapshot: TideSnapshot | None = None
        self._health = HealthResponse(meta=self._empty_meta(), sources=[])
        self._lock = threading.Lock()
        self._task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()
        self._load_cached_snapshot()

    def _empty_meta(self) -> SnapshotMeta:
        missing = [] if self.settings.tide_service_key else ["TIDE_SERVICE_KEY"]
        return SnapshotMeta(
            generated_at=None,
            last_success_at=None,
            stale=True,
            stale_reason="No successful refresh yet.",
            refresh_interval_seconds=TIDE_REFRESH_SECONDS,
            client_refresh_interval_seconds=TIDE_REFRESH_SECONDS,
            snapshot_age_seconds=None,
            missing_env_vars=missing,
        )

    def _load_cached_snapshot(self) -> None:
        from .models import TideSnapshot

        path = self.settings.tide_snapshot_cache_path
        if not path.exists():
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            snapshot = TideSnapshot.model_validate(data)
            snapshot.meta.stale = True
            snapshot.meta.stale_reason = "Loaded from local cache. Waiting for live refresh."
            self._snapshot = snapshot
            self._health = HealthResponse(meta=snapshot.meta, sources=[])
        except Exception:
            pass

    def _save_snapshot(self, snapshot: "TideSnapshot") -> None:
        self.settings.tide_snapshot_cache_path.write_text(
            json.dumps(snapshot.model_dump(mode="json", by_alias=True), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    async def start(self) -> None:
        await self.refresh_once()
        self._stop_event.clear()
        self._task = asyncio.create_task(self._refresh_loop())

    async def stop(self) -> None:
        self._stop_event.set()
        if self._task:
            await self._task

    async def _refresh_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=TIDE_REFRESH_SECONDS)
            except asyncio.TimeoutError:
                await self.refresh_once()

    async def refresh_once(self) -> None:
        try:
            result = await asyncio.to_thread(self.builder.build)
        except RefreshError as exc:
            with self._lock:
                if self._snapshot:
                    self._snapshot.meta.stale = True
                    self._snapshot.meta.stale_reason = str(exc)
                else:
                    self._health = HealthResponse(meta=self._empty_meta(), sources=self._health.sources)
                    self._health.meta.stale_reason = str(exc)
            return

        snapshot = result.snapshot
        snapshot.meta.snapshot_age_seconds = 0
        self._save_snapshot(snapshot)
        with self._lock:
            self._snapshot = snapshot
            self._health = HealthResponse(meta=snapshot.meta, sources=result.statuses)

    def _snapshot_age(self, generated_at: datetime | None) -> int | None:
        if generated_at is None:
            return None
        now = datetime.now(ZoneInfo(self.settings.timezone_name))
        return int((now - generated_at).total_seconds())

    def get_snapshot(self) -> "TideSnapshot":
        from .models import TideSnapshot

        with self._lock:
            if not self._snapshot:
                meta = self._health.meta.model_copy(deep=True)
                return TideSnapshot(meta=meta, date_str="", entries=[])
            snapshot = self._snapshot.model_copy(deep=True)
            snapshot.meta.snapshot_age_seconds = self._snapshot_age(snapshot.meta.generated_at)
            return snapshot

    def get_health(self) -> HealthResponse:
        with self._lock:
            health = self._health.model_copy(deep=True)
            health.meta.snapshot_age_seconds = self._snapshot_age(health.meta.generated_at)
            return health
