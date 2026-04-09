import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  app,
  buildErrorResponse,
  createOutboundAccessController,
  describeTrustProxySetting,
  executeCrawlRequest,
  fetchRobots,
  fetchSitemapUrls,
  fetchTextResource,
  fetchWithRedirects,
  getClientIpInfo,
  initializeRuntimeServices,
  isRobotsContentType,
  isXmlContentType,
  parseSitemapXml,
  resolveTrustProxySetting,
  shutdownRuntimeServices
} from "../index.js";
import { createFileCrawlJobStore } from "../job-store.js";

const USER_AGENT = "SiteCrawler/1.0";
const PUBLIC_IPV4 = "93.184.216.34";
const PUBLIC_IPV6 = "2606:2800:220:1:248:1893:25c8:1946";
const TRUST_PROXY_LOOPBACK = resolveTrustProxySetting("loopback");

async function withCapturedConsole(fn) {
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;
  const entries = {
    info: [],
    warn: [],
    error: []
  };

  console.info = (value) => entries.info.push(String(value));
  console.warn = (value) => entries.warn.push(String(value));
  console.error = (value) => entries.error.push(String(value));

  try {
    return await fn(entries);
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

function makeLookup(map) {
  return async (hostname) => {
    const key = String(hostname || "").toLowerCase();
    const value = map[key];
    if (!value) {
      const error = new Error(`ENOTFOUND ${hostname}`);
      error.code = "ENOTFOUND";
      throw error;
    }
    return value.map((entry) => ({ address: entry.address, family: entry.family }));
  };
}

async function withMockedFetch(handler, fn) {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init, calls);
  };

  try {
    return await fn(calls);
  } finally {
    global.fetch = originalFetch;
  }
}

async function withApiServer(fn, options = {}) {
  const previousTrustProxy = app.get("trust proxy");
  const hasTrustProxyOverride = Object.prototype.hasOwnProperty.call(options, "trustProxy");
  const previousCrawlExecutor = app.locals.crawlExecutor;
  const hasCrawlExecutorOverride = Object.prototype.hasOwnProperty.call(options, "crawlExecutor");
  const previousJobStore = app.locals.jobStore;
  const hasJobStoreOverride = Object.prototype.hasOwnProperty.call(options, "jobStore");

  if (hasTrustProxyOverride) {
    app.set("trust proxy", options.trustProxy);
  }
  if (hasCrawlExecutorOverride) {
    app.locals.crawlExecutor = options.crawlExecutor;
  }
  if (hasJobStoreOverride) {
    app.locals.jobStore = options.jobStore;
  }

  const server = http.createServer(app);
  await initializeRuntimeServices();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    return await fn(server);
  } finally {
    await shutdownRuntimeServices();
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (hasTrustProxyOverride) {
      app.set("trust proxy", previousTrustProxy);
    }
    if (hasCrawlExecutorOverride) {
      if (previousCrawlExecutor === undefined) {
        delete app.locals.crawlExecutor;
      } else {
        app.locals.crawlExecutor = previousCrawlExecutor;
      }
    }
    if (hasJobStoreOverride) {
      if (typeof options.jobStore?.close === "function") {
        await options.jobStore.close();
      }
      if (previousJobStore === undefined) {
        delete app.locals.jobStore;
      } else {
        app.locals.jobStore = previousJobStore;
      }
    }
  }
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "site-crawler-api-job-state-"));
  try {
    return await fn(dir);
  } finally {
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true });
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    throw lastError;
  }
}

