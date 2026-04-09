import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertAllowedLocalDocsOrigin, assertAllowedPublicAppOrigin } from "./lib/public-origin.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const defaultDotEnvPath = path.join(rootDir, ".env");
const defaultOutputPath = path.join(rootDir, "docs", "config.js");

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};

  const source = fs.readFileSync(filePath, "utf8");
  const result = {};

  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (!key) continue;

    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

function getEnvValue(name, fallback = "", options = {}) {
  const env = options.env || process.env;
  const dotEnvPath = options.dotEnvPath || defaultDotEnvPath;
  const dotEnvValues = options.dotEnvValues || loadDotEnv(dotEnvPath);

  if (env[name] !== undefined && env[name] !== "") {
    return String(env[name]);
  }

  if (dotEnvValues[name] !== undefined && dotEnvValues[name] !== "") {
    return String(dotEnvValues[name]);
  }

  return fallback;
}

function normalizeEnvironment(input) {
  const value = String(input || "").trim().toLowerCase() || "local";
  if (["local", "staging", "production"].includes(value)) {
    return value;
  }

  throw new Error(`Invalid APP_ENV: ${value}`);
}

function normalizeAppOrigin(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid BOOKMARKLET_APP_ORIGIN: ${raw}`);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Invalid BOOKMARKLET_APP_ORIGIN protocol: ${parsed.protocol}`);
  }

  return parsed.origin;
}

function resolvePublicConfig(options = {}) {
  const dotEnvValues = options.dotEnvValues || loadDotEnv(options.dotEnvPath || defaultDotEnvPath);
  const environment = normalizeEnvironment(getEnvValue("APP_ENV", "local", {
    env: options.env,
    dotEnvPath: options.dotEnvPath,
    dotEnvValues
  }));
  const configuredOrigin = getEnvValue("BOOKMARKLET_APP_ORIGIN", "", {
    env: options.env,
    dotEnvPath: options.dotEnvPath,
    dotEnvValues
  });

  if (configuredOrigin) {
    return {
      environment,
      appOrigin: normalizeAppOrigin(configuredOrigin)
    };
  }

  if (environment === "local") {
    return {
      environment: "local",
      appOrigin: "http://localhost:8080"
    };
  }

  throw new Error(`BOOKMARKLET_APP_ORIGIN is required when APP_ENV=${environment}`);
}

function serializePublicConfig(config) {
  return `window.CAT_CRAWLER_PUBLIC_CONFIG = Object.freeze({
  environment: ${JSON.stringify(config.environment)},
  appOrigin: ${JSON.stringify(config.appOrigin)}
});
`;
}

function writePublicConfig(options = {}) {
  const outputPath = path.resolve(options.outputPath || defaultOutputPath);
  const config = resolvePublicConfig(options);

  if (config.environment === "local") {
    assertAllowedLocalDocsOrigin(config.appOrigin);
  } else {
    assertAllowedPublicAppOrigin(config.appOrigin);
  }

  const output = serializePublicConfig(config);

  fs.writeFileSync(outputPath, output, "utf8");

  return {
    outputPath,
    config
  };
}

const isDirectExecution = process.argv[1] ? path.resolve(process.argv[1]) === __filename : false;

if (isDirectExecution) {
  const { outputPath, config } = writePublicConfig();
  console.log(`Wrote ${path.relative(rootDir, outputPath)} for ${config.environment}: ${config.appOrigin}`);
}

export {
  defaultDotEnvPath,
  defaultOutputPath,
  loadDotEnv,
  normalizeAppOrigin,
  resolvePublicConfig,
  serializePublicConfig,
  writePublicConfig
};
