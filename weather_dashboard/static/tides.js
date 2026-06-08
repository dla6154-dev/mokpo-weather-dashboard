const initialSnapshot = window.__INITIAL_TIDE_SNAPSHOT__ || {};
const refreshSeconds = window.__CLIENT_REFRESH_SECONDS__ || 3600;
const isEmbed = window.__TIDES_EMBED__ === true || window.__TIDES_EMBED__ === "true";

const gridEl = document.getElementById("tide-grid");
const statusMessageEl = document.getElementById("status-message");
const staleBadgeEl = document.getElementById("stale-badge");
const dateStrEl = document.getElementById("date-str");
const dateLabelEl = document.getElementById("date-label");

const FULL_SVG_WIDTH = 620;
const FULL_SVG_HEIGHT = 318;
const FULL_PADDING = { top: 50, right: 28, bottom: 42, left: 52 };
const X_TICKS = [0, 360, 720, 1080, 1440];
const ACTIVE_DISPLAY_STATIONS = isEmbed
  ? ["목포", "계마", "서망"]
  : ["목포", "암태", "향화", "옥도", "서망", "계마"];

const SHIPINFO_TIDE_DISPLAY_STATIONS = ["서망", "진도옥도", "쉬미", "서거차도"];

let latestSnapshot = initialSnapshot;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatLevel(value) {
  if (value == null || Number.isNaN(value)) {
    return "-";
  }
  const rounded = Math.round(Number(value) * 10) / 10;
  return Number.isInteger(rounded) ? String(Math.trunc(rounded)) : rounded.toFixed(1);
}

function parseMinutes(timeStr) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr || "").trim());
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatMinutes(minutes) {
  const safeMinutes = Math.max(0, Math.min(1440, Math.round(minutes)));
  const hh = Math.floor(safeMinutes / 60);
  const mm = safeMinutes % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function minuteOfDay(now = new Date()) {
  return now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
}

function formatRemainingMinutes(minutes) {
  const safeMinutes = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safeMinutes / 60);
  const mins = safeMinutes % 60;
  if (hours > 0 && mins > 0) return `${hours}시간 ${mins}분`;
  if (hours > 0) return `${hours}시간`;
  return `${mins}분`;
}

function groupEntries(entries) {
  const map = new Map();
  for (const stationName of SHIPINFO_TIDE_DISPLAY_STATIONS) {
    map.set(stationName, { stationName, points: [] });
  }

  for (const entry of entries || []) {
    const stationName = String(entry.stationName || "").trim();
    if (!map.has(stationName)) {
      continue;
    }
    const minutes = parseMinutes(entry.timeStr);
    const levelCm = Number(entry.levelCm);
    if (minutes == null || Number.isNaN(levelCm)) {
      continue;
    }
    map.get(stationName).points.push({
      stationName,
      tideType: String(entry.tideType || ""),
      timeStr: String(entry.timeStr || ""),
      minutes,
      levelCm,
    });
  }

  return SHIPINFO_TIDE_DISPLAY_STATIONS.map((stationName) => {
    const group = map.get(stationName);
    group.points.sort((a, b) => a.minutes - b.minutes);
    return group;
  });
}

function buildExtendedSeries(points) {
  if (points.length <= 1) {
    return points.map((point) => ({ ...point, virtual: false }));
  }

  const series = points.map((point) => ({ ...point, virtual: false }));
  const firstGap = Math.max(60, series[1].minutes - series[0].minutes);
  const lastGap = Math.max(60, series[series.length - 1].minutes - series[series.length - 2].minutes);

  return [
    {
      stationName: series[0].stationName,
      tideType: series[1].tideType,
      timeStr: "",
      minutes: series[0].minutes - firstGap,
      levelCm: series[1].levelCm,
      virtual: true,
    },
    ...series,
    {
      stationName: series[series.length - 1].stationName,
      tideType: series[series.length - 2].tideType,
      timeStr: "",
      minutes: series[series.length - 1].minutes + lastGap,
      levelCm: series[series.length - 2].levelCm,
      virtual: true,
    },
  ];
}

function niceStep(rawStep) {
  const exponent = Math.floor(Math.log10(rawStep));
  const base = 10 ** exponent;
  const fraction = rawStep / base;
  if (fraction <= 1) return base;
  if (fraction <= 2) return 2 * base;
  if (fraction <= 5) return 5 * base;
  return 10 * base;
}