async function requestJson(server, { method = "GET", path = "/", body = null, headers = {} }) {
  const address = server.address();
  const payload = body === null ? "" : (typeof body === "string" ? body : JSON.stringify(body));
  const hasBody = method !== "GET" && method !== "HEAD";
  const finalHeaders = {
    Accept: "application/json",
    ...headers
  };

  if (hasBody && !finalHeaders["Content-Type"]) {
    finalHeaders["Content-Type"] = "application/json";
  }
  if (hasBody) {
    finalHeaders["Content-Length"] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: address.port,
      path,
      method,
      headers: finalHeaders
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          text,
          json
        });
      });
    });

    req.on("error", reject);
    if (hasBody && payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function waitForJobCompletion(server, jobId, forwardedFor) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const headers = forwardedFor ? { "X-Forwarded-For": forwardedFor } : {};
    const response = await requestJson(server, {
      method: "GET",
      path: `/api/crawl/${jobId}`,
      headers
    });

    if (response.json?.status === "completed") return response.json;
    if (response.json?.status === "failed") {
      throw new Error(`Job failed during test: ${response.json?.error || "unknown error"}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Timed out waiting for crawl job completion");
}

async function waitForJobStatus(server, jobId, expectedStatus, forwardedFor) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const headers = forwardedFor ? { "X-Forwarded-For": forwardedFor } : {};
    const response = await requestJson(server, {
      method: "GET",
      path: `/api/crawl/${jobId}`,
      headers
    });

    if (response.json?.status === expectedStatus) return response;

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out waiting for crawl job status ${expectedStatus}`);
}

test("outbound access controller allows public hosts and caches validated resolutions", async () => {
  let lookups = 0;
  const controller = createOutboundAccessController({
    lookupFn: async () => {
      lookups += 1;
      return [
        { address: PUBLIC_IPV4, family: 4 },
        { address: PUBLIC_IPV6, family: 6 }
      ];
    }
  });

  const first = await controller.resolveUrl("https://public.example/start");
  const second = await controller.resolveUrl("https://public.example/next");

  assert.equal(lookups, 1);
  assert.deepEqual(first.addresses, [
    { address: PUBLIC_IPV4, family: 4 },
    { address: PUBLIC_IPV6, family: 6 }
  ]);
  assert.deepEqual(second.addresses, first.addresses);
});

test("outbound access controller blocks localhost, private IPv4, private IPv6, and mixed DNS answers", async () => {
  const controller = createOutboundAccessController({
    lookupFn: makeLookup({
      "mixed.example": [
        { address: PUBLIC_IPV4, family: 4 },
        { address: "127.0.0.1", family: 4 }
      ]
    })
  });

  await assert.rejects(() => controller.resolveUrl("http://localhost/"), /loopback hostname/);
  await assert.rejects(() => controller.resolveUrl("http://127.0.0.1/"), /127\.0\.0\.0\/8/);
  await assert.rejects(() => controller.resolveUrl("http://[::1]/"), /loopback IPv6 address/);
  await assert.rejects(() => controller.resolveUrl("http://[fd00::1]/"), /private IPv6 range/);
  await assert.rejects(() => controller.resolveUrl("http://metadata.google.internal/"), /cloud metadata hostname/);
  await assert.rejects(() => controller.resolveUrl("http://mixed.example/"), /resolved to/);
});

test("executeCrawlRequest rejects blocked start URLs with a clear API error", async () => {
  await assert.rejects(
    () => executeCrawlRequest({ url: "http://127.0.0.1/" }),
    (error) => {
      assert.equal(error.statusCode, 403);
      assert.match(error.message, /blocked/i);
      return true;
    }
  );
});

test("buildErrorResponse hides unexpected internal errors and includes a request id", () => {
  const response = buildErrorResponse(new Error("database connection failed"), "req-123");

  assert.equal(response.statusCode, 500);
  assert.equal(response.body.error, "Internal server error");
  assert.equal(response.body.code, "INTERNAL_ERROR");
  assert.equal(response.body.details, null);
  assert.equal(response.body.requestId, "req-123");
});

test("resolveTrustProxySetting rejects unsafe generic trust settings and hop counts", () => {
  assert.throws(
    () => resolveTrustProxySetting("true"),
    /generic true is unsafe/
  );
  assert.throws(
    () => resolveTrustProxySetting("2"),
    /hop-count trust values are not allowed/
  );
});

test("resolveTrustProxySetting accepts explicit trusted proxy presets and addresses", () => {
  assert.deepEqual(resolveTrustProxySetting("loopback"), ["loopback"]);
  assert.deepEqual(
    resolveTrustProxySetting("127.0.0.1,10.0.0.0/8,2001:db8::/32"),
    ["127.0.0.1", "10.0.0.0/8", "2001:db8::/32"]
  );
  assert.equal(describeTrustProxySetting(false), "disabled");
  assert.equal(describeTrustProxySetting(["loopback", "10.0.0.0/8"]), "loopback,10.0.0.0/8");
});

test("getClientIpInfo reports socket-based identity when proxy trust is disabled", () => {
  const info = getClientIpInfo({
    ip: "127.0.0.1",
    ips: [],
    socket: { remoteAddress: "127.0.0.1" }
  });

  assert.equal(info.ip, "127.0.0.1");
  assert.equal(info.source, "socket");
  assert.deepEqual(info.forwardedChain, []);
});

test("fetchWithRedirects preserves redirects for validated public targets", async () => {
  const controller = createOutboundAccessController({
    lookupFn: makeLookup({
      "public.example": [{ address: PUBLIC_IPV4, family: 4 }],
      "www.public.example": [{ address: PUBLIC_IPV4, family: 4 }]
    })
  });

  await withMockedFetch(async (url) => {
    if (url === "https://public.example/start") {
      return new Response("", {
        status: 302,
        headers: { Location: "https://www.public.example/final" }
      });
    }

    if (url === "https://www.public.example/final") {
      return new Response("ok", {
        status: 200,
        headers: { "Content-Type": "text/plain" }
      });
    }

    throw new Error(`Unexpected fetch for ${url}`);
  }, async (calls) => {
    const result = await fetchWithRedirects("https://public.example/start", {
      method: "GET",
      timeoutMs: 2000,
      robots: null,
      userAgent: USER_AGENT,
      accept: "*/*",
      outboundController: controller
    });

    assert.equal(result.ok, true);
    assert.equal(result.finalUrl, "https://www.public.example/final");
    assert.deepEqual(result.redirectChain, [
      "https://public.example/start",
      "https://www.public.example/final"
    ]);
    assert.equal(calls.length, 2);
  });
});

test("fetchWithRedirects blocks redirects to internal or metadata targets before the next request", async () => {
  const controller = createOutboundAccessController({
    lookupFn: makeLookup({
      "redirect.example": [{ address: PUBLIC_IPV4, family: 4 }]
    })
  });

  await withMockedFetch(async (url) => {
    if (url === "https://redirect.example/start") {
      return new Response("", {
        status: 302,
        headers: { Location: "http://169.254.169.254/latest/meta-data" }
      });
    }

    throw new Error(`Unexpected fetch for ${url}`);
  }, async (calls) => {
    const result = await fetchWithRedirects("https://redirect.example/start", {
      method: "GET",
      timeoutMs: 2000,
      robots: null,
      userAgent: USER_AGENT,
      accept: "*/*",
      outboundController: controller
    });

    assert.equal(result.ok, false);
    assert.equal(result.blockedByPolicy, true);
    assert.equal(result.finalUrl, "http://169.254.169.254/latest/meta-data");
    assert.match(result.error, /link-local IPv4 range/);
    assert.equal(calls.length, 1);
  });
});

test("fetchWithRedirects blocks private DNS resolutions before any network request is made", async () => {
  const controller = createOutboundAccessController({
    lookupFn: makeLookup({
      "internal.example": [{ address: "10.10.10.10", family: 4 }]
    })
  });

  await withMockedFetch(async () => {
    throw new Error("fetch should not be called for blocked hosts");
  }, async (calls) => {
    const result = await fetchWithRedirects("https://internal.example/start", {
      method: "GET",
      timeoutMs: 2000,
      robots: null,
      userAgent: USER_AGENT,
      accept: "*/*",
      outboundController: controller
    });

    assert.equal(result.ok, false);
    assert.equal(result.blockedByPolicy, true);
    assert.match(result.error, /private IPv4 range/);
    assert.equal(calls.length, 0);
  });
});

test("fetchWithRedirects stops when redirect hops exceed the configured limit", async () => {
  const controller = createOutboundAccessController({
    lookupFn: makeLookup({
      "public.example": [{ address: PUBLIC_IPV4, family: 4 }],
      "www.public.example": [{ address: PUBLIC_IPV4, family: 4 }]
    })
  });

  await withMockedFetch(async (url) => {
    if (url === "https://public.example/start") {
      return new Response("", {
        status: 302,
        headers: { Location: "https://www.public.example/step-2" }
      });
    }

    throw new Error(`Unexpected fetch for ${url}`);
  }, async (calls) => {
    const result = await fetchWithRedirects("https://public.example/start", {
      method: "GET",
      timeoutMs: 2000,
      robots: null,
      userAgent: USER_AGENT,
      accept: "*/*",
      outboundController: controller,
      maxRedirects: 1
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 310);
    assert.equal(result.errorCode, "MAX_REDIRECTS_EXCEEDED");
    assert.equal(result.maxRedirectsExceeded, true);
    assert.deepEqual(result.redirectChain, [
      "https://public.example/start",
      "https://www.public.example/step-2"
    ]);
    assert.equal(calls.length, 1);
  });
});

test("fetchRobots parses a valid robots.txt from a public host and exposes sitemap entries", async () => {
  const controller = createOutboundAccessController({
    lookupFn: makeLookup({
      "public.example": [{ address: PUBLIC_IPV4, family: 4 }]
    })
  });

  await withMockedFetch(async (url) => {
    if (url === "https://public.example/robots.txt") {
      return new Response([
        "User-agent: *",
        "Disallow: /private",
        "Sitemap: https://public.example/sitemap-index.xml"
      ].join("\n"), {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    throw new Error(`Unexpected fetch for ${url}`);
  }, async () => {
    const robots = await fetchRobots("https://public.example", 2000, USER_AGENT, controller);

    assert.ok(robots);
    assert.equal(robots.isAllowed("https://public.example/private", USER_AGENT), false);
    assert.deepEqual(robots.getSitemaps(), ["https://public.example/sitemap-index.xml"]);
  });
});

test("fetchSitemapUrls follows sitemap indexes, validates redirect targets, and returns discovered URLs", async () => {
  const controller = createOutboundAccessController({
    lookupFn: makeLookup({
      "public.example": [{ address: PUBLIC_IPV4, family: 4 }],
      "cdn.public.example": [{ address: PUBLIC_IPV4, family: 4 }]
    })
  });

  const robots = {
    getSitemaps() {
      return ["https://public.example/sitemap-index.xml"];
    }
  };

  await withMockedFetch(async (url) => {
    if (url === "https://public.example/sitemap-index.xml") {
      return new Response([
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<sitemapindex xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">",
        "  <sitemap><loc>https://cdn.public.example/redirect-sitemap.xml</loc></sitemap>",
        "</sitemapindex>"
      ].join(""), {
        status: 200,
        headers: { "Content-Type": "application/xml" }
      });
    }

    if (url === "https://cdn.public.example/redirect-sitemap.xml") {
      return new Response("", {
        status: 301,
        headers: { Location: "https://cdn.public.example/final-sitemap.xml" }
      });
    }

    if (url === "https://cdn.public.example/final-sitemap.xml") {
      return new Response([
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">",
        "  <url><loc>https://public.example/</loc></url>",
        "  <url><loc>https://public.example/about</loc></url>",
        "</urlset>"
      ].join(""), {
        status: 200,
        headers: { "Content-Type": "text/xml" }
      });
    }

    throw new Error(`Unexpected fetch for ${url}`);
  }, async () => {
    const urls = await fetchSitemapUrls("https://public.example", 2000, robots, USER_AGENT, controller);
    assert.deepEqual(urls, ["https://public.example/", "https://public.example/about"]);
  });
});

test("fetchTextResource rejects incorrect robots and sitemap content types", async () => {
  const controller = createOutboundAccessController({
    lookupFn: makeLookup({
      "public.example": [{ address: PUBLIC_IPV4, family: 4 }]
    })
  });

  await withMockedFetch(async (url) => {
    if (url === "https://public.example/html-robots.txt") {
      return new Response("<html><body>not robots</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" }
      });
    }

    if (url === "https://public.example/json-sitemap.xml") {
      return new Response(JSON.stringify({ urls: ["https://public.example/"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    throw new Error(`Unexpected fetch for ${url}`);
  }, async () => {
    const robotsResult = await fetchTextResource("https://public.example/html-robots.txt", {
      timeoutMs: 2000,
      robots: null,
      userAgent: USER_AGENT,
      accept: "text/plain,text/*;q=0.9,*/*;q=0.8",
      resourceLabel: "robots.txt",
      isValidContentType: isRobotsContentType,
      outboundController: controller
    });

    const sitemapResult = await fetchTextResource("https://public.example/json-sitemap.xml", {
      timeoutMs: 2000,
      robots: null,
      userAgent: USER_AGENT,
      accept: "application/xml,text/xml,application/*+xml,text/*+xml;q=0.9,*/*;q=0.8",
      resourceLabel: "sitemap XML",
      isValidContentType: isXmlContentType,
      outboundController: controller
    });

    assert.equal(robotsResult.ok, false);
    assert.match(robotsResult.error, /unsupported content-type: text\/html/);
    assert.equal(sitemapResult.ok, false);
    assert.match(sitemapResult.error, /unsupported content-type: application\/json/);
  });
});

test("parseSitemapXml rejects malformed XML", () => {
  const parsed = parseSitemapXml([
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<urlset>",
    "  <url><loc>https://example.com/</loc>",
    "</urlset>"
  ].join(""));

  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /did not match|ended before closing/);
});

test("fetchWithRedirects enforces outbound response size limits", async () => {
  const controller = createOutboundAccessController({
    lookupFn: makeLookup({
      "public.example": [{ address: PUBLIC_IPV4, family: 4 }]
    })
  });

  await withMockedFetch(async () => {
    return new Response("x".repeat(32), {
      status: 200,
      headers: { "Content-Type": "text/plain" }
    });
  }, async () => {
    const result = await fetchWithRedirects("https://public.example/large", {
      method: "GET",
      timeoutMs: 2000,
      robots: null,
      userAgent: USER_AGENT,
      accept: "*/*",
      outboundController: controller,
      maxResponseBytes: 16,
      responseLabel: "HTML page",
      readBody: true
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 413);
    assert.equal(result.errorCode, "OUTBOUND_RESPONSE_TOO_LARGE");
    assert.match(result.error, /configured response size limit/);
  });
});

test("api enforces request body limits with structured errors", async () => {
  await withApiServer(async (server) => {
    const oversizedBody = JSON.stringify({
      url: "https://93.184.216.34",
      padding: "x".repeat(70 * 1024)
    });

    const response = await requestJson(server, {
      method: "POST",
      path: "/api/crawl",
      body: oversizedBody,
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "203.0.113.10"
      }
    });

    assert.equal(response.status, 413);
    assert.equal(response.json?.code, "REQUEST_BODY_TOO_LARGE");
  });
});

test("health endpoint returns service health and a request id", async () => {
  await withApiServer(async (server) => {
    const response = await requestJson(server, {
      method: "GET",
      path: "/healthz"
    });

    assert.equal(response.status, 200);
    assert.equal(response.json?.status, "ok");
    assert.equal(typeof response.json?.service, "string");
    assert.equal(typeof response.json?.environment, "string");
    assert.equal(typeof response.json?.uptimeSec, "number");
    assert.equal(typeof response.json?.activeCrawls, "number");
    assert.ok(response.headers["x-request-id"]);
  });
});

test("readiness endpoint reports the service as ready when not shutting down", async () => {
  await withApiServer(async (server) => {
    const response = await requestJson(server, {
      method: "GET",
      path: "/readyz"
    });

    assert.equal(response.status, 200);
    assert.equal(response.json?.ready, true);
    assert.equal(response.json?.shuttingDown, false);
    assert.equal(typeof response.json?.maxActiveCrawls, "number");
    assert.equal(typeof response.json?.maxQueuedCrawls, "number");
    assert.ok(response.headers["x-request-id"]);
  });
});

test("known api routes still work before the api not-found boundary", async () => {
  await withMockedFetch(async (url) => {
    if (url === "https://93.184.216.34/robots.txt") {
      return new Response("User-agent: *\n", {
        status: 200,
        headers: { "Content-Type": "text/plain" }
      });
    }

    if (url === "https://93.184.216.34/sitemap.xml") {
      return new Response("not found", {
        status: 404,
        headers: { "Content-Type": "text/plain" }
      });
    }

    if (url === "https://93.184.216.34") {
      return new Response("<html><body><main>ok</main></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" }
      });
    }

    throw new Error(`Unexpected fetch for ${url}`);
  }, async () => {
    await withApiServer(async (server) => {
      const response = await requestJson(server, {
        method: "POST",
        path: "/api/crawl/start",
        body: {
          url: "https://93.184.216.34",
          options: { maxPages: 1, concurrency: 1 }
        }
      });

      assert.equal(response.status, 200);
      assert.match(String(response.headers["content-type"] || ""), /^application\/json\b/i);
      assert.equal(typeof response.json?.jobId, "string");
      assert.ok(response.json?.jobId);
    });
  });
});

test("unknown api get routes return structured api 404 responses instead of spa html", async () => {
  await withApiServer(async (server) => {
    const response = await requestJson(server, {
      method: "GET",
      path: "/api/does-not-exist"
    });

    assert.equal(response.status, 404);
    assert.match(String(response.headers["content-type"] || ""), /^application\/json\b/i);
    assert.equal(response.json?.error, "API route not found");
    assert.equal(response.json?.code, "API_ROUTE_NOT_FOUND");
    assert.equal(response.json?.details, null);
    assert.equal(typeof response.json?.requestId, "string");
    assert.ok(response.json?.requestId);
    assert.doesNotMatch(response.text, /<!doctype html>/i);
    assert.doesNotMatch(response.text, /<div id="root">/i);
  });
});

test("removed /api/config route returns api 404 instead of fake config json", async () => {
  await withApiServer(async (server) => {
    const response = await requestJson(server, {
      method: "GET",
      path: "/api/config"
    });

    assert.equal(response.status, 404);
    assert.match(String(response.headers["content-type"] || ""), /^application\/json\b/i);
    assert.equal(response.json?.error, "API route not found");
    assert.equal(response.json?.code, "API_ROUTE_NOT_FOUND");
    assert.equal(response.json?.details, null);
    assert.equal(typeof response.json?.requestId, "string");
    assert.ok(response.json?.requestId);
    assert.doesNotMatch(JSON.stringify(response.json), /pinRequired/);
    assert.doesNotMatch(response.text, /<!doctype html>/i);
  });
});

test("removed /api/auth route returns api 404 instead of fake auth success", async () => {
  await withApiServer(async (server) => {
    const response = await requestJson(server, {
      method: "POST",
      path: "/api/auth",
      body: {
        pin: "1234"
      }
    });

    assert.equal(response.status, 404);
    assert.match(String(response.headers["content-type"] || ""), /^application\/json\b/i);
    assert.equal(response.json?.error, "API route not found");
    assert.equal(response.json?.code, "API_ROUTE_NOT_FOUND");
    assert.equal(response.json?.details, null);
    assert.equal(typeof response.json?.requestId, "string");
    assert.ok(response.json?.requestId);
    assert.doesNotMatch(JSON.stringify(response.json), /pinRequired|\"ok\":true/);
  });
});

test("non-api frontend routes still serve the spa shell", async () => {
  await withApiServer(async (server) => {
    const response = await requestJson(server, {
      method: "GET",
      path: "/reports/site-audit"
    });

    assert.equal(response.status, 200);
    assert.match(String(response.headers["content-type"] || ""), /^text\/html\b/i);
    assert.equal(response.json, null);
    assert.match(response.text, /<!doctype html>/i);
    assert.match(response.text, /<div id="root"><\/div>/i);
  });
});

test("request logging emits structured JSON for api requests", async () => {
  await withCapturedConsole(async (entries) => {
    await withMockedFetch(async (url) => {
      if (url === "https://93.184.216.34/robots.txt") {
        return new Response("User-agent: *\n", {
          status: 200,
          headers: { "Content-Type": "text/plain" }
        });
      }

      if (url === "https://93.184.216.34/sitemap.xml") {
        return new Response("not found", {
          status: 404,
          headers: { "Content-Type": "text/plain" }
        });
      }

      if (url === "https://93.184.216.34") {
        return new Response("<html><body><main>ok</main></body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" }
        });
      }

      throw new Error(`Unexpected fetch for ${url}`);
    }, async () => {
      await withApiServer(async (server) => {
        const response = await requestJson(server, {
          method: "POST",
          path: "/api/crawl/start",
          body: {
            url: "https://93.184.216.34",
            options: { maxPages: 1, concurrency: 1 }
          },
          headers: {
            "X-Forwarded-For": "203.0.113.16",
            "User-Agent": "SiteCrawlerTest/1.0"
          }
        });

        assert.equal(response.status, 200);
        assert.ok(response.headers["x-request-id"]);
      }, { trustProxy: TRUST_PROXY_LOOPBACK });
    });

    const requestLogLine = entries.info.find((line) => {
      try {
        return JSON.parse(line).event === "http.request.completed";
      } catch {
        return false;
      }
    });

    assert.ok(requestLogLine);
    const requestLog = JSON.parse(requestLogLine);
    assert.equal(requestLog.level, "info");
    assert.equal(requestLog.event, "http.request.completed");
    assert.equal(requestLog.method, "POST");
    assert.equal(requestLog.path, "/api/crawl/start");
    assert.equal(requestLog.statusCode, 200);
    assert.equal(requestLog.ip, "203.0.113.16");
    assert.equal(requestLog.ipSource, "forwarded");
    assert.equal(requestLog.userAgent, "SiteCrawlerTest/1.0");
    assert.deepEqual(requestLog.queryKeys, []);
    assert.equal(typeof requestLog.durationMs, "number");
    assert.equal(typeof requestLog.requestId, "string");
    assert.ok(requestLog.requestId);
  });
});

test("request logging ignores X-Forwarded-For when proxy trust is disabled", async () => {
  await withCapturedConsole(async (entries) => {
    await withMockedFetch(async (url) => {
      if (url === "https://93.184.216.34/robots.txt") {
        return new Response("User-agent: *\n", {
          status: 200,
          headers: { "Content-Type": "text/plain" }
        });
      }

      if (url === "https://93.184.216.34/sitemap.xml") {
        return new Response("not found", {
          status: 404,
          headers: { "Content-Type": "text/plain" }
        });
      }

      if (url === "https://93.184.216.34") {
        return new Response("<html><body><main>ok</main></body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" }
        });
      }

      throw new Error(`Unexpected fetch for ${url}`);
    }, async () => {
      await withApiServer(async (server) => {
        const response = await requestJson(server, {
          method: "POST",
          path: "/api/crawl/start",
          body: {
            url: "https://93.184.216.34",
            options: { maxPages: 1, concurrency: 1 }
          },
          headers: {
            "X-Forwarded-For": "203.0.113.99",
            "User-Agent": "SiteCrawlerTest/1.0"
          }
        });

        assert.equal(response.status, 200);
      }, { trustProxy: false });
    });

    const requestLogLine = entries.info.find((line) => {
      try {
        return JSON.parse(line).event === "http.request.completed";
      } catch {
        return false;
      }
    });

    assert.ok(requestLogLine);
    const requestLog = JSON.parse(requestLogLine);
    assert.match(requestLog.ip, /127\.0\.0\.1|::ffff:127\.0\.0\.1/);
    assert.equal(requestLog.ipSource, "socket");
  });
});

test("background job failures sanitize client error payloads and retain internal diagnostics in logs", async () => {
  await withCapturedConsole(async (entries) => {
    await withApiServer(async (server) => {
      const createResponse = await requestJson(server, {
        method: "POST",
        path: "/api/crawl/start",
        body: {
          url: "https://93.184.216.34",
          options: { maxPages: 1, concurrency: 1 }
        }
      });

      assert.equal(createResponse.status, 200);
      const jobId = createResponse.json?.jobId;
      assert.ok(jobId);

      const failedResponse = await waitForJobStatus(server, jobId, "failed");

      assert.equal(failedResponse.status, 200);
      assert.equal(failedResponse.json?.status, "failed");
      assert.equal(failedResponse.json?.error, "Internal server error");
      assert.equal(failedResponse.json?.errorCode, "INTERNAL_ERROR");
      assert.equal(failedResponse.json?.errorDetails, null);
      assert.equal(failedResponse.json?.progress?.phase, "failed");
      assert.equal(failedResponse.json?.progress?.message, "Internal server error");
      assert.doesNotMatch(String(failedResponse.json?.error || ""), /database connection failed/i);
      assert.doesNotMatch(String(failedResponse.json?.progress?.message || ""), /database connection failed/i);
    }, {
      crawlExecutor: async () => {
        throw new Error("database connection failed");
      }
    });

    const failureLogLine = entries.error.find((line) => {
      try {
        return JSON.parse(line).event === "crawl.job.failed";
      } catch {
        return false;
      }
    });

    assert.ok(failureLogLine);
    const failureLog = JSON.parse(failureLogLine);
    assert.equal(failureLog.level, "error");
    assert.equal(failureLog.event, "crawl.job.failed");
    assert.equal(failureLog.clientErrorCode, "INTERNAL_ERROR");
    assert.equal(failureLog.error?.message, "database connection failed");
    assert.match(String(failureLog.error?.stack || ""), /database connection failed/);
  });
});

test("background jobs do not expose internal ApiError messages or details through job status", async () => {
  await withCapturedConsole(async (entries) => {
    await withApiServer(async (server) => {
      const createResponse = await requestJson(server, {
        method: "POST",
        path: "/api/crawl/start",
        body: {
          url: "https://93.184.216.34",
          options: {
            maxPages: 301,
            concurrency: 1
          }
        }
      });

      assert.equal(createResponse.status, 200);
      const jobId = createResponse.json?.jobId;
      assert.ok(jobId);

      const failedResponse = await waitForJobStatus(server, jobId, "failed");

      assert.equal(failedResponse.status, 200);
      assert.equal(failedResponse.json?.status, "failed");
      assert.equal(failedResponse.json?.error, "Internal server error");
      assert.equal(failedResponse.json?.errorCode, "INTERNAL_ERROR");
      assert.equal(failedResponse.json?.errorDetails, null);
      assert.equal(failedResponse.json?.progress?.phase, "failed");
      assert.equal(failedResponse.json?.progress?.message, "Internal server error");
      assert.doesNotMatch(String(failedResponse.json?.error || ""), /maxPages must be between/i);
      assert.doesNotMatch(String(failedResponse.json?.progress?.message || ""), /maxPages must be between/i);
      assert.doesNotMatch(JSON.stringify(failedResponse.json), /OPTION_LIMIT_EXCEEDED/);
      assert.doesNotMatch(JSON.stringify(failedResponse.json), /"option":"maxPages"/);
    });

    const failureLogLine = entries.error.find((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed.event === "crawl.job.failed" && parsed.error?.code === "OPTION_LIMIT_EXCEEDED";
      } catch {
        return false;
      }
    });

    assert.ok(failureLogLine);
    const failureLog = JSON.parse(failureLogLine);
    assert.equal(failureLog.level, "error");
    assert.equal(failureLog.event, "crawl.job.failed");
    assert.equal(failureLog.clientErrorCode, "INTERNAL_ERROR");
    assert.equal(failureLog.error?.message, "maxPages must be between 1 and 300");
    assert.equal(failureLog.error?.code, "OPTION_LIMIT_EXCEEDED");
    assert.equal(failureLog.error?.details?.option, "maxPages");
    assert.equal(failureLog.error?.details?.max, 300);
  });
});

test("background crawl jobs remain readable after an API server restart when durable job storage is used", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "crawl-jobs.json");

    await withMockedFetch(async (url) => {
      if (url === "https://93.184.216.34/robots.txt") {
        return new Response("User-agent: *\n", {
          status: 200,
          headers: { "Content-Type": "text/plain" }
        });
      }

      if (url === "https://93.184.216.34/sitemap.xml") {
        return new Response("not found", {
          status: 404,
          headers: { "Content-Type": "text/plain" }
        });
      }

      if (url === "https://93.184.216.34") {
        return new Response("<html><body><main>ok</main></body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" }
        });
      }

      throw new Error(`Unexpected fetch for ${url}`);
    }, async () => {
      let jobId = "";

      await withApiServer(async (server) => {
        const createResponse = await requestJson(server, {
          method: "POST",
          path: "/api/crawl/start",
          body: {
            url: "https://93.184.216.34",
            options: { maxPages: 1, concurrency: 1 }
          }
        });

        assert.equal(createResponse.status, 200);
        jobId = String(createResponse.json?.jobId || "");
        assert.ok(jobId);

        const completedJob = await waitForJobCompletion(server, jobId);
        assert.equal(completedJob.status, "completed");
        assert.ok(completedJob.result);
      }, {
        jobStore: createFileCrawlJobStore({ filePath })
      });

      await withApiServer(async (server) => {
        const readResponse = await requestJson(server, {
          method: "GET",
          path: `/api/crawl/${jobId}`
        });

        assert.equal(readResponse.status, 200);
        assert.equal(readResponse.json?.status, "completed");
        assert.equal(readResponse.json?.jobId, jobId);
        assert.ok(readResponse.json?.result);
        assert.equal(readResponse.json?.result?.counts?.crawled, 1);
      }, {
        jobStore: createFileCrawlJobStore({ filePath })
      });
    });
  });
});

