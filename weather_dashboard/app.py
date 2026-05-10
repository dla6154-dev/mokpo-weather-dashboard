from __future__ import annotations

import asyncio
from collections import Counter
import json
from contextlib import asynccontextmanager
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .clients import WeatherApiClient
from .config import AppSettings, load_settings
from .models import Query1Row, Query1SelectionPreference
from .parsers import degrees_to_compass, normalize_query1_numeric, parse_query1_rows
from .service import AreaWarningBuilder, AreaWarningService, DashboardService, Query1Service
from .tide_service import TideService


def _mask_auth_key(url: str, auth_key: str) -> str:
    if not auth_key:
        return url
    return url.replace(auth_key, "****")


def _parse_buoy_station_info(text: str) -> dict[str, dict[str, str]]:
    stations: dict[str, dict[str, str]] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = stripped.split()
        if len(parts) < 9:
            continue
        station_id = parts[0].strip()
        stations[station_id] = {
            "station_name": parts[6].strip(),
            "station_name_en": parts[7].strip(),
            "forecast_id": parts[8].strip(),
        }
    return stations


def _query1_row_to_compare_dict(row: Query1Row, source: str) -> dict[str, str]:
    return {
        "station_id": row.station_id,
        "observation_type": row.observation_type,
        "station_name": row.station_name,
        "observed_at": f"{row.year}{row.month_day}{row.hhmm}",
        "observed_hhmm": row.hhmm,
        "wind_direction": row.wind_direction,
        "wind_speed": row.wind_speed,
        "gust": row.gust,
        "wave_height": row.wave_height,
        "wave_height_max": row.wave_height_max,
        "source": source,
    }


def _parse_compact_tm(value: str | None, timezone_name: str) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.strptime(text, "%Y%m%d%H%M")
    except ValueError:
        return None
    return parsed.replace(tzinfo=ZoneInfo(timezone_name))


