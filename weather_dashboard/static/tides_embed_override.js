function tideEmbedIsHighType(value) {
  return String(value || "").includes("고");
}

function tideEmbedFormatRemainingClock(minutes) {
  const safeMinutes = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safeMinutes / 60);
  const mins = safeMinutes % 60;
  return `${String(hours).padStart(2, "0")}시${String(mins).padStart(2, "0")}분`;
}

function getActiveEmbedTideIndex(points, currentMinutes) {
  if (!points.length) {
    return null;
  }

  for (let index = 0; index < points.length; index += 1) {
    if (points[index].minutes > currentMinutes) {
      return index;
    }
  }

  return 0;
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

  const countdownClass = tideEmbedIsHighType(state.nextLabel) ? "countdown-high" : "countdown-low";
  return `<article class="tide-line-card tide-line-card-embed">
    <div class="tide-line-card-header">
      <span class="tide-line-station">${escapeHtml(group.stationName)}</span>
      <span class="tide-line-badge ${countdownClass}">${escapeHtml(`${state.nextLabel}까지 ${tideEmbedFormatRemainingClock(state.remainingMinutes)}`)}</span>
    </div>
    <div class="tide-line-summary">
      <strong class="tide-line-level">${escapeHtml(`${formatLevel(state.currentLevel)}cm`)}</strong>
      <span class="tide-line-phase ${countdownClass}">${escapeHtml(state.phase)}</span>
    </div>
    ${renderDayRail(state)}
  </article>`;
}

if (typeof isEmbed !== "undefined" && isEmbed && typeof latestSnapshot !== "undefined") {
  renderSnapshot(latestSnapshot);
}
