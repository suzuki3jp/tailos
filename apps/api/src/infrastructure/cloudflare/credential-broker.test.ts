import { assert, expect, test, type TestContext } from "vitest";
import { fileURLToPath } from "node:url";
import { ClaudeAccess, CodexAccess } from "@tailos/core/runner";
import * as v from "valibot";
import { build } from "esbuild";
import {
  Miniflare,
  Response as MiniflareResponse,
  convertV4MiniflareOptions,
} from "miniflare";

async function createBroker(t: TestContext, openAIStatus = 530) {
  const bundled = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      contents: `
        import { CodexDeviceAuth, ReauthenticationRequired } from "@/infrastructure/auth/codex-device.ts";
        import { CredentialBroker } from "@/infrastructure/cloudflare/credential-broker.ts";
        import { TransientDevicePollError } from "@/application/auth/device.ts";
        import { DurableObject } from "cloudflare:workers";

        export class TestRunner extends DurableObject {
          async codexModels(access) {
            if (access.accessToken !== "secret-access" || access.accountId !== "test-account" ||
                "refreshToken" in access) throw new Error("Unexpected credentials");
            return [{ model: "test-model", efforts: ["high"] }];
          }
        }

        export class TestBroker extends CredentialBroker {
          decision = "pending";
          rotations = 0;
          adapter = {
            begin: async () => {
              if (this.decision === "failure") {
                return new CodexDeviceAuth().begin();
              }
              return {
                id: "opaque",
                userCode: "DISPLAY",
                verificationUrl: "https://auth.openai.com/codex/device",
                intervalMs: 60000,
                expiresAt: Date.now() + (this.decision === "expired" ? -1 : 900000),
              };
            },
            complete: async () => {
              if (this.decision === "transient") throw new TransientDevicePollError();
              return this.decision.startsWith("approved") ? {
                refreshToken: "secret-refresh",
                accessToken: "secret-access",
                idToken: "secret-id",
                accountId: "test-account",
                expiresAt: Date.now() + (this.decision === "approved-expired" ? -1 : 900000),
              } : null;
            },
            refresh: async (previous) => {
              if (this.decision === "revoked") throw new ReauthenticationRequired();
              this.rotations++;
              return {
                ...previous,
                accessToken: "rotated-access-" + this.rotations,
                expiresAt: Date.now() + 900000,
              };
            },
          };
          async tick(decision) {
            this.decision = decision;
            await this.ctx.storage.deleteAlarm();
            await this.alarm();
            return this.status();
          }
          async setDecision(decision) {
            this.decision = decision;
          }
          async resetThrottle() {
            await this.ctx.storage.delete("lastStarted");
          }
          async captureBeginWarnings() {
            const warnings = [];
            const warn = console.warn;
            console.warn = (...args) => warnings.push(args);
            try {
              const started = await this.begin();
              return { started, warnings };
            } finally {
              console.warn = warn;
            }
          }
          async stored() {
            return {
              alarm: await this.ctx.storage.getAlarm(),
              connection: await this.ctx.storage.get("connection"),
              claude: await this.ctx.storage.get("claude"),
            };
          }
        }
        export default {
          async fetch(request, env) {
            const broker = env.TEST_BROKER.getByName("test");
            const { action, decision } = await request.json();
            const result = await broker[action](decision);
            return Response.json(result ?? null);
          },
        };
      `,
    },
    bundle: true,
    format: "esm",
    external: ["cloudflare:workers"],
    write: false,
  });
  const worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundled.outputFiles[0].text,
      compatibilityDate: "2026-10-06",
      outboundService(request) {
        expect(request.url).toBe(
          "https://auth.openai.com/api/accounts/deviceauth/usercode",
        );
        expect(request.method).toBe("POST");
        return new MiniflareResponse("sensitive upstream response", {
          status: openAIStatus,
          headers:
            openAIStatus === 302
              ? { Location: "https://unexpected.example/" }
              : undefined,
        });
      },
      bindings: {
        CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
      },
      durableObjects: {
        TEST_BROKER: { className: "TestBroker", useSQLite: true },
        RUNNER: { className: "TestRunner", useSQLite: true },
      },
    }),
  );
  t.onTestFinished(() => worker.dispose());

  return async (action: string, decision?: unknown) => {
    const response = await worker.dispatchFetch("http://worker", {
      method: "POST",
      body: JSON.stringify({ action, decision }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  };
}

test("the Durable Object polls, completes, rejects reconnects and clears its alarm", async (t) => {
  const rpc = await createBroker(t);
  expect(await rpc("begin")).toBe(true);
  expect(await rpc("begin")).toBe(true);
  expect(await rpc("tick", "pending")).toStrictEqual({
    state: "pending",
    userCode: "DISPLAY",
    verificationUrl: "https://auth.openai.com/codex/device",
  });
  expect(JSON.stringify(await rpc("tick", "transient"))).toMatch(/pending/);
  expect(await rpc("tick", "approved")).toStrictEqual({ state: "connected" });
  expect(await rpc("begin")).toBe(false);
  expect(await rpc("status")).toStrictEqual({ state: "connected" });
  const connected = await rpc("stored");
  expect(JSON.stringify(connected)).toMatch(/ciphertext/);
  expect(JSON.stringify(connected)).not.toMatch(/secret-/);

  await rpc("disconnect");
  expect(await rpc("stored")).toStrictEqual({ alarm: null });
  expect(await rpc("begin")).toBe(false);

  await rpc("resetThrottle");
  await rpc("setDecision", "expired");
  expect(await rpc("begin")).toBe(true);
  expect(await rpc("tick", "pending")).toStrictEqual({ state: "expired" });
  expect(await rpc("stored")).toStrictEqual({ alarm: null });
});

test("model catalog lookup uses the owner's connection through Runner RPC", async (t) => {
  const rpc = await createBroker(t);
  expect(await rpc("codexModels")).toBeNull();
  await rpc("begin");
  await rpc("tick", "approved");
  expect(await rpc("codexModels")).toEqual([
    { model: "test-model", efforts: ["high"] },
  ]);
  await rpc("disconnect");
  expect(await rpc("codexModels")).toBeNull();
});

test.for([530, 302])(
  "logs only the stage and status when the Workers fetch returns HTTP %s",
  async (status, t) => {
    const rpc = await createBroker(t, status);
    await rpc("setDecision", "failure");
    expect(await rpc("captureBeginWarnings")).toStrictEqual({
      started: false,
      warnings: [
        [
          {
            event: "chatgpt_connection_step_failed",
            stage: "request_device_code",
            retrying: false,
            openaiStatus: status,
          },
        ],
      ],
    });
    expect(await rpc("status")).toStrictEqual({ state: "failed" });
  },
);

test("serializes access rotation and invalidates a revoked connection", async (t) => {
  const rpc = await createBroker(t);
  expect(await rpc("begin")).toBe(true);
  expect(await rpc("tick", "approved-expired")).toStrictEqual({
    state: "connected",
  });

  const initial = v.parse(CodexAccess, await rpc("issueAccess"));
  expect(initial.accessToken).toBe("rotated-access-1");
  expect(await rpc("issueAccess")).toStrictEqual(initial);
  expect(
    await rpc("issueAccess", {
      connectionVersion: crypto.randomUUID(),
      accessVersion: initial.accessVersion,
    }),
  ).toBe(null);

  const rejected = {
    connectionVersion: initial.connectionVersion,
    accessVersion: initial.accessVersion,
  };
  const [leftResponse, right] = await Promise.all([
    rpc("issueAccess", rejected),
    rpc("issueAccess", rejected),
  ]);
  const left = v.parse(CodexAccess, leftResponse);
  expect(left).toStrictEqual(right);
  expect(left.accessToken).toBe("rotated-access-2");
  expect(left.accessVersion).not.toBe(initial.accessVersion);

  await rpc("setDecision", "revoked");
  expect(
    await rpc("issueAccess", {
      connectionVersion: left.connectionVersion,
      accessVersion: left.accessVersion,
    }),
  ).toBe(null);
  expect(await rpc("status")).toStrictEqual({ state: "failed" });
  expect(await rpc("issueAccess")).toBe(null);
});

test("stores a pasted Claude token encrypted and hands it out until disconnected", async (t) => {
  const rpc = await createBroker(t);
  const token = "sk-ant-oat01-" + "a".repeat(64);
  expect(await rpc("claudeStatus")).toStrictEqual({ state: "disconnected" });
  expect(await rpc("issueClaudeAccess")).toBe(null);

  const before = Date.now();
  expect(await rpc("saveClaudeToken", token)).toBe(true);
  // Replacing a saved token requires disconnecting first.
  expect(await rpc("saveClaudeToken", "sk-ant-oat01-" + "b".repeat(64))).toBe(
    false,
  );
  const stored = JSON.stringify(await rpc("stored"));
  expect(stored).toMatch(/ciphertext/);
  expect(stored).not.toContain(token);

  const status = await rpc("claudeStatus");
  expect(status).toMatchObject({ state: "connected", expiry: "valid" });
  expect(JSON.stringify(status)).not.toContain(token);
  assert(status && typeof status === "object" && "savedAt" in status);
  expect(status.savedAt).toBeGreaterThanOrEqual(before);
  // The ChatGPT connection of the same object is unaffected.
  expect(await rpc("status")).toStrictEqual({ state: "disconnected" });

  const access = v.parse(ClaudeAccess, await rpc("issueClaudeAccess"));
  expect(access.token).toBe(token);
  expect(await rpc("issueClaudeAccess")).toStrictEqual(access);

  await rpc("disconnect");
  expect(await rpc("claudeStatus")).toStrictEqual({ state: "disconnected" });
  expect(await rpc("issueClaudeAccess")).toBe(null);
  expect(await rpc("stored")).toStrictEqual({ alarm: null });
});
