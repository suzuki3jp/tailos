import { expect, test, type TestContext } from "vitest";
import { fileURLToPath } from "node:url";
import { codexAccessSchema } from "@meguri/core/runner";
import * as v from "valibot";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

async function createBroker(t: TestContext) {
  const bundled = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      contents: `
        import { ReauthenticationRequired } from "../auth/codex-device.ts";
        import { CredentialBroker } from "./credential-broker.ts";
        import { TransientDevicePollError } from "../../application/auth/device.ts";

        export class TestBroker extends CredentialBroker {
          decision = "pending";
          rotations = 0;
          adapter = {
            begin: async () => {
              if (this.decision === "failure") throw new Error("provider rejected start");
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
          async stored() {
            return {
              alarm: await this.ctx.storage.getAlarm(),
              connection: await this.ctx.storage.get("connection"),
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
      bindings: {
        CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
      },
      durableObjects: {
        TEST_BROKER: { className: "TestBroker", useSQLite: true },
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
  await rpc("setDecision", "failure");
  expect(await rpc("begin")).toBe(false);
  expect(await rpc("status")).toStrictEqual({ state: "failed" });

  await rpc("resetThrottle");
  await rpc("setDecision", "expired");
  expect(await rpc("begin")).toBe(true);
  expect(await rpc("tick", "pending")).toStrictEqual({ state: "expired" });
  expect(await rpc("stored")).toStrictEqual({ alarm: null });
});

test("serializes access rotation and invalidates a revoked connection", async (t) => {
  const rpc = await createBroker(t);
  expect(await rpc("begin")).toBe(true);
  expect(await rpc("tick", "approved-expired")).toStrictEqual({
    state: "connected",
  });

  const initial = v.parse(codexAccessSchema, await rpc("issueAccess"));
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
  const left = v.parse(codexAccessSchema, leftResponse);
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
