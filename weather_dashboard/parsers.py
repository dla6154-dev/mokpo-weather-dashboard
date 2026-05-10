from __future__ import annotations

import csv
import io
import json
import xml.etree.ElementTree as ET
from typing import Iterable

from .models import Commentary, ForecastRecord, ObservationRecord, Query1Row, SpecialWarning


COMPASS_16 = [
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW",
]

QUERY1_OBSERVATION_TYPES = {
    "B": "B:BUOY",
    "C": "C:파고BUOY",
    "D": "D:표류BUOY",
    "L": "L:등표",
    "N": "N:조위관측소",
    "F": "F:연안방재",
    "G": "G:파랑계",
    "J": "J:기상1호",
}


QUERY1_MARINE_NAME_OVERRIDES = {
    "1079008": "외달도등표",
    "1079001": "안좌터미널",
    "1139001": "하조도등대",
}


def parse_buoy_station_info(text: str) -> dict[str, str]:
    station_lookup: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = stripped.split()
        if len(parts) < 9:
            continue
        station_lookup[safe_strip(parts[0])] = safe_strip(parts[6])
    return station_lookup


def safe_strip(value: object) -> str:
    return str(value or "").strip()


def normalize_metric(value: object, *, zero_as_dash: bool = False) -> str:
    text = safe_strip(value)
    if not text or text in {"-99", "-99.0", "미제공"}:
        return "-"
    if zero_as_dash:
        try:
            if float(text) == 0:
                return "-"
        except ValueError:
            pass
    return text


def format_obs_time(value: object) -> str:
    text = safe_strip(value)
    if len(text) >= 12:
        return text[-4:]
    if len(text) >= 6:
        return text[-4:]
    return text


def degrees_to_compass(value: object) -> str:
    text = normalize_metric(value)
    if text == "-":
        return "-"
    try:
        degrees = float(text)
    except ValueError:
        return text
    index = int((degrees % 360) / 22.5 + 0.5) % 16
    return COMPASS_16[index]


def normalize_query1_numeric(value: object, *, invalid_high: float | None = None) -> str:
    text = safe_strip(value)
    if not text:
        return ""
    try:
        number = float(text)
    except ValueError:
        return text
    if number < 0:
        return "-"
    if invalid_high is not None and number >= invalid_high:
        return "-"
    return text


def normalize_query1_visibility(value: object) -> str:
    text = safe_strip(value)
    if not text or text == "미제공":
        return ""
    try:
        if float(text) == 0:
            return ""
    except ValueError:
        return text
    return text


def csv_lines(text: str) -> Iterable[list[str]]:
    reader = csv.reader(io.StringIO(text))
    for row in reader:
        if not row:
            continue
        yield [safe_strip(cell).rstrip("=") for cell in row]


def parse_wrn_now_data(text: str) -> list[SpecialWarning]:
    warnings: list[SpecialWarning] = []
    for row in csv_lines("\n".join(line for line in text.splitlines() if line and not line.startswith("#"))):
        if len(row) < 10:
            continue
        warnings.append(
            SpecialWarning(
                parent_code=row[0],
                parent_name=row[1],
                region_code=row[2],
                region_name=row[3],
                issued_at=row[4],
                effective_at=row[5],
                warning_type=row[6],
                level=row[7],
                command=row[8],
                end_time_text=row[9],
            )
        )
    return warnings


def parse_commentary(text: str) -> Commentary:
    lines = text.replace("\r", "").splitlines()
    meta_line = ""
    body_lines: list[str] = []
    capture = False
    for line in lines:
        if line.startswith("$0#") and not meta_line:
            meta_line = line
            continue
        if line.startswith("$1#") and meta_line:
            capture = True
            first = line[3:]
            if first:
                body_lines.append(first)
            continue
        if capture:
            if line.strip() == "=":
                break
            body_lines.append(line)
    if not meta_line:
        return Commentary(body=text.strip())
    meta = meta_line.split("#")
    return Commentary(
        station_id=meta[1] if len(meta) > 1 else "",
        issued_at=meta[2] if len(meta) > 2 else "",
        forecaster=meta[6] if len(meta) > 6 else "",
        title=meta[9] if len(meta) > 9 else "",
        body="\n".join(body_lines).strip(),
    )


