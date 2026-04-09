#!/usr/bin/env node
/**
 * Ensures docs/config.js in the repo is safe to publish (no local / loopback origins).
 * Run in CI before tests overwrite config.js for local validation.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { assertAllowedPublicAppOrigin } from "./lib/public-origin.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const configPath = path.join(rootDir, "docs", "config.js");

function main() {
  const src = fs.readFileSync(configPath, "utf8");
  const ctx = { window: {} };
  vm.runInNewContext(src, ctx, { filename: "docs/config.js" });
  const c = ctx.window.CAT_CRAWLER_PUBLIC_CONFIG;

  if (!c || typeof c !== "object") {
    throw new Error("docs/config.js must define window.CAT_CRAWLER_PUBLIC_CONFIG");
  }

  const env = String(c.environment || "").trim().toLowerCase();
  if (env === "local") {
    throw new Error(
      'docs/config.js must not use environment "local" in the repository. ' +
        "For local bookmarklet testing run: APP_ENV=local node scripts/write-public-config.mjs"
    );
  }

  if (!["production", "staging"].includes(env)) {
    throw new Error(`docs/config.js environment must be production or staging, got: ${env || "(missing)"}`);
  }

  const origin = String(c.appOrigin || "").trim();
  assertAllowedPublicAppOrigin(origin, "docs/config.js appOrigin");

  console.log(`Committed docs/config.js OK: ${env} / ${origin}`);
}

main();
