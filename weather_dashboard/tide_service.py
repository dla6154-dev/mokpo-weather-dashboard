from __future__ import annotations

import asyncio
import json
import threading
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo

from .clients import WeatherApiClient
from .config import AppSettings
from .models import HealthResponse, SnapshotMeta, SourceStatus, TideEntry, TideSnapshot
from .service import RefreshError

TIDE_STATIONS = [
    ("DT_0007", "목포"),
    ("SO_0631", "암태"),
    ("SO_0565", "향화"),
    ("SO_1248", "옥도"),
    ("SO_0555", "서망"),
    ("SO_1264", "계마"),
]

TIDE_STATIONS = [
    ("SO_0555", "서망"),
    ("SO_0702", "진도옥도"),
    ("SO_0567", "쉬미"),
    ("DT_0094", "서거차도"),
]

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

    def build(
        self,
        now: datetime | None = None,
        previous_snapshot: TideSnapshot | None = None,
    ) -> TideBuildResult:
        current = now or self.client.now()
        if not self.settings.tide_service_key:
            raise RefreshError("Missing environment variables: TIDE_SERVICE_KEY")

        req_date = current.strftime("%Y%m%d")
        statuses: list[SourceStatus] = []
        entries: list[TideEntry] = []
        fallback_used: list[str] = []

        previous_entries_by_station: dict[str, list[TideEntry]] = {}
        if previous_snapshot:
            for entry in previous_snapshot.entries:
                previous_entries_by_station.setdefault(entry.station_name, []).append(entry)

        for obs_code, station_name in TIDE_STATIONS:
            started = datetime.now(self.tz)
            try:
                data = self.client.fetch_tide(obs_code, req_date)
                items = data.get("body", {}).get("items", {}).get("item", [])
                statuses.append(
                    SourceStatus(
                        name=f"tide_{obs_code}",
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
                    entries.append(
                        TideEntry(
                            station_name=station_name,
                            tide_type=tide_type,
                            time_str=time_str,
                            level_cm=level_cm,
                        )
                    )
            except Exception as exc:
                fallback_entries = previous_entries_by_station.get(station_name, [])
                if fallback_entries:
                    entries.extend(fallback_entries)
                    fallback_used.append(station_name)
                statuses.append(
                    SourceStatus(
                        name=f"tide_{obs_code}",
                        ok=False,
                        fetched_at=started,
                        record_count=len(fallback_entries) if fallback_entries else None,
                        error=str(exc),
                    )
                )

        ok_count = sum(1 for status in statuses if status.ok)
        if ok_count == 0 and not fallback_used:
            errors = "; ".join(
                f"{status.name}: {status.error}" for status in statuses if status.error
            ) or "No tide sources succeeded."
            raise RefreshError(f"All tide sources failed: {errors}")
        if not entries:
            raise RefreshError("Tide API returned no entries.")

        stale = bool(fallback_used)
        stale_reason = (
            f"일부 지점 이전값 유지: {', '.join(fallback_used)}"
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
            date_str=current.strftime("%Y년 %m월 %d일"),
            entries=entries,
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
                return TideSnapshot(meta=meta, date_str="", entries=[])
            snapshot = self._snapshot.model_copy(deep=True)
            snapshot.meta.snapshot_age_seconds = self._snapshot_age(snapshot.meta.generated_at)
            return snapshot

    def get_health(self) -> HealthResponse:
        with self._lock:
            health = self._health.model_copy(deep=True)
            health.meta.snapshot_age_seconds = self._snapshot_age(health.meta.generated_at)
            return health
