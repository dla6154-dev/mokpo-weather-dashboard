const initialSnapshot = window.__INITIAL_SNAPSHOT__ || {};
const refreshSeconds = window.__CLIENT_REFRESH_SECONDS__ || 30;

const bodyEl = document.getElementById("dashboard-body");
const generatedAtEl = document.getElementById("generated-at");
const staleBadgeEl = document.getElementById("stale-badge");
const statusMessageEl = document.getElementById("status-message");
const warningListEl = document.getElementById("warning-list");
const warningMapEl = document.getElementById("warning-map");
const commentaryMetaEl = document.getElementById("commentary-meta");
const commentaryBodyEl = document.getElementById("commentary-body");

function formatTimestamp(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ko-KR", { hour12: false });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function computeRowspans(rows, key) {
  const spans = new Array(rows.length).fill(0);
  let index = 0;
  while (index < rows.length) {
    const value = rows[index][key] || "";
    if (!value) {
      index += 1;
      continue;
    }
    let span = 1;
    let cursor = index + 1;
    while (cursor < rows.length && !(rows[cursor][key] || "")) {
      span += 1;
      cursor += 1;
    }
    spans[index] = span;
    index = cursor;
  }
  return spans;
}

function renderCell(row, spans, rowIndex, key, className) {
  const value = row[key] || "";
  if (!value) return "";
  const span = spans[key][rowIndex];
  const rowspan = span > 1 ? ` rowspan="${span}"` : "";
  return `<td class="${className}"${rowspan}>${escapeHtml(value)}</td>`;
}

function renderWarnings(warnings) {
  if (!warnings.length) {
    warningListEl.innerHTML = "<li>현재 표시할 특보가 없습니다.</li>";
    return;
  }

  warningListEl.innerHTML = warnings
    .map(
      (warning) => `
        <li>
          <div class="warning-region">${escapeHtml(warning.regionName)}</div>
          <div>${escapeHtml(`${warning.warningType} ${warning.level} ${warning.command}`)}</div>
          <div class="warning-meta">발표 ${escapeHtml(warning.issuedAt)} / 발효 ${escapeHtml(warning.effectiveAt)}</div>
          <div class="warning-meta">해제 ${escapeHtml(warning.endTimeText)}</div>
        </li>
      `,
    )
    .join("");
}

function renderRows(rows) {
  const spanKeys = [
    "displayGroup",
    "timeSlot",
    "forecastWindDirection",
    "forecastWindSpeed",
    "forecastWaveHeight",
    "forecastWeather",
  ];
  const spans = Object.fromEntries(spanKeys.map((key) => [key, computeRowspans(rows, key)]));

  bodyEl.innerHTML = rows
    .map((row, index) => {
      const special = row.specialWarnings && row.specialWarnings.length ? row.specialWarnings[0] : null;
      const warningType = special ? `${special.warningType} ${special.level}` : "";
      return `
        <tr>
          ${renderCell(row, spans, index, "displayGroup", "forecast")}
          <td class="forecast value">${escapeHtml(row.displaySubgroup || "")}</td>
          ${renderCell(row, spans, index, "timeSlot", "forecast")}
          ${renderCell(row, spans, index, "forecastWindDirection", "forecast value")}
          ${renderCell(row, spans, index, "forecastWindSpeed", "forecast value")}
          ${renderCell(row, spans, index, "forecastWaveHeight", "forecast value")}
          ${renderCell(row, spans, index, "forecastWeather", "forecast value")}
          <td class="warning-bg">${escapeHtml(warningType)}</td>
          <td class="warning-bg">${escapeHtml(special?.issuedAt || "")}</td>
          <td class="warning-bg">${escapeHtml(special?.effectiveAt || "")}</td>
          <td class="warning-bg">${escapeHtml(special?.endTimeText || "")}</td>
          <td class="observed value">${escapeHtml(row.sourceName || "")}</td>
          <td class="observed value">${escapeHtml(row.observedAt || "")}</td>
          <td class="observed value">${escapeHtml(row.observedWindDir || "")}</td>
          <td class="observed value">${escapeHtml([row.observedWindSpeed, row.gust].filter(Boolean).join(" / "))}</td>
          <td class="observed value">${escapeHtml([row.waveHeight, row.waveHeightMax, row.visibility].filter(Boolean).join(" / "))}</td>
        </tr>
      `;
    })
    .join("");
}

function renderCommentary(commentary) {
  commentaryMetaEl.textContent = `발표 ${commentary.issuedAt || "-"} / 예보관 ${commentary.forecaster || "-"}`;
  commentaryBodyEl.textContent = commentary.body || "표시할 예보 해설이 없습니다.";
}

function renderSnapshot(snapshot) {
  if (!snapshot || !snapshot.meta) {
    statusMessageEl.textContent = "스냅샷이 아직 준비되지 않았습니다.";
    return;
  }

  generatedAtEl.textContent = formatTimestamp(snapshot.meta.generatedAt);
  staleBadgeEl.textContent = snapshot.meta.stale ? "이전 데이터 유지 중" : "정상";
  staleBadgeEl.className = `badge ${snapshot.meta.stale ? "stale" : "ok"}`;
  statusMessageEl.textContent = snapshot.meta.stale
    ? snapshot.meta.staleReason || "갱신 실패로 마지막 정상 데이터를 유지 중입니다."
    : `자동 새로고침 ${refreshSeconds}초 / 데이터 갱신 ${snapshot.meta.refreshIntervalSeconds}초`;

  renderRows(snapshot.rows || []);
  renderWarnings(snapshot.warnings || []);
  renderCommentary(snapshot.commentary || {});

  if (snapshot.warningMapUrl) {
    warningMapEl.src = snapshot.warningMapUrl;
    warningMapEl.style.display = "";
  } else {
    warningMapEl.removeAttribute("src");
    warningMapEl.style.display = "none";
  }
}

async function refreshSnapshot() {
  try {
    const response = await fetch("/api/dashboard/snapshot", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const snapshot = await response.json();
    renderSnapshot(snapshot);
  } catch (error) {
    staleBadgeEl.textContent = "통신 실패";
    staleBadgeEl.className = "badge stale";
    statusMessageEl.textContent = `스냅샷 갱신 실패: ${error.message}`;
  }
}

renderSnapshot(initialSnapshot);
setInterval(refreshSnapshot, refreshSeconds * 1000);
