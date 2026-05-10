const snapshot = window.__INITIAL_TIDE_SNAPSHOT__ || {};
const gridEl = document.getElementById("tide-size-preview-grid");

const TARGET_STATION = "목포";
const SVG_W = 620;
const MINI_PADDING = { left: 8, right: 8 };
const variants = [
  {
    id: "option-1",
    title: "1번 후보",
    subtitle: "조위·시간 11px",
    note: "현재 구성에서 조위와 시간만 11px로 맞춘 안입니다.",
    stationFont: 15,
    labelFont: 11,
    currentLabelFont: 10,
    currentValueFont: 13,
    rowHeight: 84,
    rightWidth: 126,
  },
  {
    id: "option-2",
    title: "2번 후보",
    subtitle: "조위·시간 12px",
    note: "조위와 시간만 12px로 키운 권장안입니다.",
    stationFont: 15,
    labelFont: 12,
    currentLabelFont: 10,
    currentValueFont: 13,
    rowHeight: 84,
    rightWidth: 126,
  },
  {
    id: "option-3",
    title: "3번 후보",
    subtitle: "조위·시간 13px",
    note: "조위와 시간만 13px로 키운 안입니다.",
    stationFont: 15,
    labelFont: 13,
    currentLabelFont: 10,
    currentValueFont: 13,
    rowHeight: 84,
    rightWidth: 126,
  },
  {
    id: "option-4",
    title: "4번 후보",
    subtitle: "조위·시간 14px",
    note: "조위와 시간만 14px로 키운 가장 큰 안입니다.",
    stationFont: 15,
    labelFont: 14,
    currentLabelFont: 10,
    currentValueFont: 13,
    rowHeight: 84,
    rightWidth: 126,
  },
];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatLevel(value) {
  if (value == null || Number.isNaN(value)) return "-";
  const rounded = Math.round(Number(value) * 10) / 10;
  return Number.isInteger(rounded) ? String(Math.trunc(rounded)) : rounded.toFixed(1);
}

function parseMinutes(timeStr) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr || "").trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function minuteOfDay(now = new Date()) {
  return now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
}

function groupMokpo(entries) {
  const points = [];
  for (const entry of entries || []) {
    if (String(entry.stationName || "").trim() !== TARGET_STATION) continue;
    const minutes = parseMinutes(entry.timeStr);
    const levelCm = Number(entry.levelCm);
    if (minutes == null || Number.isNaN(levelCm)) continue;
    points.push({
      stationName: TARGET_STATION,
      tideType: String(entry.tideType || ""),
      timeStr: String(entry.timeStr || ""),
      minutes,
      levelCm,
    });
  }
  points.sort((a, b) => a.minutes - b.minutes);
  return { stationName: TARGET_STATION, points };
}

function formatRemaining(nextTide, currentMinutes) {
  if (!nextTide || nextTide.minutes == null) return "데이터 없음";
  let diff = Math.round(nextTide.minutes - currentMinutes);
  if (diff < 0) diff += 1440;
  const hours = Math.floor(diff / 60);
  const minutes = diff % 60;
  return `${escapeHtml(nextTide.tideType)} ${hours}시간 ${minutes}분`;
}

function renderVariant(group, variant, currentMinutes) {
  const points = group.points.filter((point) => point.minutes != null && !Number.isNaN(point.levelCm));
  if (points.length < 2) {
    return `<article class="table-card tide-size-card">
      <div class="table-card-header">
        <div>
          <h2>${escapeHtml(variant.title)}</h2>
          <p>${escapeHtml(variant.subtitle)}</p>
        </div>
      </div>
      <div class="tide-size-card-body">
        <div class="tide-size-note">목포 조석 데이터가 아직 충분하지 않습니다.</div>
      </div>
    </article>`;
  }

  const svgH = variant.rowHeight;
  const baselineY = Math.round(svgH / 2);
  const levelY = Math.max(16, baselineY - 18);
  const timeY = Math.min(svgH - 8, baselineY + 24);
  const plotW = SVG_W - MINI_PADDING.left - MINI_PADDING.right;
  const scaleX = (minutes) => MINI_PADDING.left + (minutes / 1440) * plotW;
  const currentX = scaleX(currentMinutes);

  let nextTide = points.find((point) => point.minutes > currentMinutes);
  if (!nextTide) nextTide = points[0];

  const dotMarkup = points
    .map((point) => {
      const x = scaleX(point.minutes);
      const isHigh = point.tideType === "고조";
      const color = isHigh ? "#2563eb" : "#dc2626";
      return `
        <g>
          <circle cx="${x.toFixed(1)}" cy="${baselineY}" r="4.8" fill="${color}" stroke="#ffffff" stroke-width="1.5"></circle>
          <text x="${x.toFixed(1)}" y="${levelY}" class="tide-size-svg-label" fill="${color}" text-anchor="middle">${escapeHtml(`${formatLevel(point.levelCm)}cm`)}</text>
          <text x="${x.toFixed(1)}" y="${timeY}" class="tide-size-svg-label" fill="${color}" text-anchor="middle">${escapeHtml(point.timeStr)}</text>
        </g>`;
    })
    .join("");

  const arrowMarkup = `
    <polygon
      class="tide-size-arrow"
      points="${currentX.toFixed(1)},${(baselineY + 2).toFixed(1)} ${(currentX - 6).toFixed(1)},${(baselineY - 10).toFixed(1)} ${(currentX + 6).toFixed(1)},${(baselineY - 10).toFixed(1)}"
    ></polygon>`;

  return `<article class="table-card tide-size-card">
    <div class="table-card-header">
      <div>
        <h2>${escapeHtml(variant.title)}</h2>
        <p>${escapeHtml(variant.subtitle)}</p>
      </div>
    </div>
    <div class="tide-size-card-body">
      <div class="tide-size-spec">조위·시간 ${variant.labelFont}px / 지점명 15px / 남은 시간 값 13px / 행 높이 84px</div>
      <div class="tide-size-note">${escapeHtml(variant.note)}</div>
      <div
        class="tide-size-demo"
        style="--station-font:${variant.stationFont}px; --label-font:${variant.labelFont}px; --current-label-font:${variant.currentLabelFont}px; --current-value-font:${variant.currentValueFont}px; --row-height:${variant.rowHeight}px; --right-width:${variant.rightWidth}px;"
      >
        <h3 class="tide-size-station">${escapeHtml(group.stationName)}</h3>
        <svg class="tide-size-svg" viewBox="0 0 ${SVG_W} ${svgH}" role="img" aria-label="목포 조석표 미리보기">
          <line class="tide-size-line" x1="${MINI_PADDING.left}" y1="${baselineY}" x2="${SVG_W - MINI_PADDING.right}" y2="${baselineY}"></line>
          ${dotMarkup}
          ${arrowMarkup}
        </svg>
        <span class="tide-size-current">
          <span class="tide-size-current-label">남은 시간</span>
          <span class="tide-size-current-value">${formatRemaining(nextTide, currentMinutes)}</span>
        </span>
      </div>
    </div>
  </article>`;
}

function render() {
  if (!gridEl) return;
  const group = groupMokpo(snapshot.entries || []);
  const currentMinutes = minuteOfDay();
  gridEl.innerHTML = variants.map((variant) => renderVariant(group, variant, currentMinutes)).join("");
}

render();
