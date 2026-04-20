#!/usr/bin/env node
/**
 * Captures real product screenshots against a running Cat Crawler instance.
 *
 * Start the stack (example):
 *   docker build -t cat-crawler:screenshots . && docker run --rm -p 127.0.0.1:8080:8080 cat-crawler:screenshots
 *
 * Install browser once:
 *   cd frontend && npm ci && npx playwright install chromium
 *
 * Run (from repository root — resolves playwright via frontend/node_modules):
 *   BASE_URL=http://127.0.0.1:8080 node scripts/capture-docs-screenshots.mjs
 *
 * If Chromium is missing, set a stable browser cache (example):
 *   export PLAYWRIGHT_BROWSERS_PATH="$PWD/.playwright-browsers"
 *   cd frontend && npx playwright install chromium
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const outDir = path.join(rootDir, "docs", "assets", "screenshots");

const BASE_URL = String(process.env.BASE_URL || "http://127.0.0.1:8080").replace(/\/$/, "");

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function loadPlaywright() {
  const entry = path.join(rootDir, "frontend", "node_modules", "playwright", "index.mjs");
  if (!fs.existsSync(entry)) {
    console.error("Missing playwright. Run: cd frontend && npm ci && npx playwright install chromium");
    process.exit(1);
  }
  return import(pathToFileURL(entry).href);
}

async function waitForCrawlFinished(page) {
  await page.waitForFunction(
    () => {
      const buttons = [...document.querySelectorAll("button")];
      const run = buttons.find((b) => (b.textContent || "").trim() === "Run crawl");
      return run && !run.disabled;
    },
    { timeout: 180000 }
  );
}

async function main() {
  const { chromium } = await loadPlaywright();

  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true
  });
  const page = await context.newPage();

  const demoTarget = "https://example.com";
  // Full UI (hero visible): bookmarklet mode hides the hero in CSS — use normal mode for most shots.
  const fullUiUrl = `${BASE_URL}/?url=${encodeURIComponent(demoTarget)}`;
  const bookmarkletUrl = `${BASE_URL}/?mode=bookmarklet&url=${encodeURIComponent(demoTarget)}`;

  await page.goto(fullUiUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(".shell", { timeout: 60000 });

  await page.locator('[data-doc-screenshot="dashboard"]').screenshot({
    path: path.join(outDir, "01-dashboard.png"),
    animations: "disabled"
  });

  await page.locator("#runner").scrollIntoViewIfNeeded();
  await delay(300);
  await page.locator('[data-doc-screenshot="crawl-settings"]').screenshot({
    path: path.join(outDir, "02-crawl-settings.png")
  });

  await page.locator("#maxPages").fill("12");
  await page.getByRole("checkbox", { name: /Broken link quick check/i }).check();
  await page.getByRole("checkbox", { name: /Parameter audit/i }).check();
  await page.getByRole("button", { name: /^Run crawl$/ }).click();

  await page.getByText(/Crawl in progress|Crawling/i).first().waitFor({ timeout: 15000 }).catch(() => {});
  await delay(600);

  const dock = page.locator('[data-doc-screenshot="crawl-progress"]');
  if ((await dock.count()) > 0) {
    await dock.screenshot({ path: path.join(outDir, "03-active-crawl.png") });
  } else {
    await page.screenshot({ path: path.join(outDir, "03-active-crawl.png") });
  }

  await waitForCrawlFinished(page);
  await delay(500);

  await page.locator("#results").scrollIntoViewIfNeeded();
  await delay(400);

  const auditField = page.locator(".field").filter({ has: page.getByText(/^Audit report$/) });
  await auditField.screenshot({ path: path.join(outDir, "04-audit-report.png") });

  const validation = page.locator("details").filter({ has: page.getByText(/^Validation report$/) });
  await validation.first().locator("summary").click();
  await delay(200);
  await validation.first().screenshot({ path: path.join(outDir, "05-validation-report.png") });

  const redirectAudit = page.locator("details").filter({ has: page.getByText(/^Redirect audit/) });
  if ((await redirectAudit.count()) > 0) {
    await redirectAudit.first().locator("summary").click();
    await delay(200);
    await redirectAudit.first().screenshot({ path: path.join(outDir, "06-redirect-audit.png") });
  } else {
    await page.screenshot({ path: path.join(outDir, "06-redirect-audit.png") });
  }

  const paramAudit = page.locator("details").filter({ has: page.getByText(/^Parameter audit/) });
  if ((await paramAudit.count()) > 0) {
    await paramAudit.first().locator("summary").click();
    await delay(200);
    await paramAudit.first().screenshot({ path: path.join(outDir, "07-parameter-audit.png") });
  } else {
    await page.screenshot({ path: path.join(outDir, "07-parameter-audit.png") });
  }

  const softFailures = page.locator("details").filter({ has: page.getByText(/^Soft failures/) });
  if ((await softFailures.count()) > 0) {
    await softFailures.first().locator("summary").click();
    await delay(200);
    await softFailures.first().screenshot({ path: path.join(outDir, "08-soft-failures.png") });
  } else {
    await validation.first().screenshot({ path: path.join(outDir, "08-soft-failures.png") });
  }

  const issueImpact = page.locator("details").filter({ has: page.getByText(/^Issue impact/) });
  if ((await issueImpact.count()) > 0) {
    await issueImpact.first().locator("summary").click();
    await delay(200);
    await issueImpact.first().screenshot({ path: path.join(outDir, "10-issue-impact.png") });
  } else {
    await validation.first().screenshot({ path: path.join(outDir, "10-issue-impact.png") });
  }

  const urlPatterns = page.locator("details").filter({ has: page.getByText(/^URL patterns/) });
  if ((await urlPatterns.count()) > 0) {
    await urlPatterns.first().locator("summary").click();
    await delay(200);
    await urlPatterns.first().screenshot({ path: path.join(outDir, "11-url-patterns.png") });
  } else {
    await validation.first().screenshot({ path: path.join(outDir, "11-url-patterns.png") });
  }

  await page.locator("#presets").scrollIntoViewIfNeeded();
  await delay(400);
  await page.locator("#presetName").fill("Example.com QA");
  await page.getByRole("button", { name: /^Save preset$/ }).click();
  await delay(200);
  await page.locator("#presets").screenshot({ path: path.join(outDir, "12-presets.png") });

  await page.goto(bookmarkletUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(".shell--bookmarklet", { timeout: 30000 });
  await delay(300);
  await page.screenshot({ path: path.join(outDir, "09-bookmarklet-mode.png") });

  await browser.close();

  const names = fs.readdirSync(outDir).filter((f) => f.endsWith(".png")).sort();
  console.log(`Wrote ${names.length} screenshots under docs/assets/screenshots/`);
  names.forEach((n) => console.log(`  - ${n}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