function buildYAxisTicks(minValue, maxValue, targetCount = 6) {
  const span = Math.max(1, maxValue - minValue);
  const step = niceStep(span / targetCount);
  const start = Math.floor(minValue / step) * step;
  const loopLimit = Math.ceil(maxValue / step) * step;
  const ticks = [];
  for (let value = start; value <= loopLimit + step * 0.5; value += step) {
    if (value >= minValue - step * 0.25 && value <= maxValue + step * 0.001) {
      ticks.push(value);
    }
  }
  return ticks;
}

function createChartGeometry(series, realPoints, padding, width, height) {
  const minLevel = Math.min(...realPoints.map((point) => point.levelCm));
  const maxLevel = Math.max(...realPoints.map((point) => point.levelCm));
  const spread = Math.max(80, maxLevel - minLevel);
  const yPadding = Math.max(30, spread * 0.18);
  const chartMin = Math.floor((minLevel - yPadding) / 10) * 10;
  const chartMax = Math.ceil((maxLevel + yPadding) / 10) * 10;

  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const scaleX = (minutes) => padding.left + (minutes / 1440) * plotWidth;
  const scaleY = (level) => padding.top + ((chartMax - level) / (chartMax - chartMin)) * plotHeight;
  const levelFromY = (y) => chartMax - ((y - padding.top) / plotHeight) * (chartMax - chartMin);

  return {
    chartMin,
    chartMax,
    plotWidth,
    plotHeight,
    scaleX,
    scaleY,
    levelFromY,
    svgPoints: series.map((point) => ({ ...point, x: scaleX(point.minutes), y: scaleY(point.levelCm) })),
  };
}

function computeMonotoneTangents(points) {
  if (points.length < 2) {
    return [];
  }

  const slopes = new Array(points.length - 1);
  const tangents = new Array(points.length);

  for (let index = 0; index < points.length - 1; index += 1) {
    const dx = points[index + 1].x - points[index].x || 1;
    slopes[index] = (points[index + 1].y - points[index].y) / dx;
  }

  tangents[0] = slopes[0];
  tangents[points.length - 1] = slopes[slopes.length - 1];

  for (let index = 1; index < points.length - 1; index += 1) {
    tangents[index] =
      slopes[index - 1] * slopes[index] <= 0
        ? 0
        : (slopes[index - 1] + slopes[index]) / 2;
  }

  for (let index = 0; index < slopes.length; index += 1) {
    if (Math.abs(slopes[index]) < 1e-9) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      continue;
    }

    const a = tangents[index] / slopes[index];
    const b = tangents[index + 1] / slopes[index];
    const magnitude = a * a + b * b;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangents[index] = scale * a * slopes[index];
      tangents[index + 1] = scale * b * slopes[index];
    }
  }

  return tangents;
}

