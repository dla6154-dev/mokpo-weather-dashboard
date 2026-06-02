from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import requests

from .config import AppSettings
from .ssl_support import configure_ssl_defaults


class WeatherApiClient:
    WRN_NOW_DATA_URL = "https://apihub.kma.go.kr/api/typ01/url/wrn_now_data.php"

    def __init__(self, settings: AppSettings) -> None:
        configure_ssl_defaults()
        self.settings = settings
        self.session = requests.Session()
        if self.settings.ca_bundle_path:
            self.session.verify = self.settings.ca_bundle_path
        else:
            self.session.verify = self.settings.ssl_verify

    def _get_text(self, url: str) -> str:
        response = self.session.get(url, timeout=self.settings.request_timeout_seconds)
        response.raise_for_status()
        return response.text

    def _get_bytes(self, url: str) -> bytes:
        response = self.session.get(url, timeout=self.settings.request_timeout_seconds)
        response.raise_for_status()
        return response.content

    def fetch_wrn_now_data_at(self, tm: str | None = None) -> str:
        response = self.session.get(
            self.WRN_NOW_DATA_URL,
            params={
                "fe": "f",
                "tm": tm or "",
                "disp": "0",
                "help": "1",
                "authKey": self.settings.kma_auth_key,
            },
            timeout=self.settings.request_timeout_seconds,
        )
        response.raise_for_status()
        return response.text

    def fetch_warning_list(self) -> str:
        return self.fetch_wrn_now_data_at()

    def fetch_wrn_now_data(self) -> str:
        return self.fetch_wrn_now_data_at()

    def fetch_commentary(self) -> str:
        return self._get_text(
            "https://apihub.kma.go.kr/api/typ01/url/wthr_cmt_rpt.php"
            f"?stn={self.settings.commentary_station_id}&subcd=0&disp=0&help=1&authKey={self.settings.kma_auth_key}"
        )

    def build_sea_obs_url(self, tm: str | None = None, stn: str = "0") -> str:
        query_parts: list[str] = []
        if tm:
            query_parts.append(f"tm={tm}")
        else:
            query_parts.append(f"stn={stn}")
        query_parts.append("help=1")
        query_parts.append(f"authKey={self.settings.kma_pub_auth_key}")
        return "https://apihub-pub.kma.go.kr/api/typ01/url/sea_obs.php?" + "&".join(query_parts)

    def fetch_sea_obs(self) -> str:
        return self._get_text(self.build_sea_obs_url())

    def fetch_sea_obs_at(self, tm: str, stn: str = "0") -> str:
        return self._get_text(self.build_sea_obs_url(tm=tm, stn=stn))

    def fetch_kma_lhaws2(self) -> str:
        return self._get_text(
            "https://apihub-pub.kma.go.kr/api/typ01/url/kma_lhaws2.php"
            f"?stn=0&help=1&authKey={self.settings.kma_pub_auth_key}"
        )

    def fetch_kma_buoy(self) -> str:
        return self._get_text(self.build_kma_buoy_url())

    def build_kma_buoy_url(self, tm: str | None = None, stn: str = "0") -> str:
        query_parts: list[str] = []
        if tm:
            query_parts.append(f"tm={tm}")
        query_parts.append(f"stn={stn}")
        query_parts.append("help=1")
        query_parts.append(f"authKey={self.settings.kma_pub_auth_key}")
        return "https://apihub-pub.kma.go.kr/api/typ01/url/kma_buoy.php?" + "&".join(query_parts)

    def fetch_kma_buoy_at(self, tm: str, stn: str = "0") -> str:
        return self._get_text(self.build_kma_buoy_url(tm=tm, stn=stn))

    def fetch_station_info(self, inf: str) -> str:
        response = self.session.get(
            "https://apihub.kma.go.kr/api/typ01/url/stn_inf.php",
            params={
                "inf": inf,
                "help": "1",
                "authKey": self.settings.kma_auth_key,
            },
            timeout=self.settings.request_timeout_seconds,
        )
        response.raise_for_status()
        return response.content.decode("cp949", errors="replace")

    def fetch_forecast_today(self, now: datetime) -> str:
        tmfc = now.strftime("%Y%m%d%H")
        return self._get_text(
            "https://apihub-pub.kma.go.kr/api/typ01/url/fct_afs_do.php"
            f"?reg=&tmfc2={tmfc}&disp=1&help=0&authKey={self.settings.kma_pub_auth_key}"
        )

    def fetch_forecast_fallback(self, now: datetime) -> str:
        base = (now - timedelta(days=2)).strftime("%Y%m%d")
        return self._get_text(
            "https://apihub-pub.kma.go.kr/api/typ01/url/fct_afs_do.php"
            f"?reg=&tmfc1={base}05&disp=1&help=0&authKey={self.settings.kma_pub_auth_key}"
        )

    def fetch_marine_json(self) -> str:
        return self._get_text(
            "http://marineweather.nmpnt.go.kr:8001/openWeatherNow.do"
            f"?serviceKey={self.settings.marine_service_key_json}"
            "&resultType=json&mmaf=107&mmsi=1079001,1079008&dataType=2"
        )

    def fetch_marine_xml(self) -> str:
        return self._get_text(
            "http://marineweather.nmpnt.go.kr:8001/openWeatherNow.do"
            f"?serviceKey={self.settings.marine_service_key_xml}"
            "&resultType=xml&mmaf=112&mmsi=994403901,994403895"
        )

    def fetch_marine_hajo(self) -> str:
        return self._get_text(
            "http://marineweather.nmpnt.go.kr:8001/openWeatherNow.do"
            f"?serviceKey={self.settings.marine_service_key_json}"
            "&resultType=json&mmaf=113&mmsi=1139001&dataType=2"
        )

    def fetch_warning_map(self, now: datetime) -> bytes:
        url = (
            "https://www.weather.go.kr/w/repositary/xml/wrn/img/JN_"
            f"{now.strftime('%Y%m%d%H')}0000.png"
        )
        return self._get_bytes(url)

    def fetch_kma_warning_map_image(
        self,
        now: datetime,
        lon: float = 127.7,
        lat: float = 36.1,
        range_km: int = 300,
        size: int = 685,
    ) -> bytes:
        """기상청 API 허브의 특보 현황도 이미지를 가져옵니다."""
        tm = now.strftime("%Y%m%d%H%M")
        response = self.session.get(
            "https://apihub.kma.go.kr/api/typ03/cgi/wrn/nph-wrn7",
            params={
                "out": "0",
                "tmef": "1",
                "city": "1",
                "name": "0",
                "tm": tm,
                "lon": str(lon),
                "lat": str(lat),
                "range": str(range_km),
                "size": str(size),
                "wrn": "W,R,C,D,O,V,T,S,Y,H,",
                "authKey": self.settings.kma_auth_key,
            },
            timeout=self.settings.request_timeout_seconds,
        )
        response.raise_for_status()
        return response.content

    def fetch_tide(self, obs_code: str, req_date: str) -> dict:
        response = self.session.get(
            "https://apis.data.go.kr/1192136/tideFcstHghLw/GetTideFcstHghLwApiService",
            params={
                "serviceKey": self.settings.tide_service_key,
                "pageNo": "1",
                "numOfRows": "10",
                "type": "JSON",
                "obsCode": obs_code,
                "reqDate": req_date,
            },
            timeout=self.settings.request_timeout_seconds,
        )
        response.raise_for_status()
        return response.json()

    def now(self) -> datetime:
        return datetime.now(ZoneInfo(self.settings.timezone_name))