def _build_kma_buoy_compare_context(
    client: WeatherApiClient,
    query1_rows: list[Query1Row],
    tm: str | None = None,
) -> dict:
    current = client.now()
    request_tm = tm or current.strftime("%Y%m%d%H%M")
    request_url = client.build_kma_buoy_url(tm=request_tm)
    sea_obs_text = client.fetch_sea_obs()
    text = client.fetch_kma_buoy_at(request_tm)
    query1_station_lookup: dict[str, dict[str, str]] = {}
    for row in query1_rows:
        station_id = row.station_id.strip()
        if not station_id or station_id in query1_station_lookup:
            continue
        query1_station_lookup[station_id] = {
            "observation_type": row.observation_type,
            "station_name": row.station_name,
        }
    buoy_station_info = _parse_buoy_station_info(client.fetch_station_info("BUOY"))
    sea_obs_rows = [
        _query1_row_to_compare_dict(row, "sea_obs.php")
        for row in parse_query1_rows(sea_obs_text, "")
    ]

    raw_rows: list[dict[str, str]] = []
    latest_by_stn: dict[str, dict[str, str]] = {}
    raw_time_counter: Counter[str] = Counter()

    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = stripped.split()
        if len(parts) < 15:
            continue
        observed_at = parts[0].strip()
        station_id = parts[1].strip()
        entry = {
            "observed_at": observed_at,
            "observed_hhmm": observed_at[8:12] if len(observed_at) >= 12 else observed_at,
            "station_id": station_id,
            "wind_direction": degrees_to_compass(parts[2]),
            "wind_speed": normalize_query1_numeric(parts[3]),
            "gust": normalize_query1_numeric(parts[4]),
            "wave_height_max": normalize_query1_numeric(parts[12], invalid_high=999),
            "wave_height": normalize_query1_numeric(parts[13]),
            "source": "kma_buoy.php",
        }
        raw_rows.append(entry)
        raw_time_counter[entry["observed_hhmm"]] += 1
        existing = latest_by_stn.get(station_id)
        if existing is None or entry["observed_at"] > existing["observed_at"]:
            latest_by_stn[station_id] = entry

    latest_rows = sorted(
        latest_by_stn.values(),
        key=lambda item: (item["observed_at"], item["station_id"]),
        reverse=True,
    )
    for row in latest_rows:
        mapping = query1_station_lookup.get(row["station_id"], {})
        fallback_mapping = buoy_station_info.get(row["station_id"], {})
        row["observation_type"] = mapping.get("observation_type", "B:BUOY")
        row["station_name"] = mapping.get("station_name") or fallback_mapping.get("station_name", "-")
    latest_time_counter = Counter(item["observed_hhmm"] for item in latest_rows)
    latest_hhmm = latest_rows[0]["observed_hhmm"] if latest_rows else ""

    time_distribution = [
        {"hhmm": hhmm, "raw_count": raw_time_counter[hhmm], "latest_count": latest_time_counter.get(hhmm, 0)}
        for hhmm, _ in sorted(raw_time_counter.items(), reverse=True)
    ]
    lagging_rows = [item for item in latest_rows if item["observed_hhmm"] != latest_hhmm]

    kma_latest_by_stn = {row["station_id"]: row for row in latest_rows}
    combined_rows: list[dict[str, str]] = []
    duplicate_station_ids: list[str] = []
    seen_station_ids: set[str] = set()

    for sea_row in sea_obs_rows:
        station_id = sea_row["station_id"]
        replacement = kma_latest_by_stn.get(station_id)
        if replacement:
            combined_rows.append(replacement)
            duplicate_station_ids.append(station_id)
        else:
            combined_rows.append(sea_row)
        seen_station_ids.add(station_id)

    for station_id, row in kma_latest_by_stn.items():
        if station_id not in seen_station_ids:
            combined_rows.append(row)

    combined_rows.sort(
        key=lambda item: (
            item.get("observation_type", ""),
            item.get("station_name", ""),
            item.get("station_id", ""),
        )
    )

    combined_source_counter = Counter(row["source"] for row in combined_rows)
    sea_obs_latest_hhmm = max((row["observed_hhmm"] for row in sea_obs_rows), default="")

    python_code = "\n".join(
        [
            "tm = now.strftime('%Y%m%d%H%M')",
            "kma_text = client.fetch_kma_buoy_at(tm)",
            "sea_text = client.fetch_sea_obs()",
            "",
            "latest_by_stn = {}",
            "for line in kma_text.splitlines():",
            "    parts = line.split()",
            "    if len(parts) < 15 or line.startswith('#'):",
            "        continue",
            "    observed_at = parts[0]",
            "    stn = parts[1]",
            "    row = parts",
            "    if stn not in latest_by_stn or observed_at > latest_by_stn[stn][0]:",
            "        latest_by_stn[stn] = (observed_at, row)",
            "",
            "sea_rows = parse_query1_rows(sea_text, '')",
            "final_rows = []",
            "for row in sea_rows:",
            "    if row.station_id in latest_by_stn:",
            "        final_rows.append(latest_by_stn[row.station_id][1])",
            "    else:",
            "        final_rows.append(row)",
        ]
    )

    return {
        "requested_at": current.strftime("%Y-%m-%d %H:%M:%S"),
        "request_tm": request_tm,
        "request_url": _mask_auth_key(request_url, client.settings.kma_pub_auth_key),
        "sea_obs_latest_hhmm": sea_obs_latest_hhmm,
        "sea_obs_row_count": len(sea_obs_rows),
        "raw_row_count": len(raw_rows),
        "unique_station_count": len(latest_rows),
        "latest_row_count": len(latest_rows),
        "latest_hhmm": latest_hhmm,
        "time_distribution": time_distribution,
        "latest_rows": latest_rows,
        "lagging_rows": lagging_rows[:12],
        "combined_rows": combined_rows,
        "duplicate_station_count": len(set(duplicate_station_ids)),
        "combined_row_count": len(combined_rows),
        "combined_kma_count": combined_source_counter.get("kma_buoy.php", 0),
        "combined_sea_count": combined_source_counter.get("sea_obs.php", 0),
        "python_code": python_code,
    }


