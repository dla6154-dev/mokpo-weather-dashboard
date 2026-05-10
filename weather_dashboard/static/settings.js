/* ── 특보 현황도 ─────────────────────────────────── */
const warningMapImg = document.getElementById("warning-map-img");
const warningMapStatus = document.getElementById("warning-map-status");
const warningMapRefreshBtn = document.getElementById("warning-map-refresh-btn");

function refreshWarningMap() {
  if (!warningMapImg) return;
  if (warningMapRefreshBtn) { warningMapRefreshBtn.disabled = true; warningMapRefreshBtn.textContent = "로딩 중…"; }
  if (warningMapStatus) warningMapStatus.textContent = "이미지를 불러오는 중…";
  const ts = Date.now();
  const newImg = new Image();
  newImg.onload = () => {
    warningMapImg.src = newImg.src;
    if (warningMapStatus) warningMapStatus.textContent = `최종 갱신: ${new Date().toLocaleTimeString("ko-KR")}`;
    if (warningMapRefreshBtn) { warningMapRefreshBtn.disabled = false; warningMapRefreshBtn.textContent = "새로고침"; }
  };
  newImg.onerror = () => {
    if (warningMapStatus) warningMapStatus.textContent = "이미지 로드 실패. 잠시 후 다시 시도하세요.";
    if (warningMapRefreshBtn) { warningMapRefreshBtn.disabled = false; warningMapRefreshBtn.textContent = "새로고침"; }
  };
  newImg.src = `/api/kma/warning-map.png?_t=${ts}`;
}

if (warningMapImg) {
  warningMapImg.addEventListener("load", () => {
    if (warningMapStatus) warningMapStatus.textContent = `최종 갱신: ${new Date().toLocaleTimeString("ko-KR")}`;
  });
  warningMapImg.addEventListener("error", () => {
    if (warningMapStatus) warningMapStatus.textContent = "이미지 로드 실패. API 키를 확인하거나 잠시 후 다시 시도하세요.";
  });
}

if (warningMapRefreshBtn) {
  warningMapRefreshBtn.addEventListener("click", refreshWarningMap);
}

/* ── API 조회 주기 ───────────────────────────────── */
const initial = window.__SETTINGS__ || {};

const fields = [
  { key: "dashboard_refresh_seconds", curId: "cur-dashboard", inpId: "inp-dashboard" },
  { key: "query1_refresh_seconds",    curId: "cur-query1",    inpId: "inp-query1" },
  { key: "area_warning_refresh_seconds", curId: "cur-area",   inpId: "inp-area" },
  { key: "tide_refresh_seconds",      curId: "cur-tide",      inpId: "inp-tide" },
  { key: "client_refresh_seconds",    curId: "cur-client",    inpId: "inp-client" },
];

function populate(data) {
  for (const { key, curId, inpId } of fields) {
    const val = data[key] ?? "";
    const curEl = document.getElementById(curId);
    const inpEl = document.getElementById(inpId);
    if (curEl) curEl.textContent = val ? `${val}초` : "-";
    if (inpEl) inpEl.value = val;
  }
}

populate(initial);

const saveBtn = document.getElementById("settings-save-btn");
const statusEl = document.getElementById("settings-status");

if (saveBtn) {
  saveBtn.addEventListener("click", async () => {
    const payload = {};
    for (const { key, inpId } of fields) {
      const v = Number(document.getElementById(inpId)?.value);
      if (Number.isFinite(v) && v > 0) payload[key] = v;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = "저장 중…";
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const saved = await res.json();
      populate(saved);
      if (statusEl) statusEl.textContent = "저장 완료. 서버 조회 주기는 다음 회차부터 적용됩니다.";
      saveBtn.textContent = "저장 완료";
    } catch (e) {
      if (statusEl) statusEl.textContent = `저장 실패: ${e.message}`;
      saveBtn.textContent = "저장 실패";
    } finally {
      setTimeout(() => { saveBtn.textContent = "저장"; saveBtn.disabled = false; }, 2000);
    }
  });
}
