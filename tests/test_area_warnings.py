import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from weather_dashboard.config import AppSettings, RuntimeConfig
from weather_dashboard.service import AreaWarningBuilder


FIXTURE_DIR = Path(__file__).parent / "fixtures"
BASE_DIR = Path(__file__).resolve().parents[1]
CONFIG_DIR = BASE_DIR / "weather_dashboard" / "config"
AREA_WARNING_PATH = BASE_DIR / "예보 구역.txt"


def read_fixture(name: str) -> str:
    return (FIXTURE_DIR / name).read_text(encoding="utf-8")


def read_area_warning_regions() -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    for raw_line in AREA_WARNING_PATH.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        area_code, area_name = line.split("\t", 1)
        entries.append({"area_code": area_code, "area_name": area_name})
    return entries


class FixtureClient:
    def __init__(self) -> None:
        self._now = datetime(2026, 5, 4, 13, 0, tzinfo=ZoneInfo("Asia/Seoul"))

    def fetch_wrn_now_data_at(self, tm: str) -> str:
        return read_fixture("wrn_now_data.txt")

    def fetch_warning_map(self, now: datetime) -> bytes:
        return b"PNGDATA"

    def now(self) -> datetime:
        return self._now


def make_settings() -> AppSettings:
    state_dir = BASE_DIR / "tests" / ".state"
    cache_dir = BASE_DIR / "tests" / ".cache"
    state_dir.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)
    return AppSettings(
        base_dir=BASE_DIR,
        template_dir=BASE_DIR / "weather_dashboard" / "templates",
        static_dir=BASE_DIR / "weather_dashboard" / "static",
        config_dir=CONFIG_DIR,
        state_dir=state_dir,
        cache_dir=cache_dir,
        refresh_interval_seconds=300,
        client_refresh_interval_seconds=30,
        request_timeout_seconds=30,
        timezone_name="Asia/Seoul",
        kma_auth_key="dummy",
        kma_pub_auth_key="dummy",
        marine_service_key_json="",
        marine_service_key_xml="",
        commentary_station_id="156",
        warning_rows=json.loads((CONFIG_DIR / "dashboard_rows.json").read_text(encoding="utf-8")),
        forecast_regions=json.loads((CONFIG_DIR / "forecast_regions.json").read_text(encoding="utf-8")),
        station_aliases=json.loads((CONFIG_DIR / "station_aliases.json").read_text(encoding="utf-8")),
        query1_default_selection=[],
        area_warning_regions=read_area_warning_regions(),
        area_warning_default_selection=[],
        tide_service_key="",
        runtime_config=RuntimeConfig(state_dir / "runtime_settings.json"),
    )


def test_area_warning_builder_creates_area_snapshot():
    builder = AreaWarningBuilder(make_settings(), FixtureClient())
    result = builder.build(datetime(2026, 5, 4, 13, 0, tzinfo=ZoneInfo("Asia/Seoul")))

    assert result.snapshot.meta.stale is False
    assert result.snapshot.warning_map_url == "/api/area-warnings/warning-map.png"
    assert result.warning_map_bytes == b"PNGDATA"
    assert len(result.snapshot.entries) == len(read_area_warning_regions())
    assert len({entry.selection_key for entry in result.snapshot.entries}) == len(result.snapshot.entries)
    assert result.snapshot.entries[0].area_code == "12A10100"
    assert result.snapshot.entries[0].area_label == "서해북부앞바다"
    assert any(not entry.warnings for entry in result.snapshot.entries)
    assert any(source.name == "wrn_now_data" and source.ok for source in result.statuses)