def parse_sea_obs(text: str) -> dict[str, ObservationRecord]:
    observations: dict[str, ObservationRecord] = {}
    data_lines = [line for line in text.splitlines() if line and not line.startswith("#")]
    for row in csv_lines("\n".join(data_lines)):
        if len(row) < 14:
            continue
        station_id = row[2]
        observations[station_id] = ObservationRecord(
            station_id=station_id,
            source_name=row[3],
            observed_at=format_obs_time(row[1]),
            observed_wind_dir=degrees_to_compass(row[7]),
            observed_wind_speed=normalize_metric(row[8], zero_as_dash=True),
            gust=normalize_metric(row[9], zero_as_dash=True),
            wave_height=normalize_metric(row[6], zero_as_dash=True),
            wave_height_max=normalize_metric(row[6], zero_as_dash=True),
            visibility="-",
            extras={"tp": row[0]},
        )
    return observations


def parse_kma_lhaws2(text: str) -> dict[str, ObservationRecord]:
    observations: dict[str, ObservationRecord] = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        parts = [part.strip().rstrip("=") for part in line.split(",")]
        if len(parts) < 16:
            continue
        station_id = parts[1]
        observations[station_id] = ObservationRecord(
            station_id=station_id,
            source_name=station_id,
            observed_at=format_obs_time(parts[0]),
            observed_wind_dir=degrees_to_compass(parts[2]),
            observed_wind_speed=normalize_metric(parts[3], zero_as_dash=True),
            gust=normalize_metric(parts[5], zero_as_dash=True),
            wave_height=normalize_metric(parts[15], zero_as_dash=True),
            wave_height_max=normalize_metric(parts[14], zero_as_dash=True),
            visibility="-",
        )
    return observations


def parse_kma_buoy(text: str) -> dict[str, ObservationRecord]:
    observations: dict[str, ObservationRecord] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = stripped.split()
        if len(parts) < 15:
            continue
        station_id = parts[1]
        observations[station_id] = ObservationRecord(
            station_id=station_id,
            source_name=station_id,
            observed_at=format_obs_time(parts[0]),
            observed_wind_dir=degrees_to_compass(parts[2]),
            observed_wind_speed=normalize_metric(parts[3], zero_as_dash=True),
            gust=normalize_metric(parts[4], zero_as_dash=True),
            wave_height=normalize_metric(parts[13], zero_as_dash=True),
            wave_height_max=normalize_metric(parts[12], zero_as_dash=True),
            visibility="-",
        )
    return observations


def parse_query1_marine_rows(text: str) -> list[Query1Row]:
    if not safe_strip(text):
        return []
    payload = json.loads(text)
    recordset = payload.get("result", {}).get("recordset", [])
    rows: list[Query1Row] = []
    for item in recordset:
        observed_at = safe_strip(item.get("DATETIME"))[:12]
        if len(observed_at) < 12:
            continue
        station_id = safe_strip(item.get("MMSI_CODE"))
        rows.append(
            Query1Row(
                year=observed_at[:4],
                month_day=observed_at[4:8],
                hhmm=observed_at[8:12],
                observation_type="등대/등표",
                station_id=station_id,
                station_name=QUERY1_MARINE_NAME_OVERRIDES.get(station_id, safe_strip(item.get("MMSI_NM"))),
                wind_direction=degrees_to_compass(item.get("WIND_DIRECT")),
                wind_speed=normalize_query1_numeric(item.get("WIND_SPEED")),
                gust="",
                wave_height="",
                wave_height_max="",
                visibility=normalize_query1_visibility(item.get("HORIZON_VISIBL")),
            )
        )
    return rows


