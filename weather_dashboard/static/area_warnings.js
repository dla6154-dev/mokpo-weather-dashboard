const initialSnapshot = window.__INITIAL_AREA_WARNING_SNAPSHOT__ || {};
const refreshSeconds = window.__CLIENT_REFRESH_SECONDS__ || 30;
const previewTm = String(window.__AREA_WARNING_TM__ || "").trim();
let defaultSelectionState = Array.isArray(window.__AREA_WARNING_DEFAULT_SELECTION__)
  ? [...window.__AREA_WARNING_DEFAULT_SELECTION__]
  : [];

const bodyEl = document.getElementById("area-warning-body");
const generatedAtEl = document.getElementById("generated-at");
const staleBadgeEl = document.getElementById("stale-badge");
const statusMessageEl = document.getElementById("status-message");
const selectionSummaryEl = document.getElementById("selection-summary");
const areaSearchEl = document.getElementById("area-search");
const availableAreasEl = document.getElementById("available-areas");
const selectedAreasEl = document.getElementById("selected-areas");
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

const PRELIMINARY_EFFECTIVE_LABELS = {
  "0259": "새벽(00-03시)",
  "0559": "새벽(03-06시)",
  "0859": "아침(06-09시)",
  "1159": "오전(09-12시)",
  "1459": "낮(12-15시)",
  "1759": "늦은 오후(15-18시)",
  "2059": "저녁(18-21시)",
  "2359": "밤(21-24시)",
  "1158": "오전(06-12시)",
  "1758": "오후(12-18시)",
  "0558": "새벽(00-06시)",
  "2358": "밤(18-24시)",
  "1458": "오후(12-18시)",
};

function parseCompactKst(value) {
  const text = String(value || "").trim();
  if (!/^\d{12}$/.test(text)) return null;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(4, 6));
  const day = Number(text.slice(6, 8));
  const hour = text.slice(8, 10);
  const minute = text.slice(10, 12);
  return { year, month, day, hour, minute, hhmm: `${hour}${minute}` };
}

function formatIssuedAt(value) {
  const parsed = parseCompactKst(value);
  if (!parsed) return value || "-";
  return `${parsed.month}. ${parsed.day}. ${parsed.hour}:${parsed.minute}`;
}

function formatEffectiveAt(value, level) {
  const parsed = parseCompactKst(value);
  if (!parsed) return value || "-";
  if (String(level || "").trim() === "예비") {
    const label = PRELIMINARY_EFFECTIVE_LABELS[parsed.hhmm];
    if (label) {
      return `${parsed.month}. ${parsed.day}. ${label}`;
    }
  }
  return `${parsed.month}. ${parsed.day}. ${parsed.hour}:${parsed.minute}`;
}

function isEffectiveAtOrBeforeNow(value) {
  const parsed = parseCompactKst(value);
  if (!parsed) return false;
  const now = new Date();
  const effective = new Date(parsed.year, parsed.month - 1, parsed.day, Number(parsed.hour), Number(parsed.minute), 0, 0);
  return effective.getTime() <= now.getTime();
}

