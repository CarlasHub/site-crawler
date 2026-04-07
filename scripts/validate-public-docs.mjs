import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { defaultOutputPath, resolvePublicConfig } from "./write-public-config.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const docsDir = path.join(rootDir, "docs");
const installPath = path.join(docsDir, "install.js");
const indexPath = path.join(docsDir, "index.html");
const landingPath = path.join(docsDir, "landing.html");

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function assertHtmlWiring(filePath) {
  const html = readText(filePath);

  assert.match(html, /id="bookmarkletLink"/, `${path.basename(filePath)} is missing bookmarkletLink`);
  assert.match(html, /<script src="\.\/config\.js"><\/script>/, `${path.basename(filePath)} is missing docs/config.js`);
  assert.match(html, /<script src="\.\/install\.js"><\/script>/, `${path.basename(filePath)} is missing docs/install.js`);
}

function loadPublicConfig(filePath) {
  const context = {
    window: {},
    Object
  };

  vm.runInNewContext(readText(filePath), context, { filename: filePath });

  return JSON.parse(JSON.stringify(context.window.CAT_CRAWLER_PUBLIC_CONFIG));
}

function runInstaller(config, pageUrl) {
  const link = {
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
  };

  const context = {
    window: {
      CAT_CRAWLER_PUBLIC_CONFIG: config,
      location: { href: pageUrl }
    },
    document: {
      getElementById(id) {
        return id === "bookmarkletLink" ? link : null;
      }
    },
    console,
    URL,
    JSON,
    Date,
    Object
  };

  vm.runInNewContext(readText(installPath), context, { filename: installPath });

  const installer = context.window.CAT_CRAWLER_DOCS_INSTALLER;
  assert.ok(installer, "docs/install.js did not expose the installer API");

  return {
    href: link.attributes.href || "",
    installer
  };
}

function validateBookmarkletHref(href, expectedOrigin, pageUrl) {
  assert.ok(href.startsWith("javascript:"), "Bookmarklet href must be a javascript URL");

  const encodedOrigin = encodeURIComponent(expectedOrigin);
  const expectedPrefix = new URL("bookmarklet.js", pageUrl).toString().split("?")[0];

  assert.match(href, /bookmarklet\.js\?appOrigin=/, "Bookmarklet href is missing the bookmarklet appOrigin parameter");
  assert.ok(href.includes(encodedOrigin), "Bookmarklet href does not contain the configured appOrigin");
  assert.ok(href.includes(expectedPrefix), "Bookmarklet href does not point at the docs host bookmarklet.js");
  assert.match(href, /Date\.now\(\)/, "Bookmarklet href is missing the cache-busting timestamp");
}

function main() {
  const expectedConfig = resolvePublicConfig();
  const currentConfig = loadPublicConfig(defaultOutputPath);

  assert.deepEqual(currentConfig, expectedConfig, "docs/config.js does not match the resolved public config for this environment");

  assertHtmlWiring(indexPath);
  assertHtmlWiring(landingPath);

  const indexRun = runInstaller(currentConfig, "https://docs.example.com/index.html");
  const landingRun = runInstaller(currentConfig, "https://docs.example.com/landing.html");

  validateBookmarkletHref(indexRun.href, expectedConfig.appOrigin, "https://docs.example.com/index.html");
  validateBookmarkletHref(landingRun.href, expectedConfig.appOrigin, "https://docs.example.com/landing.html");

  console.log(`Validated docs installer wiring for ${expectedConfig.environment}: ${expectedConfig.appOrigin}`);
}

main();
