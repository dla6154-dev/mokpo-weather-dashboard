# 목포 기상상황부 대시보드

FastAPI 기반 내부용 기상 대시보드입니다.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/dla6154-dev/mokpo-weather-dashboard)

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

## EXE 빌드

현재 웹앱은 데스크톱 실행파일로도 빌드할 수 있습니다.

1. `python -m pip install -r requirements.txt`
2. `.env`를 프로젝트 루트에 준비합니다.
3. `build_dashboard_exe.bat` 실행
4. 결과물: `dist\목포기상종합\목포기상종합.exe`

실행파일은 내부적으로 로컬 FastAPI 서버를 띄운 뒤 `기상종합(/overview)` 화면을 창으로 엽니다.

### 단일 EXE 빌드

1. `python -m pip install -r requirements.txt`
2. `.env`를 프로젝트 루트에 준비합니다.
3. `build_dashboard_onefile.bat` 실행
4. 결과물: `dist\목포기상종합_단일_qt.exe`

단일 EXE는 파일 하나로 실행되지만, 실데이터를 쓰려면 `dist` 폴더에 `.env`를 같이 두는 방식이 가장 안전합니다.
