from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class RuntimeConfig:
    """Mutable runtime settings loaded from / saved to a JSON file."""

    DEFAULTS: dict[str, int] = {
        "dashboard_refresh_seconds": 300,
        "query1_refresh_seconds": 60,
        "area_warning_refresh_seconds": 300,
        "tide_refresh_seconds": 3600,
        "client_refresh_seconds": 30,
    }

    def __init__(self, path: Path) -> None:
        self._path = path
        self._data: dict[str, int] = self._load()

    def _load(self) -> dict[str, int]:
        if self._path.exists():
            try:
                raw = json.loads(self._path.read_text(encoding="utf-8"))
                return {k: int(v) for k, v in raw.items() if k in self.DEFAULTS}
            except Exception:
                pass
        return {}

    def get(self, key: str) -> int:
        return self._data.get(key, self.DEFAULTS[key])

    def as_dict(self) -> dict[str, int]:
        return {k: self._data.get(k, v) for k, v in self.DEFAULTS.items()}

    def update(self, data: dict) -> None:
        merged = {k: int(data[k]) for k in self.DEFAULTS if k in data}
        self._data = merged
        self._path.write_text(
            json.dumps(merged, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _read_json_if_exists(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return _read_json(path)


def _read_area_warning_regions(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []

    entries: list[dict[str, str]] = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if "\t" in line:
            area_code, area_name = line.split("\t", 1)
        else:
            parts = line.split(maxsplit=1)
            if len(parts) < 2:
                continue
            area_code, area_name = parts
        entries.append({"area_code": area_code.strip(), "area_name": area_name.strip()})
    return entries


def _runtime_base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def _resource_base_dir() -> Path:
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            return Path(meipass)
    return Path(__file__).resolve().parent.parent


@dataclass(slots=True)
class AppSettings:
    base_dir: Path
    template_dir: Path
    static_dir: Path
    config_dir: Path
    state_dir: Path
    cache_dir: Path
    refresh_interval_seconds: int
    client_refresh_interval_seconds: int
    request_timeout_seconds: int
    timezone_name: str
    kma_auth_key: str
    kma_pub_auth_key: str
    marine_service_key_json: str
    marine_service_key_xml: str
    commentary_station_id: str
    warning_rows: list[dict[str, Any]]
    forecast_regions: dict[str, str]
    station_aliases: dict[str, str]
    query1_default_selection: list[str]
    area_warning_regions: list[dict[str, str]]
    area_warning_default_selection: list[str]
    tide_service_key: str
    runtime_config: RuntimeConfig
    ssl_verify: bool = True
    ca_bundle_path: str = ""

    @property
    def tide_snapshot_cache_path(self) -> Path:
        return self.cache_dir / "tide_snapshot.json"

    @property
    def snapshot_cache_path(self) -> Path:
        return self.cache_dir / "latest_snapshot.json"

    @property
    def query1_snapshot_cache_path(self) -> Path:
        return self.cache_dir / "query1_snapshot.json"

    @property
    def query1_arrival_log_path(self) -> Path:
        return self.cache_dir / "query1_arrival_log.jsonl"

    @property
    def area_warning_snapshot_cache_path(self) -> Path:
        return self.cache_dir / "area_warning_snapshot.json"

    @property
    def warning_map_cache_path(self) -> Path:
        return self.cache_dir / "warning_map.png"

    @property
    def query1_default_selection_path(self) -> Path:
        return self.state_dir / "query1_default_selection.json"

    @property
    def query1_column_sizes_path(self) -> Path:
        return self.state_dir / "query1_column_sizes.json"

    @property
    def area_warning_default_selection_path(self) -> Path:
        return self.state_dir / "area_warning_default_selection.json"

    @property
    def overview_layout_path(self) -> Path:
        return self.state_dir / "overview_layout.json"

    @property
    def runtime_settings_path(self) -> Path:
        return self.state_dir / "runtime_settings.json"

    def missing_env_vars(self) -> list[str]:
        missing: list[str] = []
        for key, value in (
            ("KMA_AUTH_KEY", self.kma_auth_key),
            ("KMA_PUB_AUTH_KEY", self.kma_pub_auth_key),
            ("MARINE_SERVICE_KEY_JSON", self.marine_service_key_json),
            ("MARINE_SERVICE_KEY_XML", self.marine_service_key_xml),
        ):
            if not value:
                missing.append(key)
        return missing


def load_settings() -> AppSettings:
    base_dir = _runtime_base_dir()
    resource_dir = _resource_base_dir()
    _load_dotenv(base_dir / ".env")

    package_dir = resource_dir / "weather_dashboard"
    config_dir = package_dir / "config"
    state_dir = Path(os.getenv("DASHBOARD_STATE_DIR", str(base_dir / "dashboard_state")))
    cache_dir = Path(os.getenv("DASHBOARD_CACHE_DIR", str(base_dir / "dashboard_cache")))
    state_dir.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)
    area_warning_path = base_dir / "예보 구역.txt"
    if not area_warning_path.exists():
        area_warning_path = resource_dir / "예보 구역.txt"

    return AppSettings(
        base_dir=base_dir,
        template_dir=package_dir / "templates",
        static_dir=package_dir / "static",
        config_dir=config_dir,
        state_dir=state_dir,
        cache_dir=cache_dir,
        refresh_interval_seconds=int(os.getenv("DASHBOARD_REFRESH_SECONDS", "300")),
        client_refresh_interval_seconds=int(os.getenv("DASHBOARD_CLIENT_REFRESH_SECONDS", "30")),
        request_timeout_seconds=int(os.getenv("DASHBOARD_REQUEST_TIMEOUT_SECONDS", "30")),
        ssl_verify=os.getenv("DASHBOARD_SSL_VERIFY", "true").strip().lower() not in {"0", "false", "no", "off"},
        ca_bundle_path=os.getenv("DASHBOARD_CA_BUNDLE", "").strip(),
        timezone_name=os.getenv("DASHBOARD_TIMEZONE", "Asia/Seoul"),
        kma_auth_key=os.getenv("KMA_AUTH_KEY", ""),
        kma_pub_auth_key=os.getenv("KMA_PUB_AUTH_KEY", ""),
        marine_service_key_json=os.getenv("MARINE_SERVICE_KEY_JSON", ""),
        marine_service_key_xml=os.getenv("MARINE_SERVICE_KEY_XML", ""),
        commentary_station_id=os.getenv("KMA_COMMENTARY_STATION_ID", "156"),
        warning_rows=_read_json(config_dir / "dashboard_rows.json"),
        forecast_regions=_read_json(config_dir / "forecast_regions.json"),
        station_aliases=_read_json(config_dir / "station_aliases.json"),
        query1_default_selection=_read_json_if_exists(
            state_dir / "query1_default_selection.json",
            _read_json_if_exists(config_dir / "query1_default_selection.json", []),
        ),
        area_warning_regions=_read_area_warning_regions(area_warning_path),
        area_warning_default_selection=_read_json_if_exists(
            state_dir / "area_warning_default_selection.json",
            _read_json_if_exists(config_dir / "area_warning_default_selection.json", []),
        ),
        tide_service_key=os.getenv("TIDE_SERVICE_KEY", ""),
        runtime_config=RuntimeConfig(state_dir / "runtime_settings.json"),
    )
