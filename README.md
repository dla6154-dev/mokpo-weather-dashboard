# 목포 기상상황부 대시보드

FastAPI 기반 내부용 기상 대시보드입니다.

## 로컬 실행

1. `python -m pip install -r requirements.txt`
2. `.env.example`를 복사해서 `.env`를 만들고 실제 키를 채웁니다.
3. `python -m uvicorn main:app --host 127.0.0.1 --port 8000`
4. 브라우저에서 `http://127.0.0.1:8000`

## 필수 환경변수

- `KMA_AUTH_KEY`
- `KMA_PUB_AUTH_KEY`
- `MARINE_SERVICE_KEY_JSON`
- `MARINE_SERVICE_KEY_XML`
- `TIDE_SERVICE_KEY`

## 선택 환경변수

- `KMA_COMMENTARY_STATION_ID`
- `DASHBOARD_REFRESH_SECONDS`
- `DASHBOARD_CLIENT_REFRESH_SECONDS`
- `DASHBOARD_REQUEST_TIMEOUT_SECONDS`
- `DASHBOARD_TIMEZONE`
- `DASHBOARD_STATE_DIR`
- `DASHBOARD_CACHE_DIR`

## 테스트

- `python -m pytest -q`

## 배포

Render 배포 기준 문서는 [DEPLOY_RENDER.md](C:\Users\USER\Desktop\기상상황부\DEPLOY_RENDER.md) 에 정리되어 있습니다.
