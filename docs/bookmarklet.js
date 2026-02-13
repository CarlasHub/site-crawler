(() => {
  const APP_ORIGIN = "https://site-crawler-909296093050.europe-west2.run.app";
  const ROOT_ID = "a11y-cat-root";
  const existing = document.getElementById(ROOT_ID);

  if (existing) {
    existing.remove();
    return;
  }

  const root = document.createElement("div");
  root.id = ROOT_ID;

  const style = document.createElement("style");
  style.textContent = `
    #${ROOT_ID} {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483647;
      font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    }
    #${ROOT_ID} .a11y-cat-button {
      width: 56px;
      height: 56px;
      border-radius: 999px;
      border: 2px solid #1a1a1a;
      background: #0f0f0f url("${APP_ORIGIN}/cat.png") center / cover no-repeat;
      box-shadow: 0 8px 24px rgba(0,0,0,0.35);
      cursor: pointer;
    }
    #${ROOT_ID} .a11y-cat-panel {
      position: fixed;
      right: 16px;
      bottom: 88px;
      width: min(520px, 92vw);
      height: min(80vh, 680px);
      border-radius: 16px;
      border: 1px solid rgba(0,0,0,0.2);
      background: #0b0b0b;
      box-shadow: 0 18px 48px rgba(0,0,0,0.45);
      overflow: hidden;
      display: none;
    }
    #${ROOT_ID} .a11y-cat-panel.is-open {
      display: block;
    }
    #${ROOT_ID} .a11y-cat-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      background: #111;
      color: #fff;
      font-weight: 700;
      font-size: 13px;
    }
    #${ROOT_ID} .a11y-cat-close {
      border: 1px solid rgba(255,255,255,0.2);
      background: transparent;
      color: #fff;
      padding: 6px 10px;
      border-radius: 10px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
    }
    #${ROOT_ID} iframe {
      width: 100%;
      height: calc(100% - 44px);
      border: 0;
      background: #0b0b0b;
    }
  `;

  const button = document.createElement("button");
  button.className = "a11y-cat-button";
  button.title = "A11y Cat";
  button.type = "button";

  const panel = document.createElement("div");
  panel.className = "a11y-cat-panel";

  const bar = document.createElement("div");
  bar.className = "a11y-cat-bar";
  bar.textContent = "A11y Cat";

  const closeBtn = document.createElement("button");
  closeBtn.className = "a11y-cat-close";
  closeBtn.type = "button";
  closeBtn.textContent = "Close";

  const iframe = document.createElement("iframe");
  const targetUrl = encodeURIComponent(window.location.href);
  iframe.src = `${APP_ORIGIN}/?mode=bookmarklet&url=${targetUrl}`;
  iframe.title = "A11y Cat";

  closeBtn.addEventListener("click", () => {
    panel.classList.remove("is-open");
  });

  button.addEventListener("click", () => {
    panel.classList.toggle("is-open");
  });

  bar.appendChild(closeBtn);
  panel.appendChild(bar);
  panel.appendChild(iframe);

  root.appendChild(style);
  root.appendChild(button);
  root.appendChild(panel);
  document.body.appendChild(root);
})();
