import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from weather_dashboard.config import AppSettings, RuntimeConfig
from weather_dashboard.service import RefreshError
from weather_dashboard.tide_service import TideBuilder


BASE_DIR = Path(__file__).resolve().parents[1]
CONFIG_DIR = BASE_DIR / "weather_dashboard" / "config"


class FixtureClient:
    def __init__(self) -> None:
        self._now = datetime(2026, 5, 6, 0, 3, tzinfo=ZoneInfo("Asia/Seoul"))

    def fetch_tide(self, obs_code: str, req_date: str) -> dict:
        pretty_date = f"{req_date[:4]}-{req_date[4:6]}-{req_date[6:8]}"
        return {
            "body": {
                "items": {
                    "item": [
                        {"predcDt": f"{pretty_date} 04:48", "extrSe": "1", "predcTdlvVl": "420"},
                        {"predcDt": f"{pretty_date} 10:02", "extrSe": "2", "predcTdlvVl": "109"},
                        {"predcDt": f"{pretty_date} 16:33", "extrSe": "3", "predcTdlvVl": "337"},
                        {"predcDt": f"{pretty_date} 21:48", "extrSe": "4", "predcTdlvVl": "46"},
                    ]
                }
            }
        }

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
        kma_auth_key="",
        kma_pub_auth_key="",
        marine_service_key_json="",
        marine_service_key_xml="",
        commentary_station_id="156",
        warning_rows=json.loads((CONFIG_DIR / "dashboard_rows.json").read_text(encoding="utf-8")),
        forecast_regions=json.loads((CONFIG_DIR / "forecast_regions.json").read_text(encoding="utf-8")),
        station_aliases=json.loads((CONFIG_DIR / "station_aliases.json").read_text(encoding="utf-8")),
        query1_default_selection=[],
        area_warning_regions=[],
        area_warning_default_selection=[],
        tide_service_key="dummy",
        runtime_config=RuntimeConfig(state_dir / "runtime_settings.json"),
    )


def test_tide_builder_creates_four_points_for_each_station():
    builder = TideBuilder(make_settings(), FixtureClient())
    result = builder.build(datetime(2026, 5, 6, 0, 3, tzinfo=ZoneInfo("Asia/Seoul")))

    assert result.snapshot.meta.stale is False
    assert result.snapshot.date_str == "2026년 05월 06일"
    assert len(result.snapshot.entries) == 24
    assert result.snapshot.entries[0].station_name == "목포"
    assert result.snapshot.entries[0].tide_type == "고조"
    assert result.snapshot.entries[0].time_str == "04:48"
    assert result.snapshot.entries[0].level_cm == 420.0
    assert result.snapshot.entries[1].tide_type == "저조"
    assert result.snapshot.entries[-1].station_name == "계마"
    assert sum(1 for entry in result.snapshot.entries if entry.station_name == "목포") == 4
    assert len(result.statuses) == 6
    assert all(source.ok for source in result.statuses)


class FailingClient(FixtureClient):
    def fetch_tide(self, obs_code: str, req_date: str) -> dict:
        raise RuntimeError("dns resolution failed")


def test_tide_builder_raises_when_all_sources_fail():
    builder = TideBuilder(make_settings(), FailingClient())

    try:
        builder.build(datetime(2026, 5, 6, 0, 3, tzinfo=ZoneInfo("Asia/Seoul")))
    except RefreshError as exc:
        assert "All tide sources failed" in str(exc)
    else:
        raise AssertionError("Expected RefreshError when all tide sources fail.")
