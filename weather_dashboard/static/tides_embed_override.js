function tideEmbedIsHighType(value) {
  return String(value || "").includes("\uACE0");
}

function tideEmbedFormatRemainingClock(minutes) {
  const safeMinutes = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safeMinutes / 60);
  const mins = safeMinutes % 60;
  return `${String(hours).padStart(2, "0")}\uC2DC\uAC04 ${String(mins).padStart(2, "0")}\uBD84`;
}

function tideEmbedBuildGraphState(group, currentMinutes) {
  const state = getCycleState(group, currentMinutes);
  if (!state) {
    return null;
  }

  const points = (state.points || [])
    .filter((point) => point.minutes != null && !Number.isNaN(point.levelCm))
    .slice()
    .sort((a, b) => a.minutes - b.minutes);

  if (points.length < 2) {
    return null;
  }

  const span = Math.max(1, state.next.minutes - state.previous.minutes);
  const progress = Math.max(0, Math.min(1, (currentMinutes - state.previous.minutes) / span));
  const midpoint = (state.previous.levelCm + state.next.levelCm) / 2;
  const amplitude = (state.previous.levelCm - state.next.levelCm) / 2;
  const currentLevel = midpoint + amplitude * Math.cos(Math.PI * progress);

  return {
    ...state,
    points,
    currentLevel,
  };
}

