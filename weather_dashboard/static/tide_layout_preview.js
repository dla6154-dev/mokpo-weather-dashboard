const initialSnapshot = window.__INITIAL_TIDE_SNAPSHOT__ || {};
const refreshSeconds = window.__CLIENT_REFRESH_SECONDS__ || 300;

const previewGridEl = document.getElementById("tide-layout-preview-grid");
const previewGeneratedAtEl = document.getElementById("preview-generated-at");
const previewScopeEl = document.getElementById("preview-scope");

const DISPLAY_ORDER = ["목포", "서망", "계마"];
let latestSnapshot = initialSnapshot;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatGeneratedAt(value) {
  if (!value) return "-";
  const text = String(value);
  const compact = text.replaceAll(/[^0-9]/g, "");
  if (compact.length >= 12) {
    return `${compact.slice(0, 4)}/${compact.slice(4, 6)}/${compact.slice(6, 8)} ${compact.slice(8, 10)}:${compact.slice(10, 12)}`;
  }
  return text;
}

function parseMinutes(timeStr) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr || "").trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatRemaining(minutes) {
  const safeMinutes = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safeMinutes / 60);
  const mins = safeMinutes % 60;
  if (hours > 0 && mins > 0) return `${hours}시간 ${mins}분`;
  if (hours > 0) return `${hours}시간`;
  return `${mins}분`;
}

function formatLevel(value) {
  if (value == null || Number.isNaN(value)) return "-";
  const rounded = Math.round(Number(value) * 10) / 10;
  return Number.isInteger(rounded) ? String(Math.trunc(rounded)) : rounded.toFixed(1);
}

function countdownToneClass(nextLabel) {
  return nextLabel === "고조" ? "countdown-high" : "countdown-low";
}

function minuteOfDay(now = new Date()) {
  return now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
}

function groupEntries(entries) {
  const grouped = new Map();
  for (const entry of entries || []) {
    const stationName = String(entry.stationName || "").trim();
    const minutes = parseMinutes(entry.timeStr);
    const levelCm = Number(entry.levelCm);
    if (!stationName || minutes == null || Number.isNaN(levelCm)) continue;
    if (!grouped.has(stationName)) {
      grouped.set(stationName, []);
    }
    grouped.get(stationName).push({
      stationName,
      tideType: String(entry.tideType || ""),
      timeStr: String(entry.timeStr || ""),
      minutes,
      levelCm,
    });
  }

  return DISPLAY_ORDER.map((stationName) => {
    const points = grouped.get(stationName) || [];
    points.sort((a, b) => a.minutes - b.minutes);
    return { stationName, points };
  }).filter((group) => group.points.length);
}

function getCycleState(group, currentMinutes) {
  const points = group.points || [];
  if (points.length < 2) return null;

  let previous = null;
  let next = null;
  for (const point of points) {
    if (point.minutes <= currentMinutes) previous = point;
    if (point.minutes > currentMinutes && next == null) next = point;
  }

  if (!previous) {
    previous = { ...points[points.length - 1], minutes: points[points.length - 1].minutes - 1440 };
  }
  if (!next) {
    next = { ...points[0], minutes: points[0].minutes + 1440 };
  }

  const span = Math.max(1, next.minutes - previous.minutes);
  const elapsed = Math.max(0, currentMinutes - previous.minutes);
  const ratio = Math.max(0, Math.min(1, elapsed / span));
  const currentLevel = previous.levelCm + (next.levelCm - previous.levelCm) * ratio;
  const phase = next.tideType === "고조" ? "밀물" : "썰물";
  const nextLabel = next.tideType === "고조" ? "고조" : "저조";

  return {
    stationName: group.stationName,
    points,
    previous,
    next,
    ratio,
    currentLevel,
    phase,
    nextLabel,
    currentMinutes,
    remainingMinutes: next.minutes - currentMinutes,
  };
}

function renderRail(state, modifier = "") {
  const currentLeft = Math.max(0, Math.min(100, (state.currentMinutes / 1440) * 100));
  const dotMarkup = state.points
    .map((point) => {
      const left = (point.minutes / 1440) * 100;
      const isHigh = point.tideType === "고조";
      const isPast = point.minutes < state.currentMinutes;
      return `<div class="tide-preview-tick ${modifier} ${isPast ? "past" : "future"}" style="left:${left}%">
        <span class="tide-preview-dot ${isHigh ? "high" : "low"}"></span>
        <span class="tide-preview-dot-level ${isHigh ? "high" : "low"}">${escapeHtml(`${formatLevel(point.levelCm)}cm`)}</span>
        <span class="tide-preview-dot-time">${escapeHtml(point.timeStr)}</span>
      </div>`;
    })
    .join("");

  return `<div class="tide-preview-rail-wrap ${modifier}">
    <div class="tide-preview-rail"></div>
    <div class="tide-preview-progress" style="left:0%; width:${currentLeft.toFixed(2)}%"></div>
    ${dotMarkup}
    <div class="tide-preview-now ${modifier}" style="left:${currentLeft}%">
      <span class="tide-preview-now-label">현재</span>
      <span class="tide-preview-now-line"></span>
    </div>
  </div>`;
}

