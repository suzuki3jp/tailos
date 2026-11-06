import assert from "node:assert/strict";
import { test } from "vitest";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test("the Durable Object polls, completes, rejects reconnects and clears its alarm", async (t) => {
  const bundled = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      contents: `
        import { CredentialBroker } from "./credential-broker.ts";
        import { TransientDevicePollError } from "./device.ts";

        export class TestBroker extends CredentialBroker {
          decision = "pending";
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
              return this.decision === "approved" ? {
                refreshToken: "secret-refresh",
                accessToken: "secret-access",
              } : null;
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

  const rpc = async (action: string, decision?: string) => {
    const response = await worker.dispatchFetch("http://worker", {
      method: "POST",
      body: JSON.stringify({ action, decision }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };

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
