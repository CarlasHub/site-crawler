(() => {
  const APP_ORIGIN = "https://site-crawler-989268314020.europe-west2.run.app";
  const ROOT_ID = "cat-crawler-root";
  const PANEL_MIN_WIDTH = 320;
  const PANEL_MIN_HEIGHT = 280;
  const PANEL_MARGIN = 16;
  const BUTTON_SIZE = 56;
  const BUTTON_GAP = 16;
  const BAR_HEIGHT = 44;
  const existing = document.getElementById(ROOT_ID);

  if (existing) {
    if (typeof existing.__catCrawlerCleanup === "function") {
      existing.__catCrawlerCleanup();
    } else {
      existing.remove();
    }
    return;
  }

  const root = document.createElement("div");
  root.id = ROOT_ID;
  const controller = new AbortController();
  const { signal } = controller;

  const style = document.createElement("style");
  style.textContent = `
    #${ROOT_ID} {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
      pointer-events: none;
    }
    #${ROOT_ID} .cat-crawler-button,
    #${ROOT_ID} .cat-crawler-panel {
      pointer-events: auto;
    }
    #${ROOT_ID} .cat-crawler-button {
      position: fixed;
      right: ${BUTTON_GAP}px;
      bottom: ${BUTTON_GAP}px;
      width: ${BUTTON_SIZE}px;
      height: ${BUTTON_SIZE}px;
      border-radius: 999px;
      border: 2px solid #1a1a1a;
      background: #0f0f0f url("${APP_ORIGIN}/cat.png") center / cover no-repeat;
      box-shadow: 0 8px 24px rgba(0,0,0,0.35);
      cursor: pointer;
    }
    #${ROOT_ID} .cat-crawler-panel {
      position: fixed;
      display: none;
      border-radius: 16px;
      border: 1px solid rgba(0,0,0,0.2);
      background: #0b0b0b;
      box-shadow: 0 18px 48px rgba(0,0,0,0.45);
      overflow: hidden;
      min-width: ${PANEL_MIN_WIDTH}px;
      min-height: ${PANEL_MIN_HEIGHT}px;
    }
    #${ROOT_ID} .cat-crawler-panel.is-open {
      display: block;
    }
    #${ROOT_ID} .cat-crawler-panel.is-dragging,
    #${ROOT_ID} .cat-crawler-panel.is-resizing {
      user-select: none;
    }
    #${ROOT_ID} .cat-crawler-panel.is-dragging iframe,
    #${ROOT_ID} .cat-crawler-panel.is-resizing iframe {
      pointer-events: none;
    }
    #${ROOT_ID} .cat-crawler-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      height: ${BAR_HEIGHT}px;
      padding: 10px 12px;
      box-sizing: border-box;
      background: #111;
      color: #fff;
      font-weight: 700;
      font-size: 13px;
      cursor: move;
      touch-action: none;
    }
    #${ROOT_ID} .cat-crawler-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #${ROOT_ID} .cat-crawler-close {
      border: 1px solid rgba(255,255,255,0.2);
      background: transparent;
      color: #fff;
      padding: 6px 10px;
      border-radius: 10px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      flex: 0 0 auto;
    }
    #${ROOT_ID} iframe {
      width: 100%;
      height: calc(100% - ${BAR_HEIGHT}px);
      border: 0;
      background: #0b0b0b;
      display: block;
    }
    #${ROOT_ID} .cat-crawler-handle {
      position: absolute;
      width: 16px;
      height: 16px;
      z-index: 2;
      touch-action: none;
    }
    #${ROOT_ID} .cat-crawler-handle::before {
      content: "";
      position: absolute;
      inset: 4px;
      border-radius: 999px;
      background: rgba(255,255,255,0.92);
      box-shadow: 0 0 0 1px rgba(0,0,0,0.25);
      opacity: 0.8;
    }
    #${ROOT_ID} .cat-crawler-handle-nw { top: -8px; left: -8px; cursor: nwse-resize; }
    #${ROOT_ID} .cat-crawler-handle-ne { top: -8px; right: -8px; cursor: nesw-resize; }
    #${ROOT_ID} .cat-crawler-handle-sw { bottom: -8px; left: -8px; cursor: nesw-resize; }
    #${ROOT_ID} .cat-crawler-handle-se { bottom: -8px; right: -8px; cursor: nwse-resize; }
  `;

  const button = document.createElement("button");
  button.className = "cat-crawler-button";
  button.title = "Cat Crawler";
  button.type = "button";

  const panel = document.createElement("div");
  panel.className = "cat-crawler-panel";

  const bar = document.createElement("div");
  bar.className = "cat-crawler-bar";

  const title = document.createElement("div");
  title.className = "cat-crawler-title";
  title.textContent = "Cat Crawler";

  const closeBtn = document.createElement("button");
  closeBtn.className = "cat-crawler-close";
  closeBtn.type = "button";
  closeBtn.textContent = "Close";

  const iframe = document.createElement("iframe");
  const targetUrl = encodeURIComponent(window.location.href);
  iframe.src = `${APP_ORIGIN}/?mode=bookmarklet&url=${targetUrl}`;
  iframe.title = "Cat Crawler";

  const state = {
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    mode: "",
    handle: "",
    pointerId: null,
    startX: 0,
    startY: 0,
    startLeft: 0,
    startTop: 0,
    startWidth: 0,
    startHeight: 0
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function getViewportRect() {
    return {
      width: window.innerWidth,
      height: window.innerHeight
    };
  }

  function getDefaultPanelRect() {
    const viewport = getViewportRect();
    const width = clamp(Math.min(520, Math.floor(viewport.width * 0.92)), PANEL_MIN_WIDTH, Math.max(PANEL_MIN_WIDTH, viewport.width - PANEL_MARGIN * 2));
    const height = clamp(Math.min(680, Math.floor(viewport.height * 0.8)), PANEL_MIN_HEIGHT, Math.max(PANEL_MIN_HEIGHT, viewport.height - PANEL_MARGIN * 2));
    const left = clamp(viewport.width - width - PANEL_MARGIN, PANEL_MARGIN, Math.max(PANEL_MARGIN, viewport.width - width - PANEL_MARGIN));
    const top = clamp(viewport.height - height - BUTTON_SIZE - BUTTON_GAP * 2, PANEL_MARGIN, Math.max(PANEL_MARGIN, viewport.height - height - PANEL_MARGIN));
    return { left, top, width, height };
  }

  function normalizeRect(rect) {
    const viewport = getViewportRect();
    const maxWidth = Math.max(PANEL_MIN_WIDTH, viewport.width - PANEL_MARGIN * 2);
    const maxHeight = Math.max(PANEL_MIN_HEIGHT, viewport.height - PANEL_MARGIN * 2);
    let width = clamp(rect.width, PANEL_MIN_WIDTH, maxWidth);
    let height = clamp(rect.height, PANEL_MIN_HEIGHT, maxHeight);
    let left = rect.left;
    let top = rect.top;

    if (left < PANEL_MARGIN) left = PANEL_MARGIN;
    if (top < PANEL_MARGIN) top = PANEL_MARGIN;
    if (left + width > viewport.width - PANEL_MARGIN) left = viewport.width - PANEL_MARGIN - width;
    if (top + height > viewport.height - PANEL_MARGIN) top = viewport.height - PANEL_MARGIN - height;

    left = Math.max(PANEL_MARGIN, left);
    top = Math.max(PANEL_MARGIN, top);

    return { left, top, width, height };
  }

  function applyPanelRect() {
    const rect = normalizeRect(state);
    state.left = rect.left;
    state.top = rect.top;
    state.width = rect.width;
    state.height = rect.height;
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.width = `${rect.width}px`;
    panel.style.height = `${rect.height}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  function updateInteractionClasses() {
    panel.classList.toggle("is-dragging", state.mode === "drag");
    panel.classList.toggle("is-resizing", state.mode === "resize");
  }

  function finishInteraction() {
    state.mode = "";
    state.handle = "";
    state.pointerId = null;
    updateInteractionClasses();
  }

  function handlePointerMove(event) {
    if (!state.mode || state.pointerId !== event.pointerId) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;

    if (state.mode === "drag") {
      state.left = state.startLeft + dx;
      state.top = state.startTop + dy;
      applyPanelRect();
      return;
    }

    const next = {
      left: state.startLeft,
      top: state.startTop,
      width: state.startWidth,
      height: state.startHeight
    };

    if (state.handle.includes("e")) {
      next.width = state.startWidth + dx;
    }
    if (state.handle.includes("s")) {
      next.height = state.startHeight + dy;
    }
    if (state.handle.includes("w")) {
      next.width = state.startWidth - dx;
      next.left = state.startLeft + dx;
    }
    if (state.handle.includes("n")) {
      next.height = state.startHeight - dy;
      next.top = state.startTop + dy;
    }

    if (next.width < PANEL_MIN_WIDTH) {
      if (state.handle.includes("w")) {
        next.left -= PANEL_MIN_WIDTH - next.width;
      }
      next.width = PANEL_MIN_WIDTH;
    }
    if (next.height < PANEL_MIN_HEIGHT) {
      if (state.handle.includes("n")) {
        next.top -= PANEL_MIN_HEIGHT - next.height;
      }
      next.height = PANEL_MIN_HEIGHT;
    }

    state.left = next.left;
    state.top = next.top;
    state.width = next.width;
    state.height = next.height;
    applyPanelRect();
  }

  function handlePointerEnd(event) {
    if (state.pointerId !== event.pointerId) return;
    finishInteraction();
  }

  function startInteraction(event, mode, handle) {
    event.preventDefault();
    state.mode = mode;
    state.handle = handle || "";
    state.pointerId = event.pointerId;
    state.startX = event.clientX;
    state.startY = event.clientY;
    state.startLeft = state.left;
    state.startTop = state.top;
    state.startWidth = state.width;
    state.startHeight = state.height;
    updateInteractionClasses();
  }

  function ensureOpenRect() {
    if (!state.width || !state.height) {
      Object.assign(state, getDefaultPanelRect());
    }
    applyPanelRect();
  }

  closeBtn.addEventListener("click", () => {
    finishInteraction();
    panel.classList.remove("is-open");
  }, { signal });

  button.addEventListener("click", () => {
    if (!panel.classList.contains("is-open")) {
      ensureOpenRect();
    }
    panel.classList.toggle("is-open");
  }, { signal });

  bar.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".cat-crawler-close")) return;
    startInteraction(event, "drag", "");
  }, { signal });

  ["nw", "ne", "sw", "se"].forEach((corner) => {
    const handle = document.createElement("div");
    handle.className = `cat-crawler-handle cat-crawler-handle-${corner}`;
    handle.dataset.handle = corner;
    handle.addEventListener("pointerdown", (event) => {
      startInteraction(event, "resize", corner);
    }, { signal });
    panel.appendChild(handle);
  });

  window.addEventListener("pointermove", handlePointerMove, { signal });
  window.addEventListener("pointerup", handlePointerEnd, { signal });
  window.addEventListener("pointercancel", handlePointerEnd, { signal });
  window.addEventListener("resize", () => {
    if (panel.classList.contains("is-open")) {
      applyPanelRect();
    }
  }, { signal });

  Object.assign(state, getDefaultPanelRect());
  applyPanelRect();

  bar.appendChild(title);
  bar.appendChild(closeBtn);
  panel.appendChild(bar);
  panel.appendChild(iframe);

  root.appendChild(style);
  root.appendChild(button);
  root.appendChild(panel);
  document.body.appendChild(root);
  root.__catCrawlerCleanup = () => {
    controller.abort();
    root.remove();
  };
})();