function tideEmbedBuildGraphSvg(state) {
  const width = 720;
  const height = 260;
  const padding = { top: 30, right: 18, bottom: 56, left: 18 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const baseY = height - padding.bottom;
  const minutesToX = (minutes) => padding.left + (minutes / 1440) * plotWidth;
  const visibleMinutesToX = (minutes) => minutesToX(Math.max(0, Math.min(1440, minutes)));
  const levels = state.points.map((point) => point.levelCm);
  const minLevel = Math.min(...levels);
  const maxLevel = Math.max(...levels);
  const range = Math.max(1, maxLevel - minLevel);
  const levelToY = (level) => padding.top + ((maxLevel - level) / range) * plotHeight;
  const points = state.points.map((point) => ({
    ...point,
    x: visibleMinutesToX(point.minutes),
    y: levelToY(point.levelCm),
  }));
  const wrappedPoints = [
    { ...points[points.length - 1], minutes: points[points.length - 1].minutes - 1440 },
    ...points,
    { ...points[0], minutes: points[0].minutes + 1440 },
  ];

  const getCosineLevel = (fromLevel, toLevel, progress) => {
    const midpoint = (fromLevel + toLevel) / 2;
    const amplitude = (fromLevel - toLevel) / 2;
    return midpoint + amplitude * Math.cos(Math.PI * progress);
  };

  const buildSegmentSamples = (fromPoint, toPoint) => {
    const duration = Math.max(1, toPoint.minutes - fromPoint.minutes);
    const visibleStart = Math.max(0, fromPoint.minutes);
    const visibleEnd = Math.min(1440, toPoint.minutes);
    if (visibleStart > visibleEnd) {
      return [];
    }
    const tStart = (visibleStart - fromPoint.minutes) / duration;
    const tEnd = (visibleEnd - fromPoint.minutes) / duration;
    const segmentCount = Math.max(24, Math.ceil((visibleEnd - visibleStart) / 10));
    const samples = [];
    for (let step = 0; step <= segmentCount; step += 1) {
      const progress = tStart + (((tEnd - tStart) * step) / segmentCount);
      const minutes = fromPoint.minutes + duration * progress;
      const level = getCosineLevel(fromPoint.levelCm, toPoint.levelCm, progress);
      samples.push({
        x: visibleMinutesToX(minutes),
        y: levelToY(level),
      });
    }
    return samples;
  };

  const sampledCurve = [];
  wrappedPoints.forEach((point, index) => {
    if (index === wrappedPoints.length - 1) {
      return;
    }
    const segmentSamples = buildSegmentSamples(point, wrappedPoints[index + 1]);
    if (!segmentSamples.length) {
      return;
    }
    if (sampledCurve.length) {
      segmentSamples.shift();
    }
    sampledCurve.push(...segmentSamples);
  });

  const curvePath = sampledCurve.length
    ? `M ${sampledCurve.map((point) => `${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" L ")}`
    : "";
  const areaPath = sampledCurve.length
    ? `${curvePath} L ${sampledCurve[sampledCurve.length - 1].x.toFixed(2)} ${baseY} L ${sampledCurve[0].x.toFixed(2)} ${baseY} Z`
    : "";
  const currentX = visibleMinutesToX(state.currentMinutes);
  const currentDotY = levelToY(state.currentLevel);
  const tickMinutes = [0, 360, 720, 1080, 1440];
  const tickLabels = ["00", "06", "12", "18", "24"];
  const gradientId = `tide-embed-fill-${String(state.stationName || "station").replace(/[^\w-]/g, "-")}`;

  return `
    <svg viewBox="0 0 ${width} ${height}" class="tide-embed-graph-svg" role="img" aria-label="${escapeHtml(state.stationName)}">
      <defs>
        <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(59,130,246,0.26)"></stop>
          <stop offset="100%" stop-color="rgba(59,130,246,0.03)"></stop>
        </linearGradient>
      </defs>
      ${tickMinutes.map((tick, index) => `
        <g>
          <line x1="${visibleMinutesToX(tick)}" y1="${padding.top}" x2="${visibleMinutesToX(tick)}" y2="${baseY}" stroke="${tick === 0 || tick === 1440 ? "#e2e8f0" : "#edf2f7"}" stroke-width="2"></line>
          <text x="${visibleMinutesToX(tick)}" y="${height - 16}" text-anchor="${index === 0 ? "start" : index === tickMinutes.length - 1 ? "end" : "middle"}" font-size="13" font-weight="800" fill="#64748b">${tickLabels[index]}\uC2DC</text>
        </g>
      `).join("")}
      <line x1="${padding.left}" y1="${baseY}" x2="${width - padding.right}" y2="${baseY}" stroke="#cbd5e1" stroke-width="4" stroke-linecap="round"></line>
      <path d="${areaPath}" fill="url(#${gradientId})"></path>
      <path d="${curvePath}" fill="none" stroke="#0f4c81" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"></path>
      <line x1="${currentX}" y1="${padding.top - 6}" x2="${currentX}" y2="${baseY + 10}" stroke="#f59e0b" stroke-width="3" stroke-dasharray="6 6"></line>
      <text x="${currentX}" y="${padding.top - 10}" text-anchor="middle" font-size="13" font-weight="800" fill="#f59e0b">${escapeHtml(formatMinutes(state.currentMinutes))}</text>
      ${points.map((point) => {
        const isHigh = tideEmbedIsHighType(point.tideType);
        const labelY = isHigh ? point.y - 16 : point.y + 28;
        const levelColor = isHigh ? "#ef4444" : "#2563eb";
        return `
          <g>
            <circle cx="${point.x}" cy="${point.y}" r="7" fill="${levelColor}" stroke="#ffffff" stroke-width="4"></circle>
            <text x="${point.x}" y="${labelY}" text-anchor="middle" font-size="15" font-weight="800" fill="${levelColor}">${escapeHtml(`${formatLevel(point.levelCm)}cm`)}</text>
            <text x="${point.x}" y="${baseY + 26}" text-anchor="middle" font-size="13" font-weight="700" fill="#64748b">${escapeHtml(point.timeStr)}</text>
          </g>`;
      }).join("")}
      <circle cx="${currentX}" cy="${currentDotY}" r="8" fill="#f59e0b" stroke="#ffffff" stroke-width="4"></circle>
    </svg>`;
}

function renderMiniStationCard(group, index, currentMinutes) {
  const state = tideEmbedBuildGraphState(group, currentMinutes);
  if (!state) {
    return `<article class="tide-line-card tide-line-card-embed empty">
      <div class="tide-line-card-header">
        <span class="tide-line-station">${escapeHtml(group.stationName)}</span>
        <span class="tide-line-badge empty">-</span>
      </div>
      <div class="tide-table-empty">\uD604\uC7AC \uC870\uC11D \uAC12\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.</div>
    </article>`;
  }

  const countdownClass = tideEmbedIsHighType(state.nextLabel) ? "countdown-high" : "countdown-low";
  return `<article class="tide-line-card tide-line-card-embed tide-line-card-graph">
    <div class="tide-line-card-header tide-line-card-header-graph">
      <div class="tide-line-card-header-copy">
        <p class="tide-line-eyebrow">TIDE GRAPH</p>
        <span class="tide-line-station">${escapeHtml(group.stationName)}</span>
        <p class="tide-line-summary-text">\uD604\uC7AC ${escapeHtml(formatLevel(state.currentLevel))}cm · ${escapeHtml(state.phase)}</p>
      </div>
      <span class="tide-line-badge ${countdownClass}">${escapeHtml(`${state.nextLabel}\uAE4C\uC9C0 ${tideEmbedFormatRemainingClock(state.remainingMinutes)}`)}</span>
    </div>
    <div class="tide-embed-graph-wrap">
      ${tideEmbedBuildGraphSvg(state)}
    </div>
  </article>`;
}

if (typeof isEmbed !== "undefined" && isEmbed && typeof latestSnapshot !== "undefined") {
  renderSnapshot(latestSnapshot);
}
