const initialSnapshot = window.__INITIAL_QUERY1_SNAPSHOT__ || {};
const refreshSeconds = window.__CLIENT_REFRESH_SECONDS__ || 30;
const previewTm = String(window.__QUERY1_TM__ || "").trim();
let defaultSelectionState = Array.isArray(window.__QUERY1_DEFAULT_SELECTION__)
  ? [...window.__QUERY1_DEFAULT_SELECTION__]
  : [];

const bodyEl = document.getElementById("query1-body");
const generatedAtEl = document.getElementById("generated-at");
const staleBadgeEl = document.getElementById("stale-badge");
const statusMessageEl = document.getElementById("status-message");
const selectionSummaryEl = document.getElementById("selection-summary");
const stationSearchEl = document.getElementById("station-search");
const availableStationsEl = document.getElementById("available-stations");
const selectedStationsEl = document.getElementById("selected-stations");
const addSelectedButton = document.getElementById("add-selected");
const addAllButton = document.getElementById("add-all");
const removeSelectedButton = document.getElementById("remove-selected");
const removeAllButton = document.getElementById("remove-all");
const moveUpButton = document.getElementById("move-up");
const moveDownButton = document.getElementById("move-down");
const saveSelectionButton = document.getElementById("save-selection");
const saveStatusEl = document.getElementById("save-status");

let latestSnapshot = initialSnapshot;
let selectionState = null;
let searchTerm = "";

