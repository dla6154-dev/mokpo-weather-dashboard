const snapshot = window.__INITIAL_TIDE_SNAPSHOT__ || {};
const refreshSeconds = Number(window.__CLIENT_REFRESH_SECONDS__ || 30);

const gridEl = document.getElementById("tide-table-preview-grid");
const generatedAtEl = document.getElementById("tide-table-preview-generated-at");
const noteEl = document.getElementById("tide-table-preview-note");

const STATION_ORDER = ["목포", "계마", "서망", "옥도", "향화", "암태"];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatLevel(value) {
  if (value == null || Number.isNaN(Number(value))) return "-";
  const rounded = Math.round(Number(value) * 10) / 10;
  return Number.isInteger(rounded) ? String(Math.trunc(rounded)) : rounded.toFixed(1);
}

function formatGeneratedAt(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}/${month}/${day} ${hour}:${minute}`;
}

function groupEntries(entries) {
  const map = new Map();
  for (const name of STATION_ORDER) {
    map.set(name, []);
  }
  for (const entry of entries || []) {
    const stationName = String(entry.stationName || "").trim();
    if (!map.has(stationName)) continue;
    map.get(stationName).push({
      tideType: String(entry.tideType || "").trim(),
      timeStr: String(entry.timeStr || "").trim(),
      levelCm: Number(entry.levelCm),
    });
  }
  for (const rows of map.values()) {
    rows.sort((a, b) => a.timeStr.localeCompare(b.timeStr));
  }
  return map;
}

function renderStationCard(stationName, rows) {
  if (!rows.length) {
    return `<article class="tide-table-card empty">
      <div class="tide-table-card-header">
        <h3>${escapeHtml(stationName)}</h3>
        <span class="tide-table-badge empty">데이터 없음</span>
      </div>
      <div class="tide-table-empty">현재 조석 API에 ${escapeHtml(stationName)} 값이 없습니다.</div>
    </article>`;
  }

  const body = rows
    .map((row) => {
      const tone = row.tideType === "고조" ? "high" : "low";
      return `<tr>
        <td class="tone ${tone}">${escapeHtml(row.tideType)}</td>
        <td>${escapeHtml(row.timeStr)}</td>
        <td>${escapeHtml(`${formatLevel(row.levelCm)}cm`)}</td>
      </tr>`;
    })
    .join("");

  return `<article class="tide-table-card">
    <div class="tide-table-card-header">
      <h3>${escapeHtml(stationName)}</h3>
      <span class="tide-table-badge">${rows.length}건</span>
    </div>
    <table class="tide-table-sheet">
      <thead>
        <tr>
          <th>물때</th>
          <th>시간</th>
          <th>조위</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  </article>`;
}

function renderPreview(data) {
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  const grouped = groupEntries(entries);
  if (generatedAtEl) generatedAtEl.textContent = formatGeneratedAt(data?.meta?.generatedAt);
  if (noteEl) noteEl.textContent = "현재 스냅샷 기준 6개 지점을 2열 표형 카드로 배치했습니다.";
  gridEl.innerHTML = STATION_ORDER.map((name) => renderStationCard(name, grouped.get(name) || [])).join("");
}

async function refreshSnapshot() {
  try {
    const response = await fetch("/api/tides/snapshot", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderPreview(await response.json());
  } catch (error) {
    if (noteEl) noteEl.textContent = `조석표 갱신 실패: ${error.message}`;
  }
}

renderPreview(snapshot);
setInterval(refreshSnapshot, refreshSeconds * 1000);
