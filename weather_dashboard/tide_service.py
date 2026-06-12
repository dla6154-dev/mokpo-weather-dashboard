from __future__ import annotations

import asyncio
import json
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from .clients import WeatherApiClient
from .config import AppSettings
from .models import (
    HealthResponse,
    SnapshotMeta,
    SourceStatus,
    TideDaySnapshot,
    TideEntry,
    TideSnapshot,
)
from .service import RefreshError

TIDE_STATIONS = [
    ("SO_0555", "서망"),
    ("SO_0702", "진도옥도"),
    ("SO_0567", "쉬미"),
    ("DT_0094", "서거차도"),
]

TIDE_DAY_LABELS = ("오늘", "내일", "모레")
TIDE_REFRESH_SECONDS = 3600


@dataclass(slots=True)
class TideBuildResult:
    snapshot: TideSnapshot
    statuses: list[SourceStatus]


class TideBuilder:
    def __init__(self, settings: AppSettings, client: WeatherApiClient) -> None:
        self.settings = settings
        self.client = client
        self.tz = ZoneInfo(settings.timezone_name)

    def _index_previous_entries(
        self,
        previous_snapshot: TideSnapshot | None,
        fallback_date_key: str,
    ) -> dict[str, dict[str, list[TideEntry]]]:
        indexed: dict[str, dict[str, list[TideEntry]]] = {}
        if not previous_snapshot:
            return indexed

        if previous_snapshot.days:
            for day in previous_snapshot.days:
                station_map = indexed.setdefault(day.date_key, {})
                for entry in day.entries:
                    station_map.setdefault(entry.station_name, []).append(entry)
            return indexed

        station_map = indexed.setdefault(fallback_date_key, {})
        for entry in previous_snapshot.entries:
            station_map.setdefault(entry.station_name, []).append(entry)
        return indexed

    def _build_day_snapshot(
        self,
        day_current: datetime,
        label: str,
        previous_entries_by_date: dict[str, dict[str, list[TideEntry]]],
        statuses: list[SourceStatus],
        fallback_used: list[str],
    ) -> TideDaySnapshot:
        req_date = day_current.strftime("%Y%m%d")
        station_fallback_map = previous_entries_by_date.get(req_date, {})
        day_entries: list[TideEntry] = []

        for obs_code, station_name in TIDE_STATIONS:
            started = datetime.now(self.tz)
            source_name = f"tide_{obs_code}_{req_date}"
            try:
                data = self.client.fetch_tide(obs_code, req_date)
                items = data.get("body", {}).get("items", {}).get("item", [])
                if isinstance(items, dict):
                    items = [items]
                statuses.append(
                    SourceStatus(
                        name=source_name,
                        ok=True,
                        fetched_at=started,
                        record_count=len(items),
                    )
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
                    day_entries.append(
                        TideEntry(
                            station_name=station_name,
                            tide_type=tide_type,
                            time_str=time_str,
                            level_cm=level_cm,
                        )
                    )
            except Exception as exc:
                fallback_entries = station_fallback_map.get(station_name, [])
                if fallback_entries:
                    day_entries.extend(entry.model_copy(deep=True) for entry in fallback_entries)
                    fallback_used.append(f"{label}:{station_name}")
                statuses.append(
                    SourceStatus(
                        name=source_name,
                        ok=False,
                        fetched_at=started,
                        record_count=len(fallback_entries) if fallback_entries else None,
                        error=str(exc),
                    )
                )

        return TideDaySnapshot(
            label=label,
            date_key=req_date,
            date_str=day_current.strftime("%Y년 %m월 %d일"),
            entries=day_entries,
        )

    def build(
        self,
        now: datetime | None = None,
        previous_snapshot: TideSnapshot | None = None,
    ) -> TideBuildResult:
        current = now or self.client.now()
        if not self.settings.tide_service_key:
            raise RefreshError("Missing environment variables: TIDE_SERVICE_KEY")

        previous_entries_by_date = self._index_previous_entries(
            previous_snapshot,
            current.strftime("%Y%m%d"),
        )

        statuses: list[SourceStatus] = []
        fallback_used: list[str] = []
        day_snapshots: list[TideDaySnapshot] = []

        for offset, label in enumerate(TIDE_DAY_LABELS):
            day_current = current + timedelta(days=offset)
            day_snapshot = self._build_day_snapshot(
                day_current,
                label,
                previous_entries_by_date,
                statuses,
                fallback_used,
            )
            day_snapshots.append(day_snapshot)

        ok_count = sum(1 for status in statuses if status.ok)
        if ok_count == 0 and not fallback_used:
            errors = "; ".join(
                f"{status.name}: {status.error}" for status in statuses if status.error
            ) or "No tide sources succeeded."
            raise RefreshError(f"All tide sources failed: {errors}")

        today_snapshot = day_snapshots[0] if day_snapshots else TideDaySnapshot()
        if not today_snapshot.entries and not any(day.entries for day in day_snapshots):
            raise RefreshError("Tide API returned no entries.")

        stale = bool(fallback_used)
        stale_reason = (
            f"일부 지점 이전값 사용: {', '.join(fallback_used)}"
            if fallback_used
            else ""
        )
        last_success_at = (
            previous_snapshot.meta.last_success_at
            if stale and previous_snapshot and previous_snapshot.meta.last_success_at
            else current
        )

        snapshot = TideSnapshot(
            meta=SnapshotMeta(
                generated_at=current,
                last_success_at=last_success_at,
                stale=stale,
                stale_reason=stale_reason,
                refresh_interval_seconds=TIDE_REFRESH_SECONDS,
                client_refresh_interval_seconds=TIDE_REFRESH_SECONDS,
                snapshot_age_seconds=0,
                missing_env_vars=[],
            ),
            date_str=today_snapshot.date_str,
            entries=today_snapshot.entries,
            days=day_snapshots,
        )
        return TideBuildResult(snapshot=snapshot, statuses=statuses)


class TideService:
    def __init__(self, settings: AppSettings, client: WeatherApiClient | None = None) -> None:
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

    def _save_snapshot(self, snapshot: TideSnapshot) -> None:
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
                await asyncio.wait_for(
                    self._stop_event.wait(),
                    timeout=self.settings.runtime_config.get("tide_refresh_seconds"),
                )
            except asyncio.TimeoutError:
                await self.refresh_once()

    async def refresh_once(self) -> None:
        try:
            previous_snapshot = self._snapshot.model_copy(deep=True) if self._snapshot else None
            result = await asyncio.to_thread(self.builder.build, None, previous_snapshot)
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
        with self._lock:
            self._snapshot = snapshot
            self._health = HealthResponse(meta=snapshot.meta, sources=result.statuses)

    def _snapshot_age(self, generated_at: datetime | None) -> int | None:
        if generated_at is None:
            return None
        now = datetime.now(ZoneInfo(self.settings.timezone_name))
        return int((now - generated_at).total_seconds())

    def get_snapshot(self) -> TideSnapshot:
        with self._lock:
            if not self._snapshot:
                meta = self._health.meta.model_copy(deep=True)
                meta.snapshot_age_seconds = self._snapshot_age(meta.generated_at)
                return TideSnapshot(meta=meta, date_str="", entries=[], days=[])
            snapshot = self._snapshot.model_copy(deep=True)
            snapshot.meta.snapshot_age_seconds = self._snapshot_age(snapshot.meta.generated_at)
            return snapshot

    def get_health(self) -> HealthResponse:
        with self._lock:
            health = self._health.model_copy(deep=True)
            health.meta.snapshot_age_seconds = self._snapshot_age(health.meta.generated_at)
            return health