def create_app(
    service: DashboardService | None = None,
    query1_service: Query1Service | None = None,
    area_warning_service: AreaWarningService | None = None,
    tide_service: TideService | None = None,
    settings: AppSettings | None = None,
) -> FastAPI:
    app_settings = settings or load_settings()
    shared_client = WeatherApiClient(app_settings)
    dashboard_service = service or DashboardService(app_settings, shared_client)
    query1_snapshot_service = query1_service or Query1Service(app_settings, shared_client)
    area_warning_snapshot_service = area_warning_service or AreaWarningService(app_settings, shared_client)
    tide_snapshot_service = tide_service or TideService(app_settings, shared_client)
    templates = Jinja2Templates(directory=str(app_settings.template_dir))

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await dashboard_service.start()
        await query1_snapshot_service.start()
        await area_warning_snapshot_service.start()
        await tide_snapshot_service.start()
        try:
            yield
        finally:
            await tide_snapshot_service.stop()
            await area_warning_snapshot_service.stop()
            await query1_snapshot_service.stop()
            await dashboard_service.stop()

    app = FastAPI(title="목포 기상상황부 대시보드", lifespan=lifespan)
    app.mount("/static", StaticFiles(directory=str(app_settings.static_dir)), name="static")

    def is_embed(request: Request) -> bool:
        return request.query_params.get("embed", "").lower() in {"1", "true", "yes"}

    @app.get("/", response_class=HTMLResponse)
    async def index(request: Request) -> HTMLResponse:
        snapshot = dashboard_service.get_snapshot()
        return templates.TemplateResponse(
            request,
            "index.html",
            {
                "snapshot_json": json.dumps(snapshot.model_dump(mode="json", by_alias=True), ensure_ascii=False),
                "client_refresh_seconds": app_settings.client_refresh_interval_seconds,
                "embed": is_embed(request),
            },
        )

    @app.get("/query1", response_class=HTMLResponse)
    async def query1_page(request: Request) -> HTMLResponse:
        preview_tm = request.query_params.get("tm")
        if preview_tm:
            preview_now = _parse_compact_tm(preview_tm, app_settings.timezone_name) or shared_client.now()
            snapshot = await asyncio.to_thread(
                query1_snapshot_service.builder.build,
                preview_now,
                preview_tm,
            )
            snapshot_data = snapshot.snapshot
        else:
            snapshot_data = query1_snapshot_service.get_snapshot()
        return templates.TemplateResponse(
            request,
            "query1.html",
            {
                "snapshot_json": json.dumps(snapshot_data.model_dump(mode="json", by_alias=True), ensure_ascii=False),
                "client_refresh_seconds": app_settings.runtime_config.get("query1_refresh_seconds"),
                "default_selection_json": json.dumps(app_settings.query1_default_selection, ensure_ascii=False),
                "embed": is_embed(request),
                "preview_tm": preview_tm or "",
            },
        )

    @app.get("/area-warnings", response_class=HTMLResponse)
    async def area_warning_page(request: Request) -> HTMLResponse:
        preview_tm = request.query_params.get("tm")
        if preview_tm:
            preview_now = _parse_compact_tm(preview_tm, app_settings.timezone_name) or shared_client.now()
            snapshot = await asyncio.to_thread(
                AreaWarningBuilder(app_settings, shared_client).build,
                preview_now,
                preview_tm,
            )
            snapshot_data = snapshot.snapshot
            default_selection = [
                entry.selection_key for entry in snapshot_data.entries if entry.warnings
            ] or app_settings.area_warning_default_selection
        else:
            snapshot_data = area_warning_snapshot_service.get_snapshot()
            default_selection = app_settings.area_warning_default_selection
        return templates.TemplateResponse(
            request,
            "area_warnings.html",
            {
                "snapshot_json": json.dumps(snapshot_data.model_dump(mode="json", by_alias=True), ensure_ascii=False),
                "client_refresh_seconds": app_settings.client_refresh_interval_seconds,
                "default_selection_json": json.dumps(default_selection, ensure_ascii=False),
                "embed": is_embed(request),
                "preview_tm": preview_tm or "",
            },
        )

    @app.get("/tides", response_class=HTMLResponse)
    async def tides_page(request: Request) -> HTMLResponse:
        snapshot = tide_snapshot_service.get_snapshot()
        return templates.TemplateResponse(
            request,
            "tides.html",
            {
                "snapshot_json": json.dumps(snapshot.model_dump(mode="json", by_alias=True), ensure_ascii=False),
                "client_refresh_seconds": app_settings.client_refresh_interval_seconds,
                "embed": is_embed(request),
            },
        )

    @app.get("/tide-size-preview", response_class=HTMLResponse)
    async def tide_size_preview_page(request: Request) -> HTMLResponse:
        snapshot = tide_snapshot_service.get_snapshot()
        return templates.TemplateResponse(
            request,
            "tide_size_preview.html",
            {
                "snapshot_json": json.dumps(snapshot.model_dump(mode="json", by_alias=True), ensure_ascii=False),
            },
        )

    @app.get("/tide-layout-preview", response_class=HTMLResponse)
    async def tide_layout_preview_page(request: Request) -> HTMLResponse:
        snapshot = tide_snapshot_service.get_snapshot()
        return templates.TemplateResponse(
            request,
            "tide_layout_preview.html",
            {
                "snapshot_json": json.dumps(snapshot.model_dump(mode="json", by_alias=True), ensure_ascii=False),
                "client_refresh_seconds": app_settings.client_refresh_interval_seconds,
            },
        )

    @app.get("/tide-table-preview", response_class=HTMLResponse)
    async def tide_table_preview_page(request: Request) -> HTMLResponse:
        snapshot = tide_snapshot_service.get_snapshot()
        return templates.TemplateResponse(
            request,
            "tide_table_preview.html",
            {
                "snapshot_json": json.dumps(snapshot.model_dump(mode="json", by_alias=True), ensure_ascii=False),
                "client_refresh_seconds": app_settings.client_refresh_interval_seconds,
            },
        )

    def _load_overview_layout() -> dict:
        path = app_settings.overview_layout_path
        if not path.exists():
            return {"leftPct": 40, "topHeightPx": 248, "rightZoom": 1.0, "leftZoom": 1.0, "bottomZoom": 1.0}
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {"leftPct": 40, "topHeightPx": 248, "rightZoom": 1.0, "leftZoom": 1.0, "bottomZoom": 1.0}

    @app.get("/overview", response_class=HTMLResponse)
    async def overview_page(request: Request) -> HTMLResponse:
        return templates.TemplateResponse(
            request,
            "overview.html",
            {
                "client_refresh_seconds": app_settings.client_refresh_interval_seconds,
                "layout_json": json.dumps(_load_overview_layout(), ensure_ascii=False),
            },
        )

    @app.get("/kma-buoy-compare", response_class=HTMLResponse)
    async def kma_buoy_compare_page(request: Request) -> HTMLResponse:
        query1_snapshot = query1_snapshot_service.get_snapshot()
        return templates.TemplateResponse(
            request,
            "kma_buoy_compare.html",
            _build_kma_buoy_compare_context(
                shared_client,
                query1_snapshot.rows,
                request.query_params.get("tm"),
            ),
        )

    @app.get("/api/overview/layout")
    async def get_overview_layout():
        return _load_overview_layout()

    @app.put("/api/overview/layout")
    async def save_overview_layout(request: Request):
        data = await request.json()
        layout = {
            "leftPct": float(data.get("leftPct", 40)),
            "topHeightPx": float(data.get("topHeightPx", 248)),
            "rightZoom": float(data.get("rightZoom", 1.0)),
            "leftZoom": float(data.get("leftZoom", 1.0)),
            "bottomZoom": float(data.get("bottomZoom", 1.0)),
        }
        app_settings.overview_layout_path.write_text(
            json.dumps(layout, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return layout

    @app.get("/api/dashboard/snapshot")
    async def get_snapshot():
        return dashboard_service.get_snapshot()

    @app.get("/api/dashboard/warning-map.png")
    async def get_dashboard_warning_map():
        path = dashboard_service.get_warning_map_path()
        if path is None:
            raise HTTPException(status_code=404, detail="Warning map cache is empty.")
        return FileResponse(path, media_type="image/png")

    @app.get("/api/health")
    async def get_health():
        return dashboard_service.get_health()

    @app.get("/api/query1/snapshot")
    async def get_query1_snapshot(request: Request):
        preview_tm = request.query_params.get("tm")
        if preview_tm:
            preview_now = _parse_compact_tm(preview_tm, app_settings.timezone_name) or shared_client.now()
            result = await asyncio.to_thread(
                query1_snapshot_service.builder.build,
                preview_now,
                preview_tm,
            )
            return result.snapshot
        return query1_snapshot_service.get_snapshot()

    @app.get("/api/query1/health")
    async def get_query1_health():
        return query1_snapshot_service.get_health()

    @app.get("/api/query1/log-summary")
    async def get_query1_log_summary():
        return query1_snapshot_service.get_log_summary()

    @app.put("/api/query1/preferences")
    async def save_query1_preferences(preference: Query1SelectionPreference):
        selected_keys = list(dict.fromkeys(preference.selected_keys))
        app_settings.query1_default_selection_path.write_text(
            json.dumps(selected_keys, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        app_settings.query1_default_selection = selected_keys
        return Query1SelectionPreference(selected_keys=selected_keys)

    @app.get("/api/area-warnings/snapshot")
    async def get_area_warning_snapshot(request: Request):
        preview_tm = request.query_params.get("tm")
        if preview_tm:
            preview_now = _parse_compact_tm(preview_tm, app_settings.timezone_name) or shared_client.now()
            result = await asyncio.to_thread(
                AreaWarningBuilder(app_settings, shared_client).build,
                preview_now,
                preview_tm,
            )
            return result.snapshot
        return area_warning_snapshot_service.get_snapshot()

    @app.get("/api/area-warnings/health")
    async def get_area_warning_health():
        return area_warning_snapshot_service.get_health()

    @app.put("/api/area-warnings/preferences")
    async def save_area_warning_preferences(preference: Query1SelectionPreference):
        selected_keys = list(dict.fromkeys(preference.selected_keys))
        app_settings.area_warning_default_selection_path.write_text(
            json.dumps(selected_keys, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        app_settings.area_warning_default_selection = selected_keys
        return Query1SelectionPreference(selected_keys=selected_keys)

    @app.get("/api/tides/snapshot")
    async def get_tide_snapshot():
        return tide_snapshot_service.get_snapshot()

    @app.get("/api/tides/health")
    async def get_tide_health():
        return tide_snapshot_service.get_health()

    @app.get("/settings", response_class=HTMLResponse)
    async def settings_page(request: Request) -> HTMLResponse:
        return templates.TemplateResponse(
            request,
            "settings.html",
            {
                "settings_json": json.dumps(app_settings.runtime_config.as_dict(), ensure_ascii=False),
            },
        )

    @app.get("/api/settings")
    async def get_runtime_settings():
        return app_settings.runtime_config.as_dict()

    @app.put("/api/settings")
    async def save_runtime_settings(request: Request):
        data = await request.json()
        app_settings.runtime_config.update(data)
        return app_settings.runtime_config.as_dict()

    @app.get("/api/area-warnings/warning-map.png")
    async def get_area_warning_map():
        path = area_warning_snapshot_service.get_warning_map_path()
        if path is None:
            raise HTTPException(status_code=404, detail="Warning map cache is empty.")
        return FileResponse(path, media_type="image/png")

    @app.get("/api/kma/warning-map.png")
    async def get_kma_warning_map_image():
        """기상청 API 허브 특보 현황도 이미지를 실시간으로 프록시합니다."""
        try:
            now = shared_client.now()
            image_bytes = await asyncio.to_thread(
                shared_client.fetch_kma_warning_map_image, now
            )
            return Response(content=image_bytes, media_type="image/png")
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"KMA API 오류: {exc}") from exc

    return app


app = create_app()