function renderFixedPlayheadRail(state, windowMinutes = 16 * 60) {
  const halfWindow = windowMinutes / 2;
  const windowStart = state.currentMinutes - halfWindow;
  const windowEnd = windowStart + windowMinutes;
  const expandedPoints = [];

  for (const point of state.points) {
    for (const offset of [-1440, 0, 1440]) {
      expandedPoints.push({
        ...point,
        displayMinutes: point.minutes + offset,
      });
    }
  }

  const dotMarkup = expandedPoints
    .filter((point) => point.displayMinutes >= windowStart && point.displayMinutes <= windowEnd)
    .map((point) => {
      const left = ((point.displayMinutes - windowStart) / windowMinutes) * 100;
      const isHigh = point.tideType === "고조";
      const isPast = point.displayMinutes < state.currentMinutes;
      return `<div class="tide-preview-tick playhead ${isPast ? "past" : "future"}" style="left:${left}%">
        <span class="tide-preview-dot ${isHigh ? "high" : "low"}"></span>
        <span class="tide-preview-dot-level ${isHigh ? "high" : "low"}">${escapeHtml(`${formatLevel(point.levelCm)}cm`)}</span>
        <span class="tide-preview-dot-time">${escapeHtml(point.timeStr)}</span>
      </div>`;
    })
    .join("");

  return `<div class="tide-preview-rail-wrap playhead">
    <div class="tide-preview-rail"></div>
    <div class="tide-preview-progress playhead" style="left:0%; width:50%"></div>
    ${dotMarkup}
    <div class="tide-preview-now fixed" style="left:50%">
      <span class="tide-preview-now-label">현재</span>
      <span class="tide-preview-now-line"></span>
    </div>
  </div>`;
}

function renderRowOptionA(state) {
  const countdownClass = countdownToneClass(state.nextLabel);
  return `<div class="overview-tide-row option-a">
    <div class="overview-tide-station">${escapeHtml(state.stationName)}</div>
    <div class="overview-tide-main">
      <div class="overview-tide-inline">
        <span class="overview-tide-phase-pill">${escapeHtml(state.phase)}</span>
        <strong class="overview-tide-level">${escapeHtml(`${formatLevel(state.currentLevel)}cm`)}</strong>
        <span class="overview-tide-meta ${countdownClass}">${escapeHtml(`${state.nextLabel}까지 ${formatRemaining(state.remainingMinutes)}`)}</span>
      </div>
      ${renderRail(state, "compact")}
    </div>
    <div class="overview-tide-side">
      <span>다음 ${escapeHtml(state.nextLabel)}</span>
      <strong>${escapeHtml(state.next.timeStr)}</strong>
      <em>${escapeHtml(`${formatLevel(state.next.levelCm)}cm`)}</em>
    </div>
  </div>`;
}

function renderRowOptionB(state) {
  const countdownClass = countdownToneClass(state.nextLabel);
  return `<div class="overview-tide-row option-b">
    <div class="overview-tide-station">${escapeHtml(state.stationName)}</div>
    <div class="overview-tide-main">
      ${renderRail(state, "compact")}
    </div>
    <div class="overview-tide-side emphasis">
      <span>${escapeHtml(state.phase)}</span>
      <strong class="${countdownClass}">${escapeHtml(formatRemaining(state.remainingMinutes))}</strong>
      <em>${escapeHtml(`현재 ${formatLevel(state.currentLevel)}cm`)}</em>
    </div>
  </div>`;
}

function renderRowOptionC(state) {
  return `<div class="overview-tide-row option-c">
    <div class="overview-tide-station">${escapeHtml(state.stationName)}</div>
    <div class="overview-tide-main stacked">
      <div class="overview-tide-topband">
        <strong>${escapeHtml(`${formatLevel(state.currentLevel)}cm`)}</strong>
        <span>${escapeHtml(`${state.phase} / ${state.nextLabel} ${state.next.timeStr} / ${formatRemaining(state.remainingMinutes)}`)}</span>
      </div>
      <div class="overview-tide-chipline">
        ${state.points
          .map((point) => {
            const isHigh = point.tideType === "고조";
            return `<span class="overview-tide-chip ${isHigh ? "high" : "low"}">${escapeHtml(`${point.tideType} ${point.timeStr} ${formatLevel(point.levelCm)}cm`)}</span>`;
          })
          .join("")}
      </div>
    </div>
  </div>`;
}