function buildSplinePath(points, tangents) {
  if (!points.length) {
    return "";
  }
  let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const dx = next.x - current.x;
    const cp1x = current.x + dx / 3;
    const cp1y = current.y + (tangents[index] * dx) / 3;
    const cp2x = next.x - dx / 3;
    const cp2y = next.y - (tangents[index + 1] * dx) / 3;
    path += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${next.x.toFixed(2)} ${next.y.toFixed(2)}`;
  }
  return path;
}

function evaluateSpline(points, tangents, targetX) {
  if (points.length < 2) {
    return null;
  }
  let segmentIndex = points.length - 2;
  if (targetX <= points[0].x) {
    segmentIndex = 0;
  } else if (targetX >= points[points.length - 1].x) {
    segmentIndex = points.length - 2;
  } else {
    for (let index = 0; index < points.length - 1; index += 1) {
      if (targetX >= points[index].x && targetX <= points[index + 1].x) {
        segmentIndex = index;
        break;
      }
    }
  }

  const current = points[segmentIndex];
  const next = points[segmentIndex + 1];
  const dx = next.x - current.x || 1;
  const t = Math.max(0, Math.min(1, (targetX - current.x) / dx));
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return {
    x: targetX,
    y:
      h00 * current.y +
      h10 * dx * tangents[segmentIndex] +
      h01 * next.y +
      h11 * dx * tangents[segmentIndex + 1],
  };
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

  return {
    stationName: group.stationName,
    points,
    previous,
    next,
    ratio,
    currentLevel,
    phase: next.tideType === "고조" ? "밀물" : "썰물",
    nextLabel: next.tideType === "고조" ? "고조" : "저조",
    currentMinutes,
    remainingMinutes: next.minutes - currentMinutes,
  };
}

function countdownToneClass(nextLabel) {
  return nextLabel === "고조" ? "countdown-high" : "countdown-low";
}

function renderDayRail(state) {
  const currentLeft = Math.max(0, Math.min(100, (state.currentMinutes / 1440) * 100));
  const dotMarkup = state.points
    .map((point) => {
      const left = (point.minutes / 1440) * 100;
      const isHigh = point.tideType === "고조";
      const isPast = point.minutes < state.currentMinutes;
      return `<div class="tide-preview-tick embed-compact ${isPast ? "past" : "future"}" style="left:${left}%">
        <span class="tide-preview-dot ${isHigh ? "high" : "low"}"></span>
        <span class="tide-preview-dot-level ${isHigh ? "high" : "low"}">${escapeHtml(`${formatLevel(point.levelCm)}cm`)}</span>
        <span class="tide-preview-dot-time">${escapeHtml(point.timeStr)}</span>
      </div>`;
    })
    .join("");

  return `<div class="tide-preview-rail-wrap embed-compact">
    <div class="tide-preview-rail"></div>
    <div class="tide-preview-progress" style="left:0%; width:${currentLeft.toFixed(2)}%"></div>
    ${dotMarkup}
    <div class="tide-preview-now embed-compact" style="left:${currentLeft}%">
      <span class="tide-preview-now-label">현재</span>
      <span class="tide-preview-now-line"></span>
    </div>
  </div>`;
}

function renderFullStationCard(group, index, currentMinutes) {
  const realPoints = group.points.filter((point) => point.minutes != null && !Number.isNaN(point.levelCm));
  if (realPoints.length < 2) {
    return `<article class="tide-chart-card tide-chart-empty-card">
      <header class="tide-chart-card-header"><div><h3>${escapeHtml(group.stationName)}</h3><p>유효한 조석 자료가 부족합니다.</p></div></header>
    </article>`;
  }

  const series = buildExtendedSeries(realPoints);
  const geometry = createChartGeometry(series, realPoints, FULL_PADDING, FULL_SVG_WIDTH, FULL_SVG_HEIGHT);
  const tangents = computeMonotoneTangents(geometry.svgPoints);
  const pathData = buildSplinePath(geometry.svgPoints, tangents);
  const clipId = `tide-clip-${index}`;
  const currentX = geometry.scaleX(currentMinutes);
  const currentPoint = evaluateSpline(geometry.svgPoints, tangents, currentX);
  const currentLevel = currentPoint ? geometry.levelFromY(currentPoint.y) : null;
  const labelX = Math.max(FULL_PADDING.left + 26, Math.min(FULL_SVG_WIDTH - FULL_PADDING.right - 28, currentX));
  const actualMaxLevel = Math.max(...realPoints.map((point) => point.levelCm));
  const yTicks = buildYAxisTicks(geometry.chartMin, actualMaxLevel, 6);

  const xGuides = X_TICKS.map((minutes) => {
    const x = geometry.scaleX(minutes);
    return `<g>
      <line class="tide-grid-line" x1="${x.toFixed(2)}" y1="${FULL_PADDING.top}" x2="${x.toFixed(2)}" y2="${FULL_SVG_HEIGHT - FULL_PADDING.bottom}" />
      <text class="tide-axis-text" x="${x.toFixed(2)}" y="${FULL_SVG_HEIGHT - 12}" text-anchor="middle">${escapeHtml(formatMinutes(minutes))}</text>
    </g>`;
  }).join("");

  const yGuides = yTicks.map((level) => {
    const y = geometry.scaleY(level);
    return `<g>
      <line class="tide-grid-line tide-grid-line-horizontal" x1="${FULL_PADDING.left}" y1="${y.toFixed(2)}" x2="${FULL_SVG_WIDTH - FULL_PADDING.right}" y2="${y.toFixed(2)}" />
      <text class="tide-axis-text tide-axis-text-left" x="${FULL_PADDING.left - 10}" y="${(y + 4).toFixed(2)}" text-anchor="end">${escapeHtml(`${formatLevel(level)}cm`)}</text>
    </g>`;
  }).join("");

  const pointMarkup = geometry.svgPoints
    .filter((point) => !point.virtual)
    .map((point) => {
      const isHigh = point.tideType === "고조";
      const textY = isHigh ? Math.max(22, point.y - 16) : Math.min(FULL_SVG_HEIGHT - 10, point.y + 24);
      return `<g>
        <circle class="${isHigh ? "tide-point-high" : "tide-point-low"}" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="4.5" />
        <text class="${isHigh ? "tide-point-label tide-point-label-high" : "tide-point-label tide-point-label-low"}" x="${point.x.toFixed(2)}" y="${textY.toFixed(2)}" text-anchor="middle">${escapeHtml(`${point.timeStr} / ${formatLevel(point.levelCm)}cm`)}</text>
      </g>`;
    })
    .join("");

  const currentMarkerMarkup = currentPoint
    ? `<g>
        <line class="tide-now-line" x1="${currentX.toFixed(2)}" y1="34" x2="${currentX.toFixed(2)}" y2="${FULL_SVG_HEIGHT - FULL_PADDING.bottom}" />
        <circle class="tide-now-dot" cx="${currentX.toFixed(2)}" cy="${currentPoint.y.toFixed(2)}" r="4.5" />
        <text class="tide-now-tag" x="${labelX.toFixed(2)}" y="16" text-anchor="middle">현재</text>
        <text class="tide-now-level" x="${labelX.toFixed(2)}" y="30" text-anchor="middle">${escapeHtml(`${formatLevel(currentLevel)}cm`)}</text>
      </g>`
    : "";

  return `<article class="tide-chart-card">
    <header class="tide-chart-card-header"><div><h3>${escapeHtml(group.stationName)}</h3></div></header>
    <div class="tide-chart-wrap">
      <svg class="tide-chart-svg" viewBox="0 0 ${FULL_SVG_WIDTH} ${FULL_SVG_HEIGHT}" role="img" aria-label="${escapeHtml(group.stationName)} 조석 곡선">
        <defs><clipPath id="${clipId}"><rect x="${FULL_PADDING.left}" y="${FULL_PADDING.top}" width="${geometry.plotWidth}" height="${geometry.plotHeight}" rx="10" ry="10"></rect></clipPath></defs>
        <rect class="tide-plot-bg" x="${FULL_PADDING.left}" y="${FULL_PADDING.top}" width="${geometry.plotWidth}" height="${geometry.plotHeight}" rx="14" ry="14"></rect>
        ${yGuides}
        ${xGuides}
        <g clip-path="url(#${clipId})"><path class="tide-curve-path" d="${pathData}"></path></g>
        ${currentMarkerMarkup}
        ${pointMarkup}
      </svg>
    </div>
  </article>`;
}

function renderMiniStationCard(group, index, currentMinutes) {
  const state = getCycleState(group, currentMinutes);
  if (!state) {
    return `<article class="tide-line-card tide-line-card-embed empty">
      <div class="tide-line-card-header">
        <span class="tide-line-station">${escapeHtml(group.stationName)}</span>
        <span class="tide-line-badge empty">-</span>
      </div>
      <div class="tide-table-empty">현재 조석 값이 없습니다.</div>
    </article>`;
  }

  const countdownClass = countdownToneClass(state.nextLabel);
  return `<article class="tide-line-card tide-line-card-embed">
    <div class="tide-line-card-header">
      <span class="tide-line-station">${escapeHtml(group.stationName)}</span>
      <span class="tide-line-badge ${countdownClass}">${escapeHtml(`${state.nextLabel}까지 ${formatRemainingMinutes(state.remainingMinutes)}`)}</span>
    </div>
    <div class="tide-line-summary">
      <strong class="tide-line-level">${escapeHtml(`${formatLevel(state.currentLevel)}cm`)}</strong>
      <span class="tide-line-phase ${countdownClass}">${escapeHtml(state.phase)}</span>
    </div>
    ${renderDayRail(state)}
  </article>`;
}

function renderSnapshot(snapshot) {
  latestSnapshot = snapshot || {};
  if (!latestSnapshot.meta) {
    if (statusMessageEl) {
      statusMessageEl.textContent = "조석 데이터가 아직 준비되지 않았습니다.";
    }
    if (gridEl) {
      gridEl.innerHTML = `<div class="tide-empty-state">조석 데이터를 기다리는 중입니다.</div>`;
    }
    return;
  }

  const groups = groupEntries(latestSnapshot.entries || []);
  const dateStr = latestSnapshot.dateStr || "";
  const currentMinutes = minuteOfDay();

  if (dateStrEl) {
    dateStrEl.textContent = dateStr || "-";
  }
  if (dateLabelEl) {
    dateLabelEl.textContent = dateStr ? `${dateStr} 조석 곡선` : "오늘의 조석 곡선";
  }
  if (staleBadgeEl) {
    staleBadgeEl.textContent = latestSnapshot.meta.stale ? "이전 데이터 유지 중" : "정상";
    staleBadgeEl.className = `badge ${latestSnapshot.meta.stale ? "stale" : "ok"}`;
  }
  if (statusMessageEl) {
    statusMessageEl.textContent = latestSnapshot.meta.stale
      ? latestSnapshot.meta.staleReason || "마지막 정상 데이터를 표시 중입니다."
      : `${dateStr} 기준 ${groups.filter((group) => group.points.length).length}개 지점`;
  }

  if (gridEl) {
    gridEl.classList.toggle("tide-card-grid-embed", isEmbed);
  }

  const visibleGroups = groups.filter((group) => group.points.length);
  if (!visibleGroups.length) {
    gridEl.innerHTML = `<div class="tide-empty-state">선택한 지점의 조석 데이터가 없습니다.</div>`;
    return;
  }

  const cards = groups.map((group, index) =>
    isEmbed ? renderMiniStationCard(group, index, currentMinutes) : renderFullStationCard(group, index, currentMinutes),
  );

  gridEl.innerHTML = cards.join("");
}

async function refreshSnapshot() {
  try {
    const response = await fetch("/api/tides/snapshot", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    renderSnapshot(await response.json());
  } catch (error) {
    if (staleBadgeEl) {
      staleBadgeEl.textContent = "통신 실패";
      staleBadgeEl.className = "badge stale";
    }
    if (statusMessageEl) {
      statusMessageEl.textContent = `조석 갱신 실패: ${error.message}`;
    }
  }
}

function getActiveEmbedTideIndex(points, currentMinutes) {
  if (!points.length) {
    return null;
  }

  let activeIndex = 0;
  for (let index = 0; index < points.length; index += 1) {
    if (points[index].minutes <= currentMinutes) {
      activeIndex = index;
    } else {
      break;
    }
  }

  return activeIndex;
}

function renderMiniStationCard(group, index, currentMinutes) {
  const points = (group.points || [])
    .slice()
    .sort((a, b) => a.minutes - b.minutes)
    .slice(0, 4);

  if (!points.length) {
    return `<article class="tide-table-card tide-table-card-embed empty">
      <div class="tide-table-card-header">
        <h3>${escapeHtml(group.stationName)}</h3>
      </div>
      <div class="tide-table-empty">?꾩옱 議곗꽍 媛믪씠 ?놁뒿?덈떎.</div>
    </article>`;
  }

  const activeIndex = getActiveEmbedTideIndex(points, currentMinutes);
  const labelCells = points
    .map((point, pointIndex) => {
      const toneClass = point.tideType === "怨좎“" ? "high" : "low";
      const activeClass = pointIndex === activeIndex ? ` active ${toneClass}` : "";
      return `<td class="tide-embed-cell tide-embed-label-cell${activeClass}">${escapeHtml(point.tideType)}</td>`;
    })
    .join("");

  const valueCells = points
    .map((point, pointIndex) => {
      const toneClass = point.tideType === "怨좎“" ? "high" : "low";
      const activeClass = pointIndex === activeIndex ? ` active ${toneClass}` : "";
      return `<td class="tide-embed-cell tide-embed-value-cell${activeClass}">
        <span class="tide-embed-time">${escapeHtml(point.timeStr)}</span>
        <span class="tide-embed-level">${escapeHtml(`${formatLevel(point.levelCm)}cm`)}</span>
      </td>`;
    })
    .join("");

  return `<article class="tide-table-card tide-table-card-embed">
    <div class="tide-table-card-header">
      <h3>${escapeHtml(group.stationName)}</h3>
    </div>
    <table class="tide-table-sheet tide-table-sheet-embed-grid" aria-label="${escapeHtml(group.stationName)} 議곗꽍 ?쒓컙?쒗몴">
      <tbody>
        <tr>${labelCells}</tr>
        <tr>${valueCells}</tr>
      </tbody>
    </table>
  </article>`;
}

renderSnapshot(initialSnapshot);
setInterval(refreshSnapshot, refreshSeconds * 1000);
setInterval(() => renderSnapshot(latestSnapshot), 60 * 1000);
