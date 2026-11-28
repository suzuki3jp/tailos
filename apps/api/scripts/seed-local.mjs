import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { browserApiOrigin } from "../src/application/auth/login.ts";
import { createLoginAuth } from "../src/infrastructure/auth/login.ts";
import { createLoginSessionCookie } from "../src/infrastructure/auth/session-cookie.ts";
import {
  seedGithubId,
  seedLocalDatabase,
} from "../src/infrastructure/d1/local-seed.ts";

const apiDirectory = new URL("../", import.meta.url);
const configPath = fileURLToPath(new URL("wrangler.jsonc", apiDirectory));
const envFile = ".wrangler/seed.env";
const persistTo = ".wrangler/seed";
const dummyOAuth = "tailos-local-seed";

function ensureSeedEnvironment() {
  mkdirSync(new URL(".wrangler/", apiDirectory), { recursive: true });
  try {
    writeFileSync(
      new URL(envFile, apiDirectory),
      [
        `BETTER_AUTH_SECRET=${randomBytes(32).toString("base64url")}`,
        `TAILOS_GITHUB_OAUTH_CLIENT_ID=${dummyOAuth}`,
        `TAILOS_GITHUB_OAUTH_CLIENT_SECRET=${dummyOAuth}`,
        `TAILOS_OPERATOR_GITHUB_ID=${seedGithubId}`,
        "",
      ].join("\n"),
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

async function main() {
  const { values } = parseArgs({
    options: { "print-cookie": { type: "boolean" } },
  });
  ensureSeedEnvironment();

  execFileSync(
    "wrangler",
    [
      "d1",
      "migrations",
      "apply",
      "DB",
      "--config",
      configPath,
      "--local",
      "--persist-to",
      persistTo,
    ],
    {
      cwd: fileURLToPath(apiDirectory),
      stdio: ["ignore", process.stderr, "inherit"],
    },
  );

  // Keep Wrangler's informational messages out of the Cookie JSON on stdout.
  process.env.WRANGLER_LOG = "warn";
  const { getPlatformProxy } = await import("wrangler");
  const platform = await getPlatformProxy({
    configPath,
    envFiles: [envFile],
    remoteBindings: false,
    // Wrangler's --persist-to appends v3 to its persistence directory.
    persist: { path: fileURLToPath(new URL(`${persistTo}/v3`, apiDirectory)) },
  });
  try {
    const { env } = platform;
    if (
      env.TAILOS_GITHUB_OAUTH_CLIENT_ID !== dummyOAuth ||
      env.TAILOS_GITHUB_OAUTH_CLIENT_SECRET !== dummyOAuth ||
      env.TAILOS_OPERATOR_GITHUB_ID !== seedGithubId
    )
      throw new Error(
        `Expected the dummy authentication settings in ${envFile}.`,
      );

    const auth = createLoginAuth(env);
    const url = browserApiOrigin(env);
    if (!auth || !url) throw new Error(`Invalid login settings in ${envFile}.`);

    const userId = await seedLocalDatabase(env.DB);
    process.stderr.write(
      "Seed data is ready. Start the API with pnpm run dev:seeded.\n",
    );
    if (!values["print-cookie"]) return;

    const { name, value, attributes, expiresAt } =
      await createLoginSessionCookie(auth, userId).catch(() => {
        throw new Error(
          "Could not issue a login Cookie for the seed operator.",
        );
      });
    const sameSite = { lax: "Lax", strict: "Strict", none: "None" }[
      String(attributes.sameSite).toLowerCase()
    ];
    process.stdout.write(
      JSON.stringify({
        name,
        value,
        url,
        httpOnly: attributes.httpOnly,
        secure: attributes.secure,
        sameSite,
        expires: Math.floor(expiresAt.getTime() / 1000),
      }) + "\n",
    );
  } finally {
    await platform.dispose();
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
