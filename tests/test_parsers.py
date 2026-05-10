from weather_dashboard.parsers import (
    parse_commentary,
    parse_fct_afs_do,
    parse_kma_buoy,
    parse_kma_lhaws2,
    parse_marine_json,
    parse_marine_xml,
    parse_sea_obs,
    parse_wrn_now_data,
)


def read_fixture(name: str) -> str:
    return (FIXTURE_DIR / name).read_text(encoding="utf-8")


FIXTURE_DIR = __import__("pathlib").Path(__file__).parent / "fixtures"


def test_parse_warnings():
    warnings = parse_wrn_now_data(read_fixture("wrn_now_data.txt"))
    assert len(warnings) == 2
    assert warnings[0].region_name == "전남북부서해앞바다"
    assert warnings[0].warning_type == "풍랑"


def test_parse_commentary():
    commentary = parse_commentary(read_fixture("commentary.txt"))
    assert commentary.station_id == "156"
    assert "안개" in commentary.body


def test_parse_observation_sources():
    sea_obs = parse_sea_obs(read_fixture("sea_obs.txt"))
    marine_json = parse_marine_json(read_fixture("marine_json.json"))
    marine_xml = parse_marine_xml(read_fixture("marine_xml.xml"))
    kma_lhaws2 = parse_kma_lhaws2(read_fixture("kma_lhaws2.txt"))
    kma_buoy = parse_kma_buoy(read_fixture("kma_buoy.txt"))

    assert sea_obs["530350"].source_name == "목포"
    assert marine_json["1079001"].visibility == "19.8"
    assert marine_xml["994403901"].observed_wind_dir == "NNE"
    assert kma_lhaws2["959"].gust == "13.8"
    assert kma_buoy["22183"].wave_height == "0.4"


def test_parse_forecast_lookup():
    region_map = {
        "12A30100": "서해남부앞바다",
        "12A30211": "서해남부북쪽안쪽먼바다",
    }
    lookup = parse_fct_afs_do(read_fixture("forecast_today.txt"), region_map)
    assert lookup["서해남부앞바다/오전"].wind_direction == "SW-W"
    assert lookup["서해남부북쪽안쪽먼바다/오후"].weather == "구름많음"