def build_query1_max_wave_lookup(kma_buoy_text: str) -> dict[tuple[str, str, str, str], str]:
    max_wave_lookup: dict[tuple[str, str, str, str], str] = {}
    for line in kma_buoy_text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = stripped.split()
        if len(parts) < 15:
            continue
        observed_at = safe_strip(parts[0])
        if len(observed_at) < 12:
            continue
        key = (
            observed_at[:4],
            observed_at[4:8],
            observed_at[8:12],
            safe_strip(parts[1]),
        )
        max_wave_lookup[key] = normalize_query1_numeric(parts[12], invalid_high=999)
    return max_wave_lookup


def parse_query1_sea_obs_rows(
    sea_obs_text: str,
    max_wave_lookup: dict[tuple[str, str, str, str], str] | None = None,
) -> list[Query1Row]:
    max_wave_lookup = max_wave_lookup or {}
    rows: list[Query1Row] = []
    for row in csv_lines("\n".join(line for line in sea_obs_text.splitlines() if line and not line.startswith("#"))):
        if len(row) < 10:
            continue
        observed_at = safe_strip(row[1])[:12]
        if len(observed_at) < 12:
            continue
        year = observed_at[:4]
        month_day = observed_at[4:8]
        hhmm = observed_at[8:12]
        station_id = safe_strip(row[2])
        rows.append(
            Query1Row(
                year=year,
                month_day=month_day,
                hhmm=hhmm,
                observation_type=QUERY1_OBSERVATION_TYPES.get(safe_strip(row[0]), safe_strip(row[0])),
                station_id=station_id,
                station_name=safe_strip(row[3]),
                wind_direction=degrees_to_compass(row[7]),
                wind_speed=normalize_query1_numeric(row[8]),
                gust=normalize_query1_numeric(row[9]),
                wave_height=normalize_query1_numeric(row[6]),
                wave_height_max=max_wave_lookup.get((year, month_day, hhmm, station_id), ""),
                visibility="",
            )
        )
    return rows


def parse_query1_kma_buoy_latest_rows(
    kma_buoy_text: str,
    station_lookup: dict[str, tuple[str, str]] | None = None,
    buoy_station_name_lookup: dict[str, str] | None = None,
) -> list[Query1Row]:
    station_lookup = station_lookup or {}
    buoy_station_name_lookup = buoy_station_name_lookup or {}
    latest_by_station: dict[str, Query1Row] = {}
    latest_at_by_station: dict[str, str] = {}

    for line in kma_buoy_text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = stripped.split()
        if len(parts) < 15:
            continue
        observed_at = safe_strip(parts[0])
        if len(observed_at) < 12:
            continue
        station_id = safe_strip(parts[1])
        previous_at = latest_at_by_station.get(station_id)
        if previous_at and observed_at <= previous_at:
            continue
        mapped_type, mapped_name = station_lookup.get(station_id, ("B:BUOY", ""))
        station_name = mapped_name or buoy_station_name_lookup.get(station_id, station_id)
        latest_at_by_station[station_id] = observed_at
        latest_by_station[station_id] = Query1Row(
            year=observed_at[:4],
            month_day=observed_at[4:8],
            hhmm=observed_at[8:12],
            observation_type=mapped_type or "B:BUOY",
            station_id=station_id,
            station_name=station_name,
            wind_direction=degrees_to_compass(parts[2]),
            wind_speed=normalize_query1_numeric(parts[3]),
            gust=normalize_query1_numeric(parts[4]),
            wave_height=normalize_query1_numeric(parts[13]),
            wave_height_max=normalize_query1_numeric(parts[12], invalid_high=999),
            visibility="",
        )
    return list(latest_by_station.values())


def merge_query1_rows(
    base_rows: list[Query1Row],
    override_rows: list[Query1Row],
) -> list[Query1Row]:
    override_lookup = {row.station_id: row for row in override_rows}
    merged_rows: list[Query1Row] = []
    seen_station_ids: set[str] = set()

    for row in base_rows:
        replacement = override_lookup.get(row.station_id)
        merged_rows.append(replacement or row)
        seen_station_ids.add(row.station_id)

    for row in override_rows:
        if row.station_id not in seen_station_ids:
            merged_rows.append(row)

    return merged_rows


