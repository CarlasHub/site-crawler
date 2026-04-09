(() => {
  const ROOT_ID = "cat-crawler-root";
  const LOAD_TIMEOUT_MS = 45000;

  function getCurrentScriptSource() {
    const current = document.currentScript;
    if (current && typeof current.src === "string" && current.src) return current.src;

    const scripts = document.getElementsByTagName("script");
    const lastScript = scripts[scripts.length - 1];
    return lastScript && typeof lastScript.src === "string" ? lastScript.src : "";
  }

  function resolveAppOrigin() {
    const scriptSource = getCurrentScriptSource();
    if (!scriptSource) {
      throw new Error("Cat Crawler could not determine its own script URL.");
    }

    const scriptUrl = new URL(scriptSource, window.location.href);
    const paramValue = scriptUrl.searchParams.get("appOrigin");
    const configuredOrigin = String(paramValue || "").trim();

    if (!configuredOrigin) {
      throw new Error("Cat Crawler bookmarklet is missing the appOrigin parameter.");
    }

    const parsed = new URL(configuredOrigin);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`Unsupported Cat Crawler app origin protocol: ${parsed.protocol}`);
    }

    return parsed.origin;
  }

  let APP_ORIGIN = "";
  try {
    APP_ORIGIN = resolveAppOrigin();
  } catch (error) {
    console.error(error);
    window.alert("Cat Crawler is not configured with a valid app origin.");
    return;
  }

  const targetHref = `${APP_ORIGIN}/?mode=bookmarklet&url=${encodeURIComponent(window.location.href)}`;

  const existing = document.getElementById(ROOT_ID);
  if (existing) {
    existing.classList.remove("is-minimised");
    const iframe = existing.querySelector(".cat-crawler-iframe");
    const panel = existing.querySelector(".cat-crawler-panel");
    if (panel) {
      panel.classList.add("is-open");
    }

    if (iframe) {
      const last = iframe.getAttribute("data-cc-src");
      if (last !== targetHref) {
        iframe.setAttribute("data-cc-src", targetHref);
        armLoadWatchers(existing, iframe);
        iframe.src = targetHref;
      } else {
        hideLoading(existing);
      }
    }
    hideError(existing);
    return;
  }

  const PANEL_MIN_WIDTH = 320;
  const PANEL_MIN_HEIGHT = 280;
  const PANEL_MARGIN = 16;
  const BUTTON_SIZE = 56;
  const BUTTON_GAP = 16;
  const BAR_HEIGHT = 44;

  const root = document.createElement("div");
  root.id = ROOT_ID;
  const controller = new AbortController();
  const { signal } = controller;

  let loadTimer = null;

  function showLoading(host) {
    const layer = host.querySelector(".cat-crawler-loading");
    const err = host.querySelector(".cat-crawler-error");
    if (err) {
      err.classList.remove("is-visible");
      err.setAttribute("hidden", "");
    }
    if (layer) {
      layer.classList.remove("is-hidden");
      layer.removeAttribute("hidden");
    }
  }

  function hideLoading(host) {
    const layer = host.querySelector(".cat-crawler-loading");
    if (layer) {
      layer.classList.add("is-hidden");
      layer.setAttribute("hidden", "");
    }
  }

  function showError(host, message) {
    hideLoading(host);
    const err = host.querySelector(".cat-crawler-error");
    const text = host.querySelector(".cat-crawler-error-text");
    if (text) text.textContent = message;
    if (err) {
      err.classList.add("is-visible");
      err.removeAttribute("hidden");
    }
  }

  function hideError(host) {
    const err = host.querySelector(".cat-crawler-error");
    if (err) {
      err.classList.remove("is-visible");
      err.setAttribute("hidden", "");
    }
  }

  function clearLoadTimer() {
    if (loadTimer) {
      window.clearTimeout(loadTimer);
      loadTimer = null;
    }
  }

  function armLoadWatchers(host, iframe) {
    const prevAbort = host.__catCrawlerLoadAbort;
    if (prevAbort && typeof prevAbort.abort === "function") {
      prevAbort.abort();
    }
    const loadAbort = new AbortController();
    host.__catCrawlerLoadAbort = loadAbort;
    const ls = loadAbort.signal;

    clearLoadTimer();
    showLoading(host);
    hideError(host);

    loadTimer = window.setTimeout(() => {
      loadTimer = null;
      showError(
        host,
        `Cat Crawler did not load within ${Math.round(LOAD_TIMEOUT_MS / 1000)}s. Check your network, blockers, and that the app is reachable at ${APP_ORIGIN}.`
      );
    }, LOAD_TIMEOUT_MS);

    const onDone = () => {
      clearLoadTimer();
      hideLoading(host);
    };

    iframe.addEventListener(
      "load",
      () => {
        onDone();
      },
      { once: true, signal: ls }
    );
  }

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
      display: none;
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
      padding: 0;
    }
    #${ROOT_ID}.is-minimised .cat-crawler-button {
      display: block;
    }
    #${ROOT_ID}.is-minimised .cat-crawler-panel {
      display: none !important;
    }
    #${ROOT_ID} .cat-crawler-panel {
      position: fixed;
      display: block;
      border-radius: 16px;
      border: 1px solid rgba(0,0,0,0.2);
      background: #0b0b0b;
      box-shadow: 0 18px 48px rgba(0,0,0,0.45);
      overflow: hidden;
      min-width: ${PANEL_MIN_WIDTH}px;
      min-height: ${PANEL_MIN_HEIGHT}px;
    }
    #${ROOT_ID} .cat-crawler-panel.is-dragging,
    #${ROOT_ID} .cat-crawler-panel.is-resizing {
      user-select: none;
    }
    #${ROOT_ID} .cat-crawler-panel.is-dragging .cat-crawler-iframe,
    #${ROOT_ID} .cat-crawler-panel.is-resizing .cat-crawler-iframe {
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
    #${ROOT_ID} .cat-crawler-bar-actions {
      display: flex;
      gap: 8px;
      flex-shrink: 0;
    }
    #${ROOT_ID} .cat-crawler-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #${ROOT_ID} .cat-crawler-bar button {
      border: 1px solid rgba(255,255,255,0.2);
      background: transparent;
      color: #fff;
      padding: 6px 10px;
      border-radius: 10px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
    }
    #${ROOT_ID} .cat-crawler-body {
      position: relative;
      height: calc(100% - ${BAR_HEIGHT}px);
      background: #0b0b0b;
    }
    #${ROOT_ID} .cat-crawler-loading,
    #${ROOT_ID} .cat-crawler-error {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 14px;
      padding: 20px;
      background: #0b0b0b;
      color: #e8e8e8;
      font-size: 14px;
      line-height: 1.45;
      text-align: center;
      z-index: 2;
    }
    #${ROOT_ID} .cat-crawler-loading.is-hidden,
    #${ROOT_ID} .cat-crawler-error[hidden] {
      display: none !important;
    }
    #${ROOT_ID} .cat-crawler-error:not(.is-visible) {
      display: none !important;
    }
    #${ROOT_ID} .cat-crawler-error.is-visible {
      display: flex !important;
    }
    #${ROOT_ID} .cat-crawler-spinner {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      border: 3px solid rgba(255,255,255,0.15);
      border-top-color: rgba(255,255,255,0.85);
      animation: cat-crawler-spin 0.85s linear infinite;
    }
    @keyframes cat-crawler-spin {
      to { transform: rotate(360deg); }
    }
    #${ROOT_ID} .cat-crawler-iframe {
      width: 100%;
      height: 100%;
      border: 0;
      background: #0b0b0b;
      display: block;
      position: relative;
      z-index: 1;
    }
    #${ROOT_ID} .cat-crawler-handle {
      position: absolute;
      width: 16px;
      height: 16px;
      z-index: 3;
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

  const panel = document.createElement("div");
  panel.className = "cat-crawler-panel is-open";

  const bar = document.createElement("div");
  bar.className = "cat-crawler-bar";

  const title = document.createElement("div");
  title.className = "cat-crawler-title";
  title.textContent = "Cat Crawler";

  const barActions = document.createElement("div");
  barActions.className = "cat-crawler-bar-actions";

  const minimiseBtn = document.createElement("button");
  minimiseBtn.type = "button";
  minimiseBtn.textContent = "Hide";
  minimiseBtn.setAttribute("aria-label", "Hide Cat Crawler panel");

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "Close";
  closeBtn.setAttribute("aria-label", "Close Cat Crawler");

  const body = document.createElement("div");
  body.className = "cat-crawler-body";

  const loading = document.createElement("div");
  loading.className = "cat-crawler-loading";
  loading.setAttribute("role", "status");
  loading.setAttribute("aria-live", "polite");
  const spinner = document.createElement("div");
  spinner.className = "cat-crawler-spinner";
  spinner.setAttribute("aria-hidden", "true");
  const loadingText = document.createElement("div");
  loadingText.textContent = "Loading Cat Crawler…";
  loading.appendChild(spinner);
  loading.appendChild(loadingText);

  const errorBox = document.createElement("div");
  errorBox.className = "cat-crawler-error";
  errorBox.setAttribute("role", "alert");
  errorBox.setAttribute("hidden", "");
  const errorText = document.createElement("div");
  errorText.className = "cat-crawler-error-text";
  errorBox.appendChild(errorText);

  const iframe = document.createElement("iframe");
  iframe.className = "cat-crawler-iframe";
  iframe.title = "Cat Crawler";
  iframe.setAttribute("data-cc-src", targetHref);

  const button = document.createElement("button");
  button.className = "cat-crawler-button";
  button.title = "Show Cat Crawler";
  button.type = "button";
  button.setAttribute("aria-label", "Show Cat Crawler panel");

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
    const height = clamp(Math.min(680, Math.floor(viewport.height * 0.82)), PANEL_MIN_HEIGHT, Math.max(PANEL_MIN_HEIGHT, viewport.height - PANEL_MARGIN * 2));
    const left = clamp(viewport.width - width - PANEL_MARGIN, PANEL_MARGIN, Math.max(PANEL_MARGIN, viewport.width - width - PANEL_MARGIN));
    const top = clamp(PANEL_MARGIN, PANEL_MARGIN, Math.max(PANEL_MARGIN, viewport.height - height - PANEL_MARGIN));
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

  closeBtn.addEventListener(
    "click",
    () => {
      finishInteraction();
      clearLoadTimer();
      controller.abort();
      root.remove();
    },
    { signal }
  );

  minimiseBtn.addEventListener(
    "click",
    () => {
      finishInteraction();
      root.classList.add("is-minimised");
    },
    { signal }
  );

  button.addEventListener(
    "click",
    () => {
      root.classList.remove("is-minimised");
      ensureOpenRect();
    },
    { signal }
  );

  bar.addEventListener(
    "pointerdown",
    (event) => {
      if (event.target.closest("button")) return;
      startInteraction(event, "drag", "");
    },
    { signal }
  );

  ["nw", "ne", "sw", "se"].forEach((corner) => {
    const handle = document.createElement("div");
    handle.className = `cat-crawler-handle cat-crawler-handle-${corner}`;
    handle.addEventListener(
      "pointerdown",
      (event) => {
        startInteraction(event, "resize", corner);
      },
      { signal }
    );
    panel.appendChild(handle);
  });

  window.addEventListener("pointermove", handlePointerMove, { signal });
  window.addEventListener("pointerup", handlePointerEnd, { signal });
  window.addEventListener("pointercancel", handlePointerEnd, { signal });
  window.addEventListener(
    "resize",
    () => {
      if (!root.classList.contains("is-minimised")) {
        applyPanelRect();
      }
    },
    { signal }
  );

  Object.assign(state, getDefaultPanelRect());
  applyPanelRect();

  barActions.appendChild(minimiseBtn);
  barActions.appendChild(closeBtn);
  bar.appendChild(title);
  bar.appendChild(barActions);
  body.appendChild(loading);
  body.appendChild(errorBox);
  body.appendChild(iframe);
  panel.appendChild(bar);
  panel.appendChild(body);

  root.appendChild(style);
  root.appendChild(panel);
  root.appendChild(button);
  document.body.appendChild(root);

  armLoadWatchers(root, iframe);
  iframe.src = targetHref;

  root.__catCrawlerCleanup = () => {
    clearLoadTimer();
    const la = root.__catCrawlerLoadAbort;
    if (la && typeof la.abort === "function") la.abort();
    controller.abort();
    root.remove();
  };
})();