function renderRowOptionD(state) {
  const countdownClass = countdownToneClass(state.nextLabel);
  return `<div class="overview-tide-row option-d">
    <div class="overview-tide-station">${escapeHtml(state.stationName)}</div>
    <div class="overview-tide-main">
      <div class="overview-tide-inline">
        <strong class="overview-tide-level">${escapeHtml(`${formatLevel(state.currentLevel)}cm`)}</strong>
        <span class="overview-tide-meta ${countdownClass}">${escapeHtml(`${state.phase} / ${state.nextLabel}까지 ${formatRemaining(state.remainingMinutes)}`)}</span>
      </div>
      ${renderFixedPlayheadRail(state)}
    </div>
  </div>`;
}

function renderRowOptionE(state) {
  const countdownClass = countdownToneClass(state.nextLabel);
  return `<div class="overview-tide-row option-e">
    <div class="overview-tide-station">${escapeHtml(state.stationName)}</div>
    <div class="overview-tide-main">
      <div class="overview-tide-inline">
        <strong class="overview-tide-level">${escapeHtml(`${formatLevel(state.currentLevel)}cm`)}</strong>
        <span class="overview-tide-meta ${countdownClass}">${escapeHtml(`${state.phase} / ${state.nextLabel}까지 ${formatRemaining(state.remainingMinutes)}`)}</span>
      </div>
      ${renderFixedPlayheadRail(state)}
    </div>
  </div>`;
}

function renderOptionCard(label, title, desc, states, rowRenderer, options = {}) {
  const layoutClass = options.layoutClass ? ` ${options.layoutClass}` : "";
  const sharedNowMarkup =
    options.sharedNowLeft == null
      ? ""
      : `<div class="tide-preview-shared-now${options.sharedNowMode ? ` ${options.sharedNowMode}` : ""}" style="left:${options.sharedNowLeft}%">
          <span class="tide-preview-shared-now-label">현재</span>
          <span class="tide-preview-shared-now-line"></span>
        </div>`;
  return `<article class="table-card tide-preview-option">
    <div class="table-card-header tide-preview-option-header">
      <div>
        <p class="eyebrow">${escapeHtml(label)}</p>
        <h2>${escapeHtml(title)}</h2>
        <p class="tide-preview-option-copy">${escapeHtml(desc)}</p>
      </div>
    </div>
    <div class="tide-preview-option-body">
      <div class="overview-tide-mock${layoutClass}">
        ${states.map((state) => rowRenderer(state)).join("")}
        ${sharedNowMarkup}
      </div>
    </div>
  </article>`;
}

function renderPreview(snapshot) {
  latestSnapshot = snapshot || {};
  const currentMinutes = minuteOfDay();
  const groups = groupEntries(latestSnapshot.entries || []);
  const states = groups.map((group) => getCycleState(group, currentMinutes)).filter(Boolean);

  if (!states.length) {
    previewGridEl.innerHTML = `<div class="tide-empty-state">조석 데이터가 없습니다.</div>`;
    return;
  }

  if (previewScopeEl) previewScopeEl.textContent = "기상종합 3개 지점";
  if (previewGeneratedAtEl) previewGeneratedAtEl.textContent = formatGeneratedAt(latestSnapshot.meta?.generatedAt);
  const currentLeft = Math.max(0, Math.min(100, (currentMinutes / 1440) * 100)).toFixed(2);

  previewGridEl.innerHTML = [
    renderOptionCard("시안 1", "현 상태 개선형", "현재 조위와 남은 시간을 한 줄에서 가장 빨리 읽는 방식입니다.", states, renderRowOptionA),
    renderOptionCard("시안 2", "남은 시간 강조형", "현재가 언제 끝나는지가 먼저 보이게 한 운영형입니다.", states, renderRowOptionB),
    renderOptionCard("시안 3", "이벤트 카드형", "고조/저조 4포인트를 카드처럼 읽고 싶은 경우에 맞습니다.", states, renderRowOptionC),
    renderOptionCard("시안 4", "가장 압축된 형", "기상종합 패널 높이를 가장 적게 쓰는 쪽입니다.", states, renderRowOptionD, {
      layoutClass: "shared-now-layout shared-now-playhead",
      sharedNowLeft: "50",
      sharedNowMode: "playhead",
    }),
    renderOptionCard("시안 5", "고정 플레이헤드형", "현재는 고정하고 조석선과 시각이 오른쪽에서 왼쪽으로 흐르는 방식입니다.", states, renderRowOptionE, {
      layoutClass: "shared-now-layout shared-now-playhead",
      sharedNowLeft: "50",
      sharedNowMode: "playhead",
    }),
  ].join("");
}

async function refreshSnapshot() {
  try {
    const response = await fetch("/api/tides/snapshot", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderPreview(await response.json());
  } catch (error) {
    console.error("Failed to refresh tide preview snapshot", error);
  }
}

renderPreview(initialSnapshot);
setInterval(refreshSnapshot, refreshSeconds * 1000);
setInterval(() => renderPreview(latestSnapshot), 60 * 1000);