test("api rejects crawl options that exceed configured hard limits", async () => {
  await withApiServer(async (server) => {
    const response = await requestJson(server, {
      method: "POST",
      path: "/api/crawl",
      body: {
        url: "https://93.184.216.34",
        options: {
          maxPages: 301,
          concurrency: 6
        }
      },
      headers: {
        "X-Forwarded-For": "203.0.113.15"
      }
    });

    assert.equal(response.status, 400);
    assert.equal(response.json?.code, "OPTION_LIMIT_EXCEEDED");
    assert.equal(response.json?.details?.option, "maxPages");
    assert.equal(response.json?.details?.max, 300);
  });
});

test("api rate limits crawl starts per IP", async () => {
  await withMockedFetch(async (url) => {
    if (url === "https://93.184.216.34/robots.txt") {
      return new Response("User-agent: *\n", {
        status: 200,
        headers: { "Content-Type": "text/plain" }
      });
    }

    if (url === "https://93.184.216.34/sitemap.xml") {
      return new Response("not found", {
        status: 404,
        headers: { "Content-Type": "text/plain" }
      });
    }

    if (url === "https://93.184.216.34") {
      return new Response("<html><body><main>ok</main></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" }
      });
    }

    throw new Error(`Unexpected fetch for ${url}`);
  }, async () => {
    await withApiServer(async (server) => {
      let lastResponse = null;
      for (let i = 0; i < 11; i++) {
        lastResponse = await requestJson(server, {
          method: "POST",
          path: "/api/crawl/start",
          body: {
            url: "https://93.184.216.34",
            options: { maxPages: 1, concurrency: 1 }
          },
          headers: {
            "X-Forwarded-For": "203.0.113.11"
          }
        });
      }

      assert.equal(lastResponse?.status, 429);
      assert.equal(lastResponse?.json?.code, "RATE_LIMIT_EXCEEDED");
    }, { trustProxy: TRUST_PROXY_LOOPBACK });
  });
});

