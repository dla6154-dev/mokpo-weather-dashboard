const splitEl = document.getElementById("overview-split");
const dividerEl = document.getElementById("overview-divider");
const serverLayout = window.__OVERVIEW_LAYOUT__ || {};
const stackEl = document.getElementById("overview-pane-stack");
const hDividerEl = document.getElementById("overview-h-divider");
const topPaneEl = stackEl?.querySelector(".overview-subpane-top");
const bottomPaneEl = stackEl?.querySelector(".overview-subpane-bottom");
const leftTitleEl = document.getElementById("overview-left-title");
const rightTitleEl = document.getElementById("overview-right-title");
const overviewRefreshSeconds = Number(window.__CLIENT_REFRESH_SECONDS__ || 30);

const STORAGE_SPLIT = "overview-left-pct";
const PCT_MIN = 10;
const PCT_MAX = 90;
const STACK_BREAKPOINT = 720;
const TOP_MIN_PX = 96;
const TOP_MAX_PX = 220;
const TOP_MIN_RATIO = 0.18;
const BOTTOM_MIN_PX = 140;
const BOTTOM_MAX_PX = 280;
const BOTTOM_MIN_RATIO = 0.28;

let splitDragRaf = 0;
let splitDragPendingPct = null;
let topDragRaf = 0;
let topDragPendingPx = null;

function isStackedLayout() {
  return window.matchMedia(`(max-width: ${STACK_BREAKPOINT}px)`).matches;
}

function clampPct(value) {
  return Math.min(Math.max(Math.round(value), PCT_MIN), PCT_MAX);
}

function formatOverviewTitleTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}/${day} ${hour}:${minute}`;
}

function setOverviewPaneTitle(element, baseTitle, generatedAt) {
  if (!element) return;
  const formatted = formatOverviewTitleTime(generatedAt);
  element.textContent = formatted ? `${baseTitle}(${formatted})` : baseTitle;
}

function scheduleSplitPct(value) {
  splitDragPendingPct = value;
  if (splitDragRaf) {
    return;
  }
  splitDragRaf = window.requestAnimationFrame(() => {
    if (splitDragPendingPct != null) {
      setPct(splitDragPendingPct, false);
    }
    splitDragPendingPct = null;
    splitDragRaf = 0;
  });
}

function scheduleTopHeight(px) {
  topDragPendingPx = px;
  if (topDragRaf) {
    return;
  }
  topDragRaf = window.requestAnimationFrame(() => {
    if (topDragPendingPx != null) {
      setTopH(topDragPendingPx, false);
    }
    topDragPendingPx = null;
    topDragRaf = 0;
  });
}

async function refreshOverviewPaneTitles() {
  try {
    const [areaResponse, query1Response] = await Promise.all([
      fetch("/api/area-warnings/snapshot", { cache: "no-store" }),
      fetch("/api/query1/snapshot", { cache: "no-store" }),
    ]);
    if (!areaResponse.ok || !query1Response.ok) {
      throw new Error(`HTTP ${areaResponse.status}/${query1Response.status}`);
    }
    const [areaSnapshot, query1Snapshot] = await Promise.all([
      areaResponse.json(),
      query1Response.json(),
    ]);
    setOverviewPaneTitle(leftTitleEl, "해역별 기상특보", areaSnapshot?.meta?.generatedAt);
    setOverviewPaneTitle(rightTitleEl, "기상정보", query1Snapshot?.meta?.generatedAt);
  } catch (_) {
    setOverviewPaneTitle(leftTitleEl, "해역별 기상특보", "");
    setOverviewPaneTitle(rightTitleEl, "기상정보", "");
  }
}

function setPct(value, persist = false) {
  if (!splitEl || !dividerEl) {
    return;
  }
  const clamped = clampPct(value);
  splitEl.style.setProperty("--left-pane-pct", `${clamped}%`);
  dividerEl.setAttribute("aria-valuenow", String(clamped));
  if (persist) {
    localStorage.setItem(STORAGE_SPLIT, String(clamped));
  }
}

function restoreSavedPct() {
  const saved = Number(localStorage.getItem(STORAGE_SPLIT));
  if (Number.isFinite(saved) && saved >= PCT_MIN && saved <= PCT_MAX) {
    setPct(saved);
  } else if (Number.isFinite(serverLayout.leftPct)) {
    setPct(serverLayout.leftPct);
  }
}

function startDrag(event) {
  if (!splitEl || !dividerEl || isStackedLayout()) {
    return;
  }
  event.preventDefault();
  splitEl.classList.add("is-resizing");
  dividerEl.setPointerCapture?.(event.pointerId);
  const rect = splitEl.getBoundingClientRect();

  function onMove(moveEvent) {
    scheduleSplitPct(((moveEvent.clientX - rect.left) / rect.width) * 100);
  }

  function onUp(upEvent) {
    if (upEvent?.clientX != null) {
      setPct(((upEvent.clientX - rect.left) / rect.width) * 100, true);
    }
    splitEl.classList.remove("is-resizing");
    dividerEl.releasePointerCapture?.(event.pointerId);
    dividerEl.removeEventListener("pointermove", onMove);
    dividerEl.removeEventListener("pointerup", onUp);
    dividerEl.removeEventListener("pointercancel", onUp);
  }

  dividerEl.addEventListener("pointermove", onMove);
  dividerEl.addEventListener("pointerup", onUp);
  dividerEl.addEventListener("pointercancel", onUp);
}

function startMouseDrag(event) {
  if (!splitEl || !dividerEl || isStackedLayout()) {
    return;
  }
  event.preventDefault();
  splitEl.classList.add("is-resizing");
  const rect = splitEl.getBoundingClientRect();

  function onMove(moveEvent) {
    scheduleSplitPct(((moveEvent.clientX - rect.left) / rect.width) * 100);
  }

  function onUp(upEvent) {
    setPct(((upEvent.clientX - rect.left) / rect.width) * 100, true);
    splitEl.classList.remove("is-resizing");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  }

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function onSplitKeydown(event) {
  if (!splitEl || !dividerEl) {
    return;
  }
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
    return;
  }
  event.preventDefault();
  const current = Number.parseFloat(
    getComputedStyle(splitEl).getPropertyValue("--left-pane-pct") || "40",
  );
  setPct(current + (event.key === "ArrowLeft" ? -1 : 1), true);
}

const ZOOM_STEP = 0.01;
const ZOOM_MIN = 0.15;
const ZOOM_MAX = 2.0;
const QUERY1_ZOOM_STORAGE = "overview-zoom-right";

function loadSavedZoom() {
  const value = Number(localStorage.getItem(QUERY1_ZOOM_STORAGE));
  if (Number.isFinite(value) && value >= ZOOM_MIN && value <= ZOOM_MAX) return value;
  const sv = Number(serverLayout.rightZoom);
  return Number.isFinite(sv) && sv >= ZOOM_MIN && sv <= ZOOM_MAX ? sv : null;
}

function updateZoomLabel(zoom) {
  const labelEl = document.getElementById("zoom-val-right");
  if (labelEl) {
    labelEl.textContent = `${Math.round(zoom * 100)}%`;
  }
}

function updateNamedZoomLabel(elementId, zoom) {
  const labelEl = document.getElementById(elementId);
  if (labelEl) {
    labelEl.textContent = `${Math.round(zoom * 100)}%`;
  }
}

function applyZoom(frame, zoom) {
  try {
    if (frame?.contentDocument?.body) {
      frame.contentDocument.body.style.zoom = zoom.toFixed(3);
    }
  } catch (_) {}
}

function applyTidesZoom(frame, zoom) {
  try {
    if (frame?.contentDocument?.body) {
      frame.style.transform = "";
      frame.style.transformOrigin = "";
      frame.style.width = "";
      frame.style.height = "";
      frame.contentDocument.body.style.zoom = zoom.toFixed(3);
    }
  } catch (_) {}
}

function calcFitZoom(frame, paneEl) {
  const doc = frame.contentDocument;
  if (!doc?.body) {
    return 1;
  }
  const body = doc.body;
  body.style.zoom = "";
  void body.offsetHeight;
  const header = doc.querySelector(".table-card-header");
  const table = doc.querySelector(".sheet-table");
  const headerHeight = header ? header.getBoundingClientRect().height : 0;
  const naturalWidth = table ? table.scrollWidth : Math.max(body.scrollWidth, body.getBoundingClientRect().width || 0);
  const naturalHeight = table
    ? headerHeight + table.scrollHeight + 36
    : Math.max(body.scrollHeight, body.getBoundingClientRect().height || 0);
  const { width: paneWidth, height: paneHeight } = paneEl.getBoundingClientRect();
  if (!naturalWidth || !paneWidth) {
    return 1;
  }
  return Math.max(ZOOM_MIN, Math.min(paneWidth / naturalWidth, paneHeight / naturalHeight));
}

const LEFT_ZOOM_STORAGE = "overview-zoom-left";
const BOTTOM_ZOOM_STORAGE = "overview-zoom-bottom-v4";

function setupAreaWarningsZoom() {
  const paneEl = stackEl?.querySelector(".overview-subpane-top");
  const frameEl = document.getElementById("overview-left-frame");
  if (!paneEl || !frameEl) return;

  let currentZoom = (() => {
    const v = Number(localStorage.getItem(LEFT_ZOOM_STORAGE));
    if (Number.isFinite(v) && v >= ZOOM_MIN && v <= ZOOM_MAX) return v;
    const sv = Number(serverLayout.leftZoom);
    return Number.isFinite(sv) && sv >= ZOOM_MIN && sv <= ZOOM_MAX ? sv : 1;
  })();

  const labelEl = document.getElementById("zoom-val-left");

  function setZoom(zoom, persist = true) {
    currentZoom = Math.min(Math.max(zoom, ZOOM_MIN), ZOOM_MAX);
    applyZoom(frameEl, currentZoom);
    if (labelEl) labelEl.textContent = `${Math.round(currentZoom * 100)}%`;
    if (persist) localStorage.setItem(LEFT_ZOOM_STORAGE, currentZoom.toFixed(3));
  }

  frameEl.addEventListener("load", () => {
    setTimeout(() => {
      const saved = Number(localStorage.getItem(LEFT_ZOOM_STORAGE));
      if (Number.isFinite(saved) && saved >= ZOOM_MIN && saved <= ZOOM_MAX) {
        setZoom(saved, false);
      } else {
        setZoom(calcFitZoom(frameEl, paneEl));
      }
    }, 600);
  });

  document.getElementById("zoom-dec-left")?.addEventListener("click", () => setZoom(currentZoom - ZOOM_STEP));
  document.getElementById("zoom-inc-left")?.addEventListener("click", () => setZoom(currentZoom + ZOOM_STEP));
}

function setupQuery1Zoom() {
  const paneEl = splitEl?.querySelector(".overview-pane:last-child");
  const frameEl = document.getElementById("overview-right-frame");
  if (!paneEl || !frameEl) {
    return;
  }

  let currentZoom = loadSavedZoom() ?? 1;

  function setZoom(zoom, persist = true) {
    currentZoom = Math.min(Math.max(zoom, ZOOM_MIN), ZOOM_MAX);
    applyZoom(frameEl, currentZoom);
    updateZoomLabel(currentZoom);
    if (persist) {
      localStorage.setItem(QUERY1_ZOOM_STORAGE, currentZoom.toFixed(3));
    }
  }

  frameEl.addEventListener("load", () => {
    setTimeout(() => {
      const savedZoom = loadSavedZoom();
      if (savedZoom == null) {
        setZoom(calcFitZoom(frameEl, paneEl));
      } else {
        setZoom(savedZoom, false);
      }
    }, 600);
  });

  document.getElementById("zoom-dec-right")?.addEventListener("click", () => {
    setZoom(currentZoom - ZOOM_STEP);
  });
  document.getElementById("zoom-inc-right")?.addEventListener("click", () => {
    setZoom(currentZoom + ZOOM_STEP);
  });
}

function setupTidesZoom() {
  const paneEl = bottomPaneEl;
  const frameEl = document.getElementById("overview-bottom-frame");
  if (!paneEl || !frameEl) return;

  let currentZoom = (() => {
    const value = Number(localStorage.getItem(BOTTOM_ZOOM_STORAGE));
    if (Number.isFinite(value) && value >= ZOOM_MIN && value <= ZOOM_MAX) return value;
    const savedValue = Number(serverLayout.bottomZoom);
    return Number.isFinite(savedValue) && savedValue >= ZOOM_MIN && savedValue <= ZOOM_MAX ? savedValue : 1;
  })();

  function setZoom(zoom, persist = true) {
    currentZoom = Math.min(Math.max(zoom, ZOOM_MIN), ZOOM_MAX);
    applyTidesZoom(frameEl, currentZoom);
    updateNamedZoomLabel("zoom-val-bottom", currentZoom);
    if (persist) {
      localStorage.setItem(BOTTOM_ZOOM_STORAGE, currentZoom.toFixed(3));
    }
  }

  frameEl.addEventListener("load", () => {
    setTimeout(() => {
      const savedZoom = Number(localStorage.getItem(BOTTOM_ZOOM_STORAGE));
      if (Number.isFinite(savedZoom) && savedZoom >= ZOOM_MIN && savedZoom <= ZOOM_MAX) {
        setZoom(savedZoom, false);
      } else {
        setZoom(calcFitZoom(frameEl, paneEl));
      }
    }, 600);
  });

  document.getElementById("zoom-dec-bottom")?.addEventListener("click", () => {
    setZoom(currentZoom - ZOOM_STEP);
  });
  document.getElementById("zoom-inc-bottom")?.addEventListener("click", () => {
    setZoom(currentZoom + ZOOM_STEP);
  });
}

if (splitEl && dividerEl) {
  restoreSavedPct();
  dividerEl.addEventListener("pointerdown", startDrag);
  dividerEl.addEventListener("mousedown", startMouseDrag);
  dividerEl.addEventListener("keydown", onSplitKeydown);
  dividerEl.addEventListener("dblclick", () => {
    splitEl.style.removeProperty("--left-pane-pct");
    localStorage.removeItem(STORAGE_SPLIT);
  });
  setupAreaWarningsZoom();
  setupQuery1Zoom();
  setupTidesZoom();
}

refreshOverviewPaneTitles();
setInterval(refreshOverviewPaneTitles, overviewRefreshSeconds * 1000);

// ── 위아래 분할 ──────────────────────────────────────────
const STORAGE_TOP_H = "overview-top-height-px-v2";
const DEFAULT_TOP_H = 200;

function getAvailableH() {
  if (!stackEl) return 0;
  const style = getComputedStyle(stackEl);
  const pt = Number.parseFloat(style.paddingTop) || 0;
  const pb = Number.parseFloat(style.paddingBottom) || 0;
  const divH = hDividerEl ? hDividerEl.getBoundingClientRect().height || 10 : 10;
  return stackEl.getBoundingClientRect().height - pt - pb - divH;
}

function setTopH(px, persist = false) {
  if (!topPaneEl) return;
  const available = getAvailableH();
  const min = Math.max(TOP_MIN_PX, Math.min(TOP_MAX_PX, available * TOP_MIN_RATIO));
  const minBottom = Math.max(BOTTOM_MIN_PX, Math.min(BOTTOM_MAX_PX, available * BOTTOM_MIN_RATIO));
  const max = Math.max(min, available - minBottom);
  const clamped = Math.min(Math.max(Math.round(px), min), max);
  topPaneEl.style.height = `${clamped}px`;
  if (persist) localStorage.setItem(STORAGE_TOP_H, String(clamped));
}

function restoreSavedTopH() {
  const saved = Number(localStorage.getItem(STORAGE_TOP_H));
  if (Number.isFinite(saved) && saved > 0) {
    setTopH(saved);
  } else if (Number.isFinite(serverLayout.topHeightPx) && serverLayout.topHeightPx > 0) {
    setTopH(serverLayout.topHeightPx);
  }
}

function startHDrag(event) {
  if (!stackEl || !topPaneEl) return;
  event.preventDefault();
  hDividerEl.setPointerCapture(event.pointerId);
  const rect = stackEl.getBoundingClientRect();
  const pt = Number.parseFloat(getComputedStyle(stackEl).paddingTop) || 0;

  function onMove(e) {
    scheduleTopHeight(e.clientY - rect.top - pt);
  }
  function onUp(e) {
    setTopH(e.clientY - rect.top - pt, true);
    hDividerEl.removeEventListener("pointermove", onMove);
    hDividerEl.removeEventListener("pointerup", onUp);
    hDividerEl.removeEventListener("pointercancel", onUp);
  }

  hDividerEl.addEventListener("pointermove", onMove);
  hDividerEl.addEventListener("pointerup", onUp);
  hDividerEl.addEventListener("pointercancel", onUp);
}

function startHMouseDrag(event) {
  if (!stackEl || !topPaneEl) return;
  event.preventDefault();
  const rect = stackEl.getBoundingClientRect();
  const pt = Number.parseFloat(getComputedStyle(stackEl).paddingTop) || 0;

  function onMove(e) {
    scheduleTopHeight(e.clientY - rect.top - pt);
  }

  function onUp(e) {
    setTopH(e.clientY - rect.top - pt, true);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  }

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function onHDividerKeydown(event) {
  if (!topPaneEl) return;
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  event.preventDefault();
  setTopH(topPaneEl.getBoundingClientRect().height + (event.key === "ArrowUp" ? -10 : 10), true);
}

if (stackEl && hDividerEl && topPaneEl) {
  restoreSavedTopH();
  hDividerEl.addEventListener("pointerdown", startHDrag);
  hDividerEl.addEventListener("mousedown", startHMouseDrag);
  hDividerEl.addEventListener("keydown", onHDividerKeydown);
  hDividerEl.addEventListener("dblclick", () => {
    topPaneEl.style.height = `${DEFAULT_TOP_H}px`;
    localStorage.removeItem(STORAGE_TOP_H);
  });
}

window.addEventListener("resize", () => {
  if (topPaneEl) {
    setTopH(topPaneEl.getBoundingClientRect().height, false);
  }
});

// ── 설정 저장 ────────────────────────────────────────────
const saveBtn = document.getElementById("save-layout-btn");
if (saveBtn) {
  saveBtn.addEventListener("click", async () => {
    const leftPct = Number.parseFloat(
      getComputedStyle(splitEl).getPropertyValue("--left-pane-pct") || "40",
    );
    const topHeightPx = topPaneEl ? topPaneEl.getBoundingClientRect().height : DEFAULT_TOP_H;
    const rightZoom = Number(localStorage.getItem(QUERY1_ZOOM_STORAGE)) || 1.0;
    const leftZoom = Number(localStorage.getItem(LEFT_ZOOM_STORAGE)) || 1.0;
    const bottomZoom = Number(localStorage.getItem(BOTTOM_ZOOM_STORAGE)) || 1.0;

    saveBtn.disabled = true;
    saveBtn.textContent = "저장 중…";
    try {
      await fetch("/api/overview/layout", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leftPct, topHeightPx, rightZoom, leftZoom, bottomZoom }),
      });
      saveBtn.textContent = "저장 완료";
      setTimeout(() => { saveBtn.textContent = "설정 저장"; saveBtn.disabled = false; }, 1500);
    } catch {
      saveBtn.textContent = "저장 실패";
      setTimeout(() => { saveBtn.textContent = "설정 저장"; saveBtn.disabled = false; }, 1500);
    }
  });
}
