# HANDOFF

## 프로젝트 위치
- `C:\Users\USER\Desktop\기상상황부`

## 현재 핵심 목표
- 엑셀 기반 `목포 기상상황부`를 FastAPI 웹 화면으로 옮기는 작업 진행 중
- 현재는 아래 3개 화면이 있음
  - `/` : 기상상황부 메인
  - `/query1` : 쿼리1 실시간 화면
  - `/area-warnings` : 해역별 기상특보 화면

## 최근 완료 상태

### 1. `/query1`
- 실시간 데이터 화면 구현 완료
- `sea_obs + kma_buoy` 기준
- `연도`, `월일`, `STN` 컬럼 제거됨
- 좌우 이동형 선택 UI 적용됨
- 선택목록에서 `위로 / 아래로` 버튼으로 순서 변경 가능
- 표 표시 순서와 저장 순서가 선택목록 순서를 따름
- 현재 선택 저장 기능 있음
- 기본 선택값은 서버 파일에 저장됨
  - `C:\Users\USER\Desktop\기상상황부\weather_dashboard\config\query1_default_selection.json`

### 2. `/area-warnings`
- 해역별 기상특보 전용 화면 구현 완료
- 기준 해역 목록은 이제 아래 파일을 직접 읽음
  - `C:\Users\USER\Desktop\기상상황부\예보 구역.txt`
- 파일 형식
  - `해역코드<TAB>해역명`
- `wrn_now_data.php` 응답의 `REG_ID`와 `예보 구역.txt`의 `해역코드`를 직접 매칭함
- 매칭되는 특보가 있으면 표출
- 없으면 해당 해역은 `특보 없음`으로 표출
- 선택 목록도 `예보 구역.txt` 전체 기준으로 생성됨
- 특보 지도는 제거됨
- 표는 `특보구역 / 특보현황 / 발표 / 발효 / 해제` 컬럼만 표시
- 현재 선택 상태는 서버 기본값 파일에 저장 가능
  - `C:\Users\USER\Desktop\기상상황부\weather_dashboard\config\area_warning_default_selection.json`
- 현재 기본 선택은 60개 전체 해역
- 선택목록에서 `위로 / 아래로` 버튼으로 순서 변경 가능
- 저장 시 선택 순서도 그대로 기본값에 반영됨

## 매우 중요한 현재 상황
- `wrn_now_data.php`는 현재 시점에 실제 특보 데이터 행이 `0건`
- 그래서 `/area-warnings` 화면에서 전체 해역이 `특보 없음`으로 보이는 것은 버그가 아니라 원본 응답 상태임
- 즉 화면 로직 점검 시 `API 원본이 비어 있음`을 먼저 고려해야 함

## 현재 브라우저 상태
- 인앱 브라우저 최근 확인 URL
  - `http://127.0.0.1:8000/area-warnings?refresh=20260505`

## 주요 파일

### 백엔드
- `C:\Users\USER\Desktop\기상상황부\weather_dashboard\app.py`
- `C:\Users\USER\Desktop\기상상황부\weather_dashboard\service.py`
- `C:\Users\USER\Desktop\기상상황부\weather_dashboard\clients.py`
- `C:\Users\USER\Desktop\기상상황부\weather_dashboard\parsers.py`
- `C:\Users\USER\Desktop\기상상황부\weather_dashboard\config.py`
- `C:\Users\USER\Desktop\기상상황부\weather_dashboard\models.py`

### 프론트
- `C:\Users\USER\Desktop\기상상황부\weather_dashboard\templates\index.html`
- `C:\Users\USER\Desktop\기상상황부\weather_dashboard\templates\query1.html`
- `C:\Users\USER\Desktop\기상상황부\weather_dashboard\templates\area_warnings.html`
- `C:\Users\USER\Desktop\기상상황부\weather_dashboard\static\dashboard.js`
- `C:\Users\USER\Desktop\기상상황부\weather_dashboard\static\query1.js`
- `C:\Users\USER\Desktop\기상상황부\weather_dashboard\static\area_warnings.js`
- `C:\Users\USER\Desktop\기상상황부\weather_dashboard\static\dashboard.css`

### 설정/원본 매핑
- `C:\Users\USER\Desktop\기상상황부\예보 구역.txt`
- `C:\Users\USER\Desktop\기상상황부\weather_dashboard\config\dashboard_rows.json`
- `C:\Users\USER\Desktop\기상상황부\weather_dashboard\config\forecast_regions.json`
- `C:\Users\USER\Desktop\기상상황부\weather_dashboard\config\station_aliases.json`

## 테스트 상태
- 최근 확인 결과: `python -m pytest -q`
- 결과: `9 passed`

## 실행 방법

### 서버 실행
```powershell
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

### 서버 재시작
```powershell
$owningPid = (Get-NetTCPConnection -LocalPort 8000 -State Listen | Select-Object -First 1 -ExpandProperty OwningProcess)
if ($owningPid) { Stop-Process -Id $owningPid -Force }
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

### 테스트
```powershell
python -m pytest -q
```

## 환경 변수
- `.env` 사용
- 현재 중요 키
  - `KMA_AUTH_KEY`
  - `KMA_PUB_AUTH_KEY`
  - `MARINE_SERVICE_KEY_JSON`
  - `MARINE_SERVICE_KEY_XML`

## 현재 구현 메모
- `/area-warnings`는 JS/CSS 캐시 방지를 위해 템플릿에 `?v=20260505` 쿼리를 붙여둠
- `/query1` 기본 선택은 서버 저장 방식
- `/area-warnings`도 서버 저장 방식으로 변경됨

## 다음 작업 예시
- `/area-warnings` 기본 선택 해역 저장 기능 추가
- `특보 없음` 해역 숨기기 옵션 추가
- 특정 해역군만 기본 선택으로 고정
- 표 컬럼 순서/문구 조정
- 메인 `/` 화면의 해역 특보 표와 `/area-warnings` 화면의 기준 통일

## 다음 작업자에게 바로 줄 문장
```text
처음부터 재분석하지 말고 C:\Users\USER\Desktop\기상상황부\HANDOFF.md 기준으로 이어서 작업해줘.
현재 /area-warnings 는 예보 구역.txt 기반이며, wrn_now_data.php 의 REG_ID 와 해역코드를 직접 매칭해서 특보가 있으면 표시하고 없으면 특보 없음으로 보이게 되어 있다.
```
