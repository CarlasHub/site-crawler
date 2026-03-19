# Cat Crawler

> Crawl and validate websites for broken links, redirects, parameter handling, soft failures, URL patterns, and impact.

![UI screenshot](docs/screenshot.png)

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Node](https://img.shields.io/badge/node-22%2B-brightgreen)
![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)

## Table of contents
- Features
- Live demo
- Tech stack
- How it works
- Architecture diagram
- Functionality deep-dive
- Installation and setup
- API reference
- Configuration and environment variables
- Deploy to Google Cloud Run
- Performance and roadmap
- Bookmarklet (Cat Crawler)
- GitHub Pages (Landing)

---

## Features
- Crawl internal pages from a homepage URL
- Sitemap-first discovery when sitemap.xml is available
- robots.txt respected before fetching any URL
- Same-host crawling with optional scope limited to the start path
- Navigation audit across both anchor links and form actions
- Exclude paths using relative paths, one per line
- Language-agnostic crawl limits by path (for example `/job` also matches `/en/job`, `/fr/job`)
- Ignore job pages by default to prevent job-heavy sections from flooding results
- Redirect resolution with full redirect chains, per-step status codes, and final URL stored
- Optional broken link quick check with HTTP status recording
- Parameter audit for `?test=1`, `?page=2`, and `?filter=value`
- Soft-failure detection for successful pages with missing content, error text, or failed API/XHR endpoints
- URL pattern audit for duplicate structures, legacy/current paths, and inconsistent naming
- Impact analysis for broken and redirected URLs based on repetition, referrers, and core-flow heuristics
- Consolidated validation report with broken URLs, redirect issues, parameter issues, soft failures, and impact analysis
- Duplicate content candidates detection, including querystring and language variants
- Client presets saved in localStorage, export and import presets as JSON
- Bookmarklet opens in a draggable, resizable in-page panel with 4-corner resize handles
- Glass UI with progress ring and animated orb during crawl

---

## Live demo

This project is deployed on a personal Cloud Run host:

https://site-crawler-989268314020.europe-west2.run.app/

For production use, deploy to **your own** Cloud Run service and update `APP_ORIGIN` in `docs/bookmarklet.js`.

---

## Tech stack

### Frontend
- React 18
- Vite 5
- Vanilla CSS
- Browser APIs: localStorage and sessionStorage

### Backend
- Node.js 22+
- Express
- Cheerio for HTML parsing and link extraction
- robots-parser for robots.txt enforcement
- Built-in fetch and AbortController for HTTP requests and timeouts

### Infrastructure
- Docker
- Google Cloud Run

---

## How it works

### User flow
1. Enter a homepage URL.
2. Add optional exclude paths such as `/jobs`, `/careers`, `/admin`.
3. Define crawl limits by path if required.
4. Configure max pages and concurrency.
5. Choose options such as ignoring job pages, running a broken link check, or enabling parameter audit.
6. Run the crawl.
7. Review the validation report, audit sections, and export TXT or CSV if needed.

### Quick start (step-by-step)
1. Paste the site homepage in **Homepage URL** (e.g. `https://example.com`).
2. Add **Exclude paths** (one per line). Only lines starting with `/` are used.
3. Add **Crawl limits by path** to cap noisy sections (e.g. `/job` max 5).
4. Set **Max pages** and **Concurrency** based on how deep you want to go.
5. Toggle **Ignore job pages**, **Broken link quick check**, or **Parameter audit** if needed.
6. Click **Run crawl**, then download **TXT** or **CSV** from Results.

Tip: enable **Broken link quick check** to classify live HTTP errors, and enable **Parameter audit** when you need route-level querystring validation.

### Landing page
See a marketing-style overview at `docs/landing.html` (matches the in-app color scheme).

## Architecture diagram

```mermaid
flowchart TD
  Bookmarklet["Bookmarklet optional"] --> UI["Browser UI (React + Vite SPA)"]
  UI --> API["Express API (Node.js backend)"]

  API --> Crawler["Crawl engine"]
  Crawler --> Robots["robots.txt"]
  Crawler --> Sitemap["sitemap.xml"]
  Crawler --> Site["Target website"]

  Robots --> Crawler
  Sitemap --> Crawler
  Site --> Crawler
  Crawler --> API
  API --> UI
```


---

## Functionality deep-dive

### Crawl pipeline
- The backend validates and normalises the start URL.
- robots.txt is fetched and enforced before crawling any URL.
- sitemap.xml is fetched and used as the initial discovery source when available.
- If no sitemap exists, crawling starts from the provided URL.

### URL filtering and scoping
Each discovered URL is filtered using:
- Same-host enforcement
- Optional restriction to the start path (for example starting at `/en` only crawls `/en/...`)
- Excluded file extensions (images, fonts, media, PDFs, JS, CSS)
- User-defined exclude paths
- Optional job page detection and exclusion

### Language-agnostic path limits
- Path limits are normalised by stripping a leading language segment.
- A rule like `/job` matches `/job`, `/en/job`, `/fr/job`, etc.
- Each rule tracks how many URLs were crawled under that path and stops once the limit is reached.

### Concurrency and progress
- URLs are processed in batches with a configurable concurrency limit.
- The UI displays progress using a time-based progress indicator while crawling.

### Results
- Returned URLs include original URL, final URL after redirects, HTTP status, source type, and referrer page.
- Audit entries are classified as `valid`, `broken`, `redirect_issue`, or `soft_failure`.
- Redirect audit highlights loops, multi-hop redirects, dropped params, and irrelevant destinations.
- Soft-failure audit flags successful pages that still fail functionally.
- Impact audit prioritises broken and redirect issues by repetition and core-flow importance.
- Pattern audit groups URLs by structure and highlights inconsistencies.
- Duplicate candidates are grouped by base URL and flagged when query or language variants exist.
- Results can be exported as TXT or CSV.

---

## API reference

### POST `/api/crawl`

Request body:
```json
{
  "url": "https://example.com",
  "options": {
    "excludePaths": ["/jobs", "/careers"],
    "pathLimits": [{ "path": "/job", "maxPages": 5 }],
    "maxPages": 300,
    "concurrency": 6,
    "includeQuery": true,
    "ignoreJobPages": true,
    "brokenLinkCheck": false,
    "parameterAudit": true,
    "patternMatchFilter": "/jobs"
  }
}
```

Key response sections:
- `urls`: crawled page records
- `audit`: validated navigation entries with referrer pages and classifications
- `issueReport`: broken URLs, redirect issues, parameter issues, soft failures, and impact analysis
- `impactAudit`: prioritised broken/redirect issues
- `redirectAudit`: redirect-chain QA
- `softFailureAudit`: successful-but-broken pages
- `patternAudit`: structural URL grouping and inconsistency detection
- `parameterAudit`: query-parameter handling checks

---

## Bookmarklet (Cat Crawler)

Use the crawler on the page you are currently visiting.

1. Open the GitHub Pages landing page in `docs/index.html`.
2. Drag the **Cat Crawler** bookmarklet button to your bookmarks bar.
3. Click the bookmark on any site to open **Cat Crawler**. It auto-fills the current page URL.
4. Drag the panel by the top bar and resize it from any of the four corners.

Tip: The landing page button **Drag Cat Crawler 😼** is now a loader bookmarklet. Reinstall it once, and future bookmarklet UI updates will come from `bookmarklet.js` without another reinstall.

---

## GitHub Pages (Landing)

The landing page lives in `docs/index.html`.

Enable Pages:
1. Go to **Settings → Pages**.
2. **Source**: Deploy from a branch.
3. **Branch**: `main`.
4. **Folder**: `/docs`.
5. Save.

Then visit:
`https://<org-or-user>.github.io/site-crawler/`