test("api rate limits completed job result fetches per IP", async () => {
  await withMockedFetch(async (url) => {
    if (url === "https://93.184.216.34/robots.txt") {
      return new Response("User-agent: *\n", {
        status: 200,
        headers: { "Content-Type": "text/plain" }
      });
    }

    if (url === "https://93.184.216.34/sitemap.xml") {
      return new Response("not found", {
        status: 404,
        headers: { "Content-Type": "text/plain" }
      });
    }

    if (url === "https://93.184.216.34") {
      return new Response("<html><body><main>ok</main></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" }
      });
    }

    throw new Error(`Unexpected fetch for ${url}`);
  }, async () => {
    await withApiServer(async (server) => {
      const createResponse = await requestJson(server, {
        method: "POST",
        path: "/api/crawl/start",
        body: {
          url: "https://93.184.216.34",
          options: { maxPages: 1, concurrency: 1 }
        },
        headers: {
          "X-Forwarded-For": "203.0.113.12"
        }
      });

      assert.equal(createResponse.status, 200);
      const jobId = createResponse.json?.jobId;
      assert.ok(jobId);

      await waitForJobCompletion(server, jobId, "203.0.113.12");

      let lastResponse = null;
      for (let i = 0; i < 31; i++) {
        lastResponse = await requestJson(server, {
          method: "GET",
          path: `/api/crawl/${jobId}`,
          headers: {
            "X-Forwarded-For": "203.0.113.12"
          }
        });
      }

      assert.equal(lastResponse?.status, 429);
      assert.equal(lastResponse?.json?.code, "RATE_LIMIT_EXCEEDED");
    }, { trustProxy: TRUST_PROXY_LOOPBACK });
  });
});

