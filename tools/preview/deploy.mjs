import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { readLoginConfig } from "../../apps/api/scripts/login-config.mjs";
import { webBrowserApiPath } from "../../packages/core/src/auth.ts";
import { cloudflare, previewDatabase } from "./cloudflare.mjs";
import {
  findApiDeploymentOrigin,
  origins,
  previewName,
  workers,
} from "./config.mjs";

const [number, sha, artifactDir] = process.argv.slice(2);
const name = previewName(number);
if (!/^[\da-f]{40}$/.test(sha ?? "")) throw new Error("Invalid commit SHA");
const { web, api } = origins(name);
const digest = (key, purpose) =>
  createHmac("sha256", key).update(`${purpose}:${name}`).digest("base64url");
const login = readLoginConfig(process.env, web);
if (!login.secrets.BETTER_AUTH_SECRET)
  throw new Error("Missing Preview OAuth credentials");
const secret = digest(login.secrets.BETTER_AUTH_SECRET, "proxy");
login.secrets.BETTER_AUTH_SECRET = digest(
  login.secrets.BETTER_AUTH_SECRET,
  "session",
);
const bucket = {
  binding: "RUN_ARTIFACTS",
  bucket_name: "tailos-preview-run-artifacts",
};
const [database, r2] = await Promise.all([
  previewDatabase(),
  cloudflare(`r2/buckets/${bucket.bucket_name}`),
]);
if (r2.result?.name !== bucket.bucket_name)
  throw new Error(
    "Cloudflare R2 binding must point to the named Preview bucket",
  );

const temp = mkdtempSync(join(tmpdir(), "tailos-preview-"));
const artifacts = resolve(artifactDir);
const wranglerEnv = {
  PATH: process.env.PATH,
  CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
  WRANGLER_SEND_METRICS: "false",
  CI: "true",
};
function deploy(kind, config, secrets) {
  const configPath = join(temp, `${kind}.json`);
  const secretPath = join(temp, `${kind}-secrets.json`);
  writeFileSync(
    configPath,
    JSON.stringify({
      name: workers[kind],
      compatibility_date: "2026-10-06",
      compatibility_flags: ["nodejs_compat"],
      workers_dev: false,
      preview_urls: false,
      no_bundle: true,
      ...config,
    }),
    { mode: 0o600 },
  );
  writeFileSync(secretPath, JSON.stringify(secrets), { mode: 0o600 });
  const output = execFileSync(
    "pnpm",
    [
      "--filter",
      `@tailos/${kind}`,
      "exec",
      "wrangler",
      "preview",
      "--config",
      configPath,
      "--name",
      name,
      "--tag",
      sha,
      "--ignore-base-config",
      "--secrets-file",
      secretPath,
      "--json",
    ],
    {
      env: wranglerEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const expected = kind === "web" ? web : api;
  const { preview, deployment } = JSON.parse(output);
  if (
    preview?.name !== name ||
    !preview.urls?.some((url) => new URL(url).origin === expected)
  )
    throw new Error(
      `Configure the ${kind} Preview custom domain for ${expected}`,
    );
  return deployment;
}

async function verify(origin, healthPath, isReady, headers) {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const response = await fetch(new URL(healthPath, origin), {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      });
      if (await isReady(response)) return;
    } catch {
      // A new Preview's DNS and TLS can take time to become ready.
    }
    await setTimeout(10_000);
  }
  throw new Error(`Preview did not become ready at ${origin}${healthPath}`);
}

const serviceIs = (service) => async (response) => {
  if (!response.ok) return false;
  const body = await response.json();
  return body.status === "ok" && body.service === service;
};

try {
  const proxy = { TAILOS_PREVIEW_PROXY_SECRET: secret };
  const deployment = deploy(
    "api",
    {
      main: join(artifacts, "api/preview.js"),
      previews: {
        vars: {
          ...login.vars,
          TAILOS_WEB_ORIGIN: web,
          TAILOS_BROWSER_API_VIA_WEB: "true",
          TAILOS_PREVIEW: "true",
        },
        d1_databases: [database],
        r2_buckets: [bucket],
        observability: { enabled: true, redact_query_string: true },
      },
    },
    { ...login.secrets, ...proxy },
  );
  const apiDeploymentOrigin = findApiDeploymentOrigin(deployment?.urls, api);
  await verify(apiDeploymentOrigin, "/health", serviceIs("tailos-api"), {
    "X-Tailos-Preview-Proxy": secret,
  });
  deploy(
    "web",
    {
      main: join(artifacts, "web/server/index.js"),
      rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
      assets: {
        directory: join(artifacts, "web/client"),
        binding: "ASSETS",
        run_worker_first: [webBrowserApiPath, `${webBrowserApiPath}/*`],
      },
      previews: {
        vars: { TAILOS_PREVIEW_API_ORIGIN: apiDeploymentOrigin },
        images: { binding: "IMAGES" },
      },
    },
    proxy,
  );
  await verify(web, "/health", serviceIs("tailos-web"));
  // A 401 here proves the public Web reaches the API with the proxy secret.
  await verify(
    web,
    `${webBrowserApiPath}/account`,
    (response) => response.status === 401,
  );
  const loginStart = await fetch(
    new URL(`${webBrowserApiPath}/auth/login`, web),
    {
      method: "POST",
      headers: { Origin: web },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    },
  );
  const location = URL.parse(loginStart.headers.get("Location") ?? "");
  if (
    loginStart.status !== 303 ||
    location?.origin !== "https://github.com" ||
    location.pathname !== "/login/oauth/authorize" ||
    location.searchParams.get("redirect_uri") !==
      `${web}${webBrowserApiPath}/auth/callback/github`
  )
    throw new Error(
      "Preview login did not start with the expected GitHub callback",
    );
  process.stdout.write(`Preview: ${web} (${sha})\n`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `url=${web}\n`);
