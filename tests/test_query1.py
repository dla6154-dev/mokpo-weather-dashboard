import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from weather_dashboard.config import AppSettings, RuntimeConfig
from weather_dashboard.parsers import parse_query1_marine_rows, parse_query1_rows
from weather_dashboard.service import Query1Builder


FIXTURE_DIR = Path(__file__).parent / "fixtures"
BASE_DIR = Path(__file__).resolve().parents[1]
CONFIG_DIR = BASE_DIR / "weather_dashboard" / "config"


def read_fixture(name: str) -> str:
    return (FIXTURE_DIR / name).read_text(encoding="utf-8")


class FixtureClient:
    def __init__(self) -> None:
        self._now = datetime(2026, 5, 4, 13, 0, tzinfo=ZoneInfo("Asia/Seoul"))

    def fetch_sea_obs(self) -> str:
        return read_fixture("sea_obs.txt")

    def fetch_sea_obs_at(self, tm: str, stn: str = "0") -> str:
        return read_fixture("sea_obs.txt")

    def fetch_kma_buoy(self) -> str:
        return read_fixture("kma_buoy.txt")

    def fetch_kma_buoy_at(self, tm: str, stn: str = "0") -> str:
        return read_fixture("kma_buoy.txt")

    def fetch_marine_json(self) -> str:
        return read_fixture("marine_json.json")

    def fetch_marine_hajo(self) -> str:
        return read_fixture("marine_hajo.json")

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
        kma_pub_auth_key="dummy",
        marine_service_key_json="dummy",
        marine_service_key_xml="",
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


def test_parse_query1_rows_merges_max_wave_height():
    rows = parse_query1_rows(read_fixture("sea_obs.txt"), read_fixture("kma_buoy.txt"))

    assert len(rows) == 9
    assert rows[0].observation_type == "B:BUOY"
    assert rows[0].station_id == "22102"
    assert rows[0].wind_direction == "WNW"
    assert rows[0].wave_height == "1.4"
    assert rows[0].wave_height_max == ""

    assert rows[1].station_id == "22183"
    assert rows[1].wave_height_max == "0.7"

    assert rows[5].observation_type == "N:조위관측소"
    assert rows[5].wave_height == "-"
    assert rows[5].visibility == ""


def test_parse_query1_rows_joins_max_wave_on_matching_time_and_station():
    sea_obs_text = "B, 202605041210,    22183, test, 0, 0,   0.5, 313,   5.9,   6.8,  13.5,  14.6, 1016.7,  68.0, ,=\n"
    kma_buoy_text = "202605041210 22183 301   6.8   7.6 296   6.6   7.4 1016.7  65.0  14.8  13.9   0.7   0.4   0.3   4.2 349\n"

    rows = parse_query1_rows(sea_obs_text, kma_buoy_text)

    assert len(rows) == 1
    assert rows[0].wave_height_max == "0.7"


def test_parse_query1_marine_rows_matches_excel_shape():
    rows = parse_query1_marine_rows(read_fixture("marine_json.json"))

    assert len(rows) == 2
    assert rows[0].year == "2026"
    assert rows[0].month_day == "0504"
    assert rows[0].hhmm == "1320"
    assert rows[0].observation_type == "등대/등표"
    assert rows[0].station_id == "1079008"
    assert rows[0].station_name == "외달도등표"
    assert rows[0].wind_direction == "NNW"
    assert rows[0].wind_speed == "9.77"
    assert rows[0].wave_height == ""
    assert rows[0].wave_height_max == ""
    assert rows[0].visibility == ""

    assert rows[1].station_id == "1079001"
    assert rows[1].station_name == "안좌터미널"
    assert rows[1].visibility == "19.8"


def test_parse_query1_rows_appends_marine_rows():
    rows = parse_query1_rows(
        read_fixture("sea_obs.txt"),
        read_fixture("kma_buoy.txt"),
        read_fixture("marine_json.json"),
        read_fixture("marine_hajo.json"),
    )

    assert len(rows) == 12
    marine_ids = {row.station_id for row in rows[-3:]}
    assert marine_ids == {"1079008", "1079001", "1139001"}
    assert rows[-1].station_name == "하조도등대"


def test_query1_builder_creates_snapshot():
    builder = Query1Builder(make_settings(), FixtureClient())
    result = builder.build(datetime(2026, 5, 4, 13, 0, tzinfo=ZoneInfo("Asia/Seoul")))

    assert result.snapshot.meta.stale is False
    assert len(result.snapshot.rows) == 12
    assert result.snapshot.rows[1].station_id == "22183"
    assert result.snapshot.rows[1].wave_height_max == "0.7"
    assert any(source.name == "sea_obs" and source.ok for source in result.statuses)
    assert any(source.name == "kma_buoy" and source.ok for source in result.statuses)
    assert any(source.name == "marine_json" and source.ok for source in result.statuses)
    assert any(source.name == "marine_hajo" and source.ok for source in result.statuses)