function formatTimestamp(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}/${month}/${day} ${hour}:${minute}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function numericValue(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function windSeverity(value) {
  const number = numericValue(value);
  if (number === null) return "";
  if (number >= 18) return "purple";
  if (number >= 12) return "red";
  if (number >= 10) return "yellow";
  return "green";
}

function waveSeverity(value) {
  const number = numericValue(value);
  if (number === null) return "";
  if (number >= 3.5) return "purple";
  if (number >= 2.0) return "red";
  if (number >= 1.5) return "yellow";
  return "green";
}

function valueClass(severity) {
  if (severity === "purple") return "value-alert-purple";
  if (severity === "red") return "value-alert-red";
  if (severity === "yellow") return "value-alert-yellow";
  if (severity === "green") return "value-alert-green";
  return "";
}

function rowSeverity(row) {
  const severities = [
    windSeverity(row.windSpeed),
    windSeverity(row.gust),
    waveSeverity(row.waveHeight),
    waveSeverity(row.waveHeightMax),
  ];
  if (severities.includes("purple")) return "purple";
  if (severities.includes("red")) return "red";
  if (severities.includes("yellow")) return "yellow";
  if (severities.includes("green")) return "green";
  return "";
}

function rowKey(row) {
  return [row.observationType || "", row.stationId || "", row.stationName || ""].join("|");
}

function rowLabel(row) {
  return `${row.stationName || "(이름 없음)"} · ${row.observationType || "-"}`;
}

function stationOptions(rows) {
  const unique = new Map();
  for (const row of rows) {
    const key = rowKey(row);
    if (!unique.has(key)) {
      unique.set(key, { key, label: rowLabel(row) });
    }
  }
  return [...unique.values()].sort((a, b) => a.label.localeCompare(b.label, "ko"));
}

function uniqueOrderedKeys(keys, available) {
  const next = [];
  const seen = new Set();
  for (const key of keys) {
    if (!available.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(key);
  }
  return next;
}

function selectionKeySet() {
  return new Set(selectionState || []);
}

function setSaveStatus(message, isError = false) {
  saveStatusEl.textContent = message;
  saveStatusEl.style.color = isError ? "#b45822" : "";
}

function ensureSelectionState(rows) {
  const keys = stationOptions(rows).map((item) => item.key);
  const available = new Set(keys);

  if (selectionState !== null) {
    selectionState = uniqueOrderedKeys(selectionState, available);
    return;
  }

  if (defaultSelectionState.length) {
    const next = uniqueOrderedKeys(defaultSelectionState, available);
    selectionState = next.length ? next : [...keys];
    return;
  }

  selectionState = [...keys];
}

function filteredRows(rows) {
  if (!selectionState) return rows;
  const byKey = new Map(rows.map((row) => [rowKey(row), row]));
  return selectionState.map((key) => byKey.get(key)).filter(Boolean);
}

function availableOptions(rows) {
  const selected = selectionKeySet();
  return stationOptions(rows).filter((item) => {
    if (selected.has(item.key)) return false;
    if (!searchTerm) return true;
    return item.label.toLowerCase().includes(searchTerm);
  });
}

function selectedOptions(rows) {
  const byKey = new Map(stationOptions(rows).map((item) => [item.key, item]));
  return (selectionState || []).map((key) => byKey.get(key)).filter(Boolean);
}

function fillSelectOptions(selectEl, options) {
  selectEl.innerHTML = options
    .map((item) => `<option value="${escapeHtml(item.key)}">${escapeHtml(item.label)}</option>`)
    .join("");
}

function selectedOptionValues(selectEl) {
  return Array.from(selectEl.selectedOptions).map((option) => option.value);
}

function restoreSelectedOptions(selectEl, keys) {
  const targets = new Set(keys);
  for (const option of selectEl.options) {
    option.selected = targets.has(option.value);
  }
}

function renderRows(rows) {
  if (!rows.length) {
    bodyEl.innerHTML = `
      <tr>
        <td colspan="9" class="sheet-empty">선택한 관측소 데이터가 없습니다.</td>
      </tr>
    `;
    return;
  }

  bodyEl.innerHTML = rows
    .map((row) => {
      const windSpeedSeverity = windSeverity(row.windSpeed);
      const gustSeverity = windSeverity(row.gust);
      const waveHeightSeverity = waveSeverity(row.waveHeight);
      const waveHeightMaxSeverity = waveSeverity(row.waveHeightMax);
      const severity = rowSeverity(row);
      return `
        <tr class="${severity ? `query1-row-${severity}` : ""}">
          <td>${escapeHtml(row.hhmm)}</td>
          <td>${escapeHtml(row.observationType)}</td>
          <td class="sheet-name">${escapeHtml(row.stationName)}</td>
          <td>${escapeHtml(row.windDirection)}</td>
          <td class="${valueClass(windSpeedSeverity)}">${escapeHtml(row.windSpeed)}</td>
          <td class="${valueClass(gustSeverity)}">${escapeHtml(row.gust)}</td>
          <td class="${valueClass(waveHeightSeverity)}">${escapeHtml(row.waveHeight)}</td>
          <td class="${valueClass(waveHeightMaxSeverity)}">${escapeHtml(row.waveHeightMax)}</td>
          <td>${escapeHtml(row.visibility)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderSelection(rows) {
  const allOptions = stationOptions(rows);
  const leftOptions = availableOptions(rows);
  const rightOptions = selectedOptions(rows);

  selectionSummaryEl.textContent = `전체 ${allOptions.length}개 / 선택 ${rightOptions.length}개 / 기본 ${defaultSelectionState.length}개`;
  fillSelectOptions(availableStationsEl, leftOptions);
  fillSelectOptions(selectedStationsEl, rightOptions);
}

function renderSnapshot(snapshot) {
  if (!snapshot || !snapshot.meta) {
    statusMessageEl.textContent = "스냅샷이 아직 준비되지 않았습니다.";
    return;
  }

  latestSnapshot = snapshot;
  const rows = snapshot.rows || [];
  ensureSelectionState(rows);
  const visibleRows = filteredRows(rows);

  if (generatedAtEl) generatedAtEl.textContent = formatTimestamp(snapshot.meta.generatedAt);
  if (staleBadgeEl) {
    staleBadgeEl.textContent = snapshot.meta.stale ? "이전 데이터 유지 중" : "정상";
    staleBadgeEl.className = `badge ${snapshot.meta.stale ? "stale" : "ok"}`;
  }
  statusMessageEl.textContent = snapshot.meta.stale
    ? snapshot.meta.staleReason || "갱신 실패로 마지막 정상 데이터를 유지 중입니다."
    : `자동 새로고침 ${refreshSeconds}초 / 데이터 갱신 ${snapshot.meta.refreshIntervalSeconds}초 / 표시 ${visibleRows.length}건 / 전체 ${rows.length}건`;

  renderRows(visibleRows);
  renderSelection(rows);
}

function rerenderFromState() {
  renderSnapshot(latestSnapshot);
}

function addKeys(keys) {
  if (!selectionState) selectionState = [];
  const selected = selectionKeySet();
  for (const key of keys) {
    if (!selected.has(key)) {
      selectionState.push(key);
      selected.add(key);
    }
  }
  setSaveStatus("");
  rerenderFromState();
}

function removeKeys(keys) {
  if (!selectionState) selectionState = [];
  const targets = new Set(keys);
  selectionState = selectionState.filter((key) => !targets.has(key));
  setSaveStatus("");
  rerenderFromState();
}

function moveSelectionUp(keys) {
  if (!selectionState?.length || !keys.length) return;
  const targets = new Set(keys);
  for (let index = 1; index < selectionState.length; index += 1) {
    if (targets.has(selectionState[index]) && !targets.has(selectionState[index - 1])) {
      [selectionState[index - 1], selectionState[index]] = [selectionState[index], selectionState[index - 1]];
    }
  }
  setSaveStatus("");
  rerenderFromState();
  restoreSelectedOptions(selectedStationsEl, keys);
}

function moveSelectionDown(keys) {
  if (!selectionState?.length || !keys.length) return;
  const targets = new Set(keys);
  for (let index = selectionState.length - 2; index >= 0; index -= 1) {
    if (targets.has(selectionState[index]) && !targets.has(selectionState[index + 1])) {
      [selectionState[index + 1], selectionState[index]] = [selectionState[index], selectionState[index + 1]];
    }
  }
  setSaveStatus("");
  rerenderFromState();
  restoreSelectedOptions(selectedStationsEl, keys);
}

async function saveCurrentSelection() {
  const selectedKeys = [...(selectionState || [])];
  saveSelectionButton.disabled = true;
  setSaveStatus("저장 중...");
  try {
    const response = await fetch("/api/query1/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectedKeys }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    defaultSelectionState = Array.isArray(payload.selectedKeys) ? [...payload.selectedKeys] : [];
    setSaveStatus("기본값으로 저장됨");
    rerenderFromState();
  } catch (error) {
    setSaveStatus(`저장 실패: ${error.message}`, true);
  } finally {
    saveSelectionButton.disabled = false;
  }
}

async function refreshSnapshot() {
  try {
    const url = previewTm
      ? `/api/query1/snapshot?tm=${encodeURIComponent(previewTm)}`
      : "/api/query1/snapshot";
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const snapshot = await response.json();
    renderSnapshot(snapshot);
  } catch (error) {
    if (staleBadgeEl) {
      staleBadgeEl.textContent = "통신 실패";
      staleBadgeEl.className = "badge stale";
    }
    statusMessageEl.textContent = `스냅샷 갱신 실패: ${error.message}`;
  }
}

stationSearchEl.addEventListener("input", (event) => {
  searchTerm = String(event.target.value || "").trim().toLowerCase();
  renderSelection(latestSnapshot.rows || []);
});

addSelectedButton.addEventListener("click", () => {
  addKeys(selectedOptionValues(availableStationsEl));
});

addAllButton.addEventListener("click", () => {
  addKeys(availableOptions(latestSnapshot.rows || []).map((item) => item.key));
});

removeSelectedButton.addEventListener("click", () => {
  removeKeys(selectedOptionValues(selectedStationsEl));
});

removeAllButton.addEventListener("click", () => {
  selectionState = [];
  setSaveStatus("");
  rerenderFromState();
});

moveUpButton.addEventListener("click", () => {
  moveSelectionUp(selectedOptionValues(selectedStationsEl));
});

moveDownButton.addEventListener("click", () => {
  moveSelectionDown(selectedOptionValues(selectedStationsEl));
});

availableStationsEl.addEventListener("dblclick", () => {
  addKeys(selectedOptionValues(availableStationsEl));
});

selectedStationsEl.addEventListener("dblclick", () => {
  removeKeys(selectedOptionValues(selectedStationsEl));
});

saveSelectionButton.addEventListener("click", saveCurrentSelection);

renderSnapshot(initialSnapshot);
setInterval(refreshSnapshot, refreshSeconds * 1000);