function warningLevelKind(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.includes("예비")) return "preliminary";
  if (text.includes("경보")) return "alert";
  if (text.includes("주의")) return "advisory";
  return "";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function entryOptions(entries) {
  return [...entries].map((entry) => ({
    key: entry.selectionKey,
    label: entry.areaLabel || entry.warningRegion || entry.areaName || "(이름 없음)",
  }));
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

function ensureSelectionState(entries) {
  const keys = entryOptions(entries).map((item) => item.key);
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

function selectedEntries(entries) {
  if (!selectionState) return entries;
  const byKey = new Map(entries.map((entry) => [entry.selectionKey, entry]));
  return selectionState.map((key) => byKey.get(key)).filter(Boolean);
}

function availableOptions(entries) {
  const selected = selectionKeySet();
  return entryOptions(entries).filter((item) => {
    if (selected.has(item.key)) return false;
    if (!searchTerm) return true;
    return item.label.toLowerCase().includes(searchTerm);
  });
}

function selectedOptions(entries) {
  const byKey = new Map(entryOptions(entries).map((item) => [item.key, item]));
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

function flattenRows(entries) {
  const rows = [];
  for (const entry of entries) {
    if (!entry.warnings?.length) {
      rows.push({
        warningRegion: entry.warningRegion,
        status: "특보 없음",
        issuedAt: "",
        effectiveAt: "",
        endTimeText: "",
        level: "",
        warningType: "",
        rowClass: "",
        isEmpty: true,
      });
      continue;
    }
    for (const warning of entry.warnings) {
      const warningType = String(warning.warningType || "").trim();
      const level = String(warning.level || "").trim();
      const levelKind = warningLevelKind(level);
      const isEffective = isEffectiveAtOrBeforeNow(warning.effectiveAt || "");
      const isWavePreliminary =
        warningType === "풍랑" &&
        levelKind === "preliminary";
      const isWaveAdvisory =
        warningType === "풍랑" &&
        levelKind === "advisory" &&
        isEffective;
      const isWaveAlert =
        warningType === "풍랑" &&
        levelKind === "alert" &&
        isEffective;
      rows.push({
        warningRegion: entry.warningRegion,
        status: [warning.warningType, warning.level, warning.command].filter(Boolean).join(" "),
        issuedAt: warning.issuedAt || "",
        effectiveAt: warning.effectiveAt || "",
        endTimeText: warning.endTimeText || "",
        level: warning.level || "",
        warningType: warning.warningType || "",
        rowClass: isWaveAlert
          ? "warning-row-wave-alert"
          : isWaveAdvisory
            ? "warning-row-wave-advisory"
            : isWavePreliminary
              ? "warning-row-wave-preliminary"
              : "",
        isEmpty: false,
      });
    }
  }
  return rows;
}

function uniqueWarnings(entries) {
  const warnings = [];
  const seen = new Set();
  for (const entry of entries) {
    for (const warning of entry.warnings || []) {
      const key = [
        warning.regionName,
        warning.warningType,
        warning.level,
        warning.command,
        warning.issuedAt,
        warning.effectiveAt,
        warning.endTimeText,
      ].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      warnings.push(warning);
    }
  }
  return warnings;
}

function renderRows(entries) {
  const rows = flattenRows(entries);
  if (!rows.length) {
    bodyEl.innerHTML = `
      <tr>
        <td colspan="5" class="sheet-empty">선택한 해역이 없습니다.</td>
      </tr>
    `;
    return;
  }

  bodyEl.innerHTML = rows
    .map(
      (row) => `
        <tr class="${escapeHtml(row.rowClass || "")}">
          <td>${escapeHtml(row.warningRegion)}</td>
          <td class="${row.isEmpty ? "warning-none" : "warning-status"}">${escapeHtml(row.status)}</td>
          <td>${escapeHtml(row.issuedAt ? formatIssuedAt(row.issuedAt) : "-")}</td>
          <td>${escapeHtml(row.effectiveAt ? formatEffectiveAt(row.effectiveAt, row.level) : "-")}</td>
          <td>${escapeHtml(row.endTimeText || "-")}</td>
        </tr>
      `,
    )
    .join("");
}

function renderSelection(entries) {
  const allOptions = entryOptions(entries);
  const chosenOptions = selectedOptions(entries);
  const activeWarningCount = uniqueWarnings(selectedEntries(entries)).length;

  selectionSummaryEl.textContent = `전체 ${allOptions.length}개 / 선택 ${chosenOptions.length}개 / 활성 특보 ${activeWarningCount}건 / 기본 ${defaultSelectionState.length}개`;
  fillSelectOptions(availableAreasEl, availableOptions(entries));
  fillSelectOptions(selectedAreasEl, chosenOptions);
}

function renderSnapshot(snapshot) {
  if (!snapshot || !snapshot.meta) {
    statusMessageEl.textContent = "스냅샷이 아직 준비되지 않았습니다.";
    return;
  }

  latestSnapshot = snapshot;
  const entries = snapshot.entries || [];
  ensureSelectionState(entries);
  const visibleEntries = selectedEntries(entries);
  const visibleRows = flattenRows(visibleEntries);

  if (generatedAtEl) generatedAtEl.textContent = formatTimestamp(snapshot.meta.generatedAt);
  if (staleBadgeEl) {
    staleBadgeEl.textContent = snapshot.meta.stale ? "이전 데이터 유지 중" : "정상";
    staleBadgeEl.className = `badge ${snapshot.meta.stale ? "stale" : "ok"}`;
  }
  statusMessageEl.textContent = snapshot.meta.stale
    ? snapshot.meta.staleReason || "갱신 실패로 마지막 정상 데이터를 유지 중입니다."
    : `자동 새로고침 ${refreshSeconds}초 / 데이터 갱신 ${snapshot.meta.refreshIntervalSeconds}초 / 표시 ${visibleRows.length}건`;

  renderRows(visibleEntries);
  renderSelection(entries);
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
  restoreSelectedOptions(selectedAreasEl, keys);
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
  restoreSelectedOptions(selectedAreasEl, keys);
}

function restoreSelectedOptions(selectEl, keys) {
  const targets = new Set(keys);
  for (const option of selectEl.options) {
    option.selected = targets.has(option.value);
  }
}

async function saveCurrentSelection() {
  const selectedKeys = [...(selectionState || [])];
  saveSelectionButton.disabled = true;
  setSaveStatus("저장 중...");
  try {
    const response = await fetch("/api/area-warnings/preferences", {
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
      ? `/api/area-warnings/snapshot?tm=${encodeURIComponent(previewTm)}`
      : "/api/area-warnings/snapshot";
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

areaSearchEl.addEventListener("input", (event) => {
  searchTerm = String(event.target.value || "").trim().toLowerCase();
  renderSelection(latestSnapshot.entries || []);
});

addSelectedButton.addEventListener("click", () => {
  addKeys(selectedOptionValues(availableAreasEl));
});

addAllButton.addEventListener("click", () => {
  addKeys(availableOptions(latestSnapshot.entries || []).map((item) => item.key));
});

removeSelectedButton.addEventListener("click", () => {
  removeKeys(selectedOptionValues(selectedAreasEl));
});

removeAllButton.addEventListener("click", () => {
  selectionState = [];
  setSaveStatus("");
  rerenderFromState();
});

moveUpButton.addEventListener("click", () => {
  moveSelectionUp(selectedOptionValues(selectedAreasEl));
});

moveDownButton.addEventListener("click", () => {
  moveSelectionDown(selectedOptionValues(selectedAreasEl));
});

availableAreasEl.addEventListener("dblclick", () => {
  addKeys(selectedOptionValues(availableAreasEl));
});

selectedAreasEl.addEventListener("dblclick", () => {
  removeKeys(selectedOptionValues(selectedAreasEl));
});

saveSelectionButton.addEventListener("click", saveCurrentSelection);

renderSnapshot(initialSnapshot);
setInterval(refreshSnapshot, refreshSeconds * 1000);
