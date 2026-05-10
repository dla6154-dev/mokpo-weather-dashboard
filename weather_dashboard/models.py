from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


def _to_camel(name: str) -> str:
    parts = name.split("_")
    return parts[0] + "".join(part.capitalize() for part in parts[1:])


class DashboardModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        populate_by_name=True,
        extra="ignore",
    )


class SourceStatus(DashboardModel):
    name: str
    ok: bool
    fetched_at: datetime | None = None
    record_count: int | None = None
    error: str | None = None


class SpecialWarning(DashboardModel):
    parent_code: str | None = None
    parent_name: str | None = None
    region_code: str
    region_name: str
    issued_at: str
    effective_at: str
    warning_type: str
    level: str
    command: str
    end_time_text: str


class Commentary(DashboardModel):
    station_id: str = ""
    issued_at: str = ""
    forecaster: str = ""
    title: str = ""
    body: str = ""


class AreaRow(DashboardModel):
    area_name: str = ""
    warning_region: str = ""
    display_group: str = ""
    display_subgroup: str = ""
    time_slot: str = ""
    forecast_slot: str = ""
    forecast_wind_direction: str = ""
    forecast_wind_speed: str = ""
    forecast_wave_height: str = ""
    forecast_weather: str = ""
    show_forecast: bool = True
    source_name: str = ""
    station_id: str = ""
    observed_at: str = ""
    observed_wind_dir: str = ""
    observed_wind_speed: str = ""
    gust: str = ""
    wave_height: str = ""
    wave_height_max: str = ""
    visibility: str = ""
    special_warnings: list[SpecialWarning] = Field(default_factory=list)


class SnapshotMeta(DashboardModel):
    generated_at: datetime | None = None
    last_success_at: datetime | None = None
    stale: bool = False
    stale_reason: str = ""
    refresh_interval_seconds: int = 300
    client_refresh_interval_seconds: int = 30
    snapshot_age_seconds: int | None = None
    missing_env_vars: list[str] = Field(default_factory=list)


class DashboardSnapshot(DashboardModel):
    meta: SnapshotMeta
    warning_map_url: str = ""
    warnings: list[SpecialWarning] = Field(default_factory=list)
    commentary: Commentary = Field(default_factory=Commentary)
    rows: list[AreaRow] = Field(default_factory=list)


class Query1Row(DashboardModel):
    year: str = ""
    month_day: str = ""
    hhmm: str = ""
    observation_type: str = ""
    station_id: str = ""
    station_name: str = ""
    wind_direction: str = ""
    wind_speed: str = ""
    gust: str = ""
    wave_height: str = ""
    wave_height_max: str = ""
    visibility: str = ""


class Query1Snapshot(DashboardModel):
    meta: SnapshotMeta
    rows: list[Query1Row] = Field(default_factory=list)


class Query1SelectionPreference(DashboardModel):
    selected_keys: list[str] = Field(default_factory=list)


class AreaWarningEntry(DashboardModel):
    selection_key: str = ""
    area_code: str = ""
    area_name: str = ""
    display_group: str = ""
    display_subgroup: str = ""
    area_label: str = ""
    warning_region: str = ""
    source_name: str = ""
    warnings: list[SpecialWarning] = Field(default_factory=list)


class AreaWarningSnapshot(DashboardModel):
    meta: SnapshotMeta
    warning_map_url: str = ""
    entries: list[AreaWarningEntry] = Field(default_factory=list)


class HealthResponse(DashboardModel):
    meta: SnapshotMeta
    sources: list[SourceStatus] = Field(default_factory=list)


class ObservationRecord(DashboardModel):
    station_id: str
    source_name: str
    observed_at: str = ""
    observed_wind_dir: str = ""
    observed_wind_speed: str = ""
    gust: str = ""
    wave_height: str = ""
    wave_height_max: str = ""
    visibility: str = ""
    extras: dict[str, Any] = Field(default_factory=dict)


class ForecastRecord(DashboardModel):
    region_code: str
    region_name: str
    slot: str
    wind_direction: str
    wind_speed: str
    wave_height: str
    weather: str


class TideEntry(DashboardModel):
    station_name: str = ""
    tide_type: str = ""
    time_str: str = ""
    level_cm: float | None = None


class TideSnapshot(DashboardModel):
    meta: SnapshotMeta
    date_str: str = ""
    entries: list[TideEntry] = Field(default_factory=list)
