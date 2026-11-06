import assert from "node:assert/strict";
import { test, type TestContext } from "vitest";
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
        import { ReauthenticationRequired } from "./codex-device.ts";
        import { CredentialBroker } from "./credential-broker.ts";
        import { TransientDevicePollError } from "./device.ts";

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
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
}

test("the Durable Object polls, completes, rejects reconnects and clears its alarm", async (t) => {
  const rpc = await createBroker(t);
  assert.equal(await rpc("begin"), true);
  assert.equal(await rpc("begin"), true);
  assert.deepEqual(await rpc("tick", "pending"), {
    state: "pending",
    userCode: "DISPLAY",
    verificationUrl: "https://auth.openai.com/codex/device",
  });
  assert.match(JSON.stringify(await rpc("tick", "transient")), /pending/);
  assert.deepEqual(await rpc("tick", "approved"), { state: "connected" });
  assert.equal(await rpc("begin"), false);
  assert.deepEqual(await rpc("status"), { state: "connected" });
  const connected = await rpc("stored");
  assert.match(JSON.stringify(connected), /ciphertext/);
  assert.doesNotMatch(JSON.stringify(connected), /secret-/);

  await rpc("disconnect");
  assert.deepEqual(await rpc("stored"), { alarm: null });
  assert.equal(await rpc("begin"), false);
  await rpc("resetThrottle");
  await rpc("setDecision", "failure");
  assert.equal(await rpc("begin"), false);
  assert.deepEqual(await rpc("status"), { state: "failed" });

  await rpc("resetThrottle");
  await rpc("setDecision", "expired");
  assert.equal(await rpc("begin"), true);
  assert.deepEqual(await rpc("tick", "pending"), { state: "expired" });
  assert.deepEqual(await rpc("stored"), { alarm: null });
});

test("serializes access rotation and invalidates a revoked connection", async (t) => {
  const rpc = await createBroker(t);
  assert.equal(await rpc("begin"), true);
  assert.deepEqual(await rpc("tick", "approved-expired"), {
    state: "connected",
  });

  const initial = v.parse(codexAccessSchema, await rpc("issueAccess"));
  assert.equal(initial.accessToken, "rotated-access-1");
  assert.deepEqual(await rpc("issueAccess"), initial);
  assert.equal(
    await rpc("issueAccess", {
      connectionVersion: crypto.randomUUID(),
      accessVersion: initial.accessVersion,
    }),
    null,
  );

  const rejected = {
    connectionVersion: initial.connectionVersion,
    accessVersion: initial.accessVersion,
  };
  const [leftResponse, right] = await Promise.all([
    rpc("issueAccess", rejected),
    rpc("issueAccess", rejected),
  ]);
  const left = v.parse(codexAccessSchema, leftResponse);
  assert.deepEqual(left, right);
  assert.equal(left.accessToken, "rotated-access-2");
  assert.notEqual(left.accessVersion, initial.accessVersion);

  await rpc("setDecision", "revoked");
  assert.equal(
    await rpc("issueAccess", {
      connectionVersion: left.connectionVersion,
      accessVersion: left.accessVersion,
    }),
    null,
  );
  assert.deepEqual(await rpc("status"), { state: "failed" });
  assert.equal(await rpc("issueAccess"), null);
});
