# Render 배포 가이드

이 앱은 `Render + GitHub` 조합으로 배포하는 것을 기준으로 맞춰져 있습니다.

## 왜 Render로 배포하나

- 현재 앱이 `FastAPI` 서버를 직접 실행해야 합니다.
- 정적 호스팅만 지원하는 GitHub Pages, Firebase Hosting과 달리 서버 프로세스를 그대로 띄울 수 있습니다.
- 이 앱은 선택 상태, 레이아웃, 캐시를 파일로 저장하므로 `persistent disk`를 붙이기 쉽습니다.

## 이미 준비된 파일

- `render.yaml`
- `.python-version`
- `.env.example`

## 배포 순서

1. 이 폴더를 GitHub 저장소로 올립니다.
2. Render에서 `New +` -> `Blueprint` 또는 `Web Service`를 선택합니다.
3. 저장소를 연결합니다.
4. `render.yaml`을 읽게 하거나, 수동으로 아래 값을 넣습니다.

## Render 수동 설정값

- Runtime: `Python`
- Build Command: `pip install -r requirements.txt`
- Start Command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
- Health Check Path: `/api/health`

## Render 환경변수

필수:

- `KMA_AUTH_KEY`
- `KMA_PUB_AUTH_KEY`
- `MARINE_SERVICE_KEY_JSON`
- `MARINE_SERVICE_KEY_XML`
- `TIDE_SERVICE_KEY`

권장 기본값:

- `DASHBOARD_STATE_DIR=/var/data/state`
- `DASHBOARD_CACHE_DIR=/var/data/cache`
- `DASHBOARD_TIMEZONE=Asia/Seoul`
- `KMA_COMMENTARY_STATION_ID=156`
- `DASHBOARD_REFRESH_SECONDS=300`
- `DASHBOARD_CLIENT_REFRESH_SECONDS=30`
- `DASHBOARD_REQUEST_TIMEOUT_SECONDS=30`

## Persistent Disk

이 앱은 아래 파일을 런타임에 저장합니다.

- 조석/기상 캐시
- 관측소 기본 선택값
- 해역 기본 선택값
- 기상종합 레이아웃
- 런타임 설정

그래서 Render에서 `persistent disk`를 붙이는 게 맞습니다.

권장값:

- Mount Path: `/var/data`
- Size: `1GB` 이상

## 배포 후 확인

1. 서비스가 `Live` 상태인지 확인
2. `/api/health` 가 `200`인지 확인
3. `/query1`, `/area-warnings`, `/overview` 접속 확인
4. 설정 저장 후 재시작해도 값이 유지되는지 확인

## 참고

- `render.yaml`은 기본 서비스 설정과 비밀이 아닌 환경변수만 포함합니다.
- 실제 API 키는 Render 대시보드에서 직접 넣어야 합니다.
