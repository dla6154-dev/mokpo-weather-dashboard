import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from weather_dashboard.config import AppSettings, RuntimeConfig
from weather_dashboard.service import DashboardBuilder


FIXTURE_DIR = Path(__file__).parent / "fixtures"
BASE_DIR = Path(__file__).resolve().parents[1]
CONFIG_DIR = BASE_DIR / "weather_dashboard" / "config"


def read_fixture(name: str) -> str:
    return (FIXTURE_DIR / name).read_text(encoding="utf-8")


class FixtureClient:
    def __init__(self) -> None:
        self._now = datetime(2026, 5, 4, 13, 0, tzinfo=ZoneInfo("Asia/Seoul"))

    def fetch_wrn_now_data(self) -> str:
        return read_fixture("wrn_now_data.txt")

    def fetch_commentary(self) -> str:
        return read_fixture("commentary.txt")

    def fetch_sea_obs(self) -> str:
        return read_fixture("sea_obs.txt")

    def fetch_kma_lhaws2(self) -> str:
        return read_fixture("kma_lhaws2.txt")

    def fetch_kma_buoy(self) -> str:
        return read_fixture("kma_buoy.txt")

    def fetch_forecast_today(self, now: datetime) -> str:
        return read_fixture("forecast_today.txt")

    def fetch_forecast_fallback(self, now: datetime) -> str:
        return read_fixture("forecast_fallback.txt")

    def fetch_marine_json(self) -> str:
        return read_fixture("marine_json.json")

    def fetch_marine_xml(self) -> str:
        return read_fixture("marine_xml.xml")

    def fetch_marine_hajo(self) -> str:
        return read_fixture("marine_hajo.json")

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
        marine_service_key_json="dummy",
        marine_service_key_xml="dummy",
        commentary_station_id="156",
        warning_rows=json.loads((CONFIG_DIR / "dashboard_rows.json").read_text(encoding="utf-8")),
        forecast_regions=json.loads((CONFIG_DIR / "forecast_regions.json").read_text(encoding="utf-8")),
        station_aliases=json.loads((CONFIG_DIR / "station_aliases.json").read_text(encoding="utf-8")),
        query1_default_selection=[],
        area_warning_regions=[],
        area_warning_default_selection=[],
        tide_service_key="",
        runtime_config=RuntimeConfig(state_dir / "runtime_settings.json"),
    )


def test_builder_creates_dashboard_snapshot():
    builder = DashboardBuilder(make_settings(), FixtureClient())
    result = builder.build(datetime(2026, 5, 4, 13, 0, tzinfo=ZoneInfo("Asia/Seoul")))

    assert result.snapshot.rows[0].forecast_wind_direction == "SW-W"
    assert result.snapshot.rows[1].visibility == "19.8"
    assert result.snapshot.rows[8].observed_wind_dir == "ESE"
    assert result.snapshot.rows[10].forecast_weather == "맑음"
    assert result.snapshot.rows[0].special_warnings[0].region_name == "전남북부서해앞바다"
    assert result.snapshot.commentary.station_id == "156"
    assert any(source.name == "kma_buoy" and source.ok for source in result.statuses)
    assert result.warning_map_bytes == b"PNGDATA"