test("api rate limits in-progress crawl status polling per IP", async () => {
  let releasePage = () => {};
  const pageHold = new Promise((resolve) => {
    releasePage = resolve;
  });

  await withMockedFetch(async (url) => {
    if (url === "https://93.184.216.34/robots.txt") {
      return new Response("User-agent: *\n", {
        status: 200,
        headers: { "Content-Type": "text/plain" }
      });
    }

    if (url === "https://93.184.216.34/sitemap.xml") {
      return new Response("not found", {
        status: 404,
        headers: { "Content-Type": "text/plain" }
      });
    }

    if (url === "https://93.184.216.34") {
      await pageHold;
      return new Response("<html><body><main>ok</main></body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" }
      });
    }

    throw new Error(`Unexpected fetch for ${url}`);
  }, async () => {
    await withApiServer(async (server) => {
      const createResponse = await requestJson(server, {
        method: "POST",
        path: "/api/crawl/start",
        body: {
          url: "https://93.184.216.34",
          options: { maxPages: 1, concurrency: 1 }
        },
        headers: {
          "X-Forwarded-For": "203.0.113.13"
        }
      });

      assert.equal(createResponse.status, 200);
      const jobId = createResponse.json?.jobId;
      assert.ok(jobId);

      let lastResponse = null;
      for (let i = 0; i < 121; i++) {
        lastResponse = await requestJson(server, {
          method: "GET",
          path: `/api/crawl/${jobId}`,
          headers: {
            "X-Forwarded-For": "203.0.113.13"
          }
        });
      }

      assert.equal(lastResponse?.status, 429);
      assert.equal(lastResponse?.json?.code, "RATE_LIMIT_EXCEEDED");
      releasePage();
      await waitForJobCompletion(server, jobId, "203.0.113.14");
    }, { trustProxy: TRUST_PROXY_LOOPBACK });
  });
});