def parse_query1_rows(
    sea_obs_text: str,
    kma_buoy_text: str,
    marine_json_text: str = "",
    marine_hajo_text: str = "",
    buoy_station_info_text: str = "",
) -> list[Query1Row]:
    max_wave_lookup = build_query1_max_wave_lookup(kma_buoy_text)
    sea_rows = parse_query1_sea_obs_rows(sea_obs_text, max_wave_lookup)
    station_lookup = {
        row.station_id: (row.observation_type, row.station_name)
        for row in sea_rows
        if row.station_id
    }
    buoy_station_name_lookup = parse_buoy_station_info(buoy_station_info_text) if safe_strip(buoy_station_info_text) else {}
    kma_rows = parse_query1_kma_buoy_latest_rows(
        kma_buoy_text,
        station_lookup=station_lookup,
        buoy_station_name_lookup=buoy_station_name_lookup,
    )
    rows = merge_query1_rows(sea_rows, kma_rows)
    rows.extend(parse_query1_marine_rows(marine_json_text))
    rows.extend(parse_query1_marine_rows(marine_hajo_text))
    return rows


def parse_fct_afs_do(text: str, region_map: dict[str, str]) -> dict[str, ForecastRecord]:
    lookup: dict[str, ForecastRecord] = {}
    for row in csv_lines("\n".join(line for line in text.splitlines() if line and not line.startswith("#"))):
        if len(row) < 19:
            continue
        region_code = row[0]
        region_name = region_map.get(region_code, region_code)
        tm_ef = row[2]
        slot = "오전" if tm_ef.endswith("0000") else "오후" if tm_ef.endswith("1200") else ""
        if not slot:
            continue
        record = ForecastRecord(
            region_code=region_code,
            region_name=region_name,
            slot=slot,
            wind_direction=f"{row[9]}-{row[11]}",
            wind_speed=f"{row[12]}-{row[13]}",
            wave_height=f"{row[14]}-{row[15]}",
            weather=row[18],
        )
        lookup[f"{region_name}/{slot}"] = record
    return lookup


def parse_marine_json(text: str) -> dict[str, ObservationRecord]:
    payload = json.loads(text)
    recordset = payload.get("result", {}).get("recordset", [])
    observations: dict[str, ObservationRecord] = {}
    for item in recordset:
        station_id = safe_strip(item.get("MMSI_CODE"))
        observations[station_id] = ObservationRecord(
            station_id=station_id,
            source_name=safe_strip(item.get("MMSI_NM")),
            observed_at=format_obs_time(item.get("DATETIME")),
            observed_wind_dir=degrees_to_compass(item.get("WIND_DIRECT")),
            observed_wind_speed=normalize_metric(item.get("WIND_SPEED"), zero_as_dash=True),
            gust="-",
            wave_height=normalize_metric(item.get("WAVE_HEIGTH"), zero_as_dash=True),
            wave_height_max="-",
            visibility=normalize_metric(item.get("HORIZON_VISIBL")),
        )
    return observations


def parse_marine_xml(text: str) -> dict[str, ObservationRecord]:
    root = ET.fromstring(text)
    observations: dict[str, ObservationRecord] = {}
    for record in root.findall("./recordset/record"):
        station_id = safe_strip(record.findtext("MMSI_CODE"))
        observations[station_id] = ObservationRecord(
            station_id=station_id,
            source_name=safe_strip(record.findtext("MMSI_NM")),
            observed_at=format_obs_time(record.findtext("DATETIME")),
            observed_wind_dir=degrees_to_compass(record.findtext("WIND_DIRECT")),
            observed_wind_speed=normalize_metric(record.findtext("WIND_SPEED"), zero_as_dash=True),
            gust="-",
            wave_height="-",
            wave_height_max="-",
            visibility="-",
        )
    return observations
