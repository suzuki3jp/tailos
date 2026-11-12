import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";

test(
  "the standalone production bundle starts and completes a job",
  { timeout: 30_000 },
  async () => {
    const runnerRoot = new URL("../", import.meta.url);
    execFileSync("pnpm", ["run", "build"], { cwd: runnerRoot });
    const directory = await mkdtemp(join(tmpdir(), "tailos-runner-bundle-"));
    let child;
    let exited;
    let stderr = "";
    try {
      const bundle = join(directory, "runner.cjs");
      await copyFile(new URL("dist/runner.cjs", runnerRoot), bundle);
      // Match the image: only the generated bundle, without workspace dependencies.
      child = spawn(process.execPath, [bundle], {
        cwd: directory,
        env: { PATH: process.env.PATH },
        stdio: ["ignore", "ignore", "pipe"],
      });
      exited = once(child, "exit");
      child.stderr.setEncoding("utf8").on("data", (data) => {
        stderr += data;
      });

      const origin = "http://127.0.0.1:8080";
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        assert.equal(child.exitCode, null, stderr);
        const health = await fetch(`${origin}/health`, {
          signal: AbortSignal.timeout(100),
        }).catch(() => null);
        if (health?.ok) {
          assert.deepEqual(await health.json(), {
            status: "ok",
            service: "runner",
          });
          ready = true;
          break;
        }
        await setTimeout(50);
      }
      assert.ok(ready, `Runner did not become ready: ${stderr}`);
      const runId = randomUUID();
      const prompt = `bundle smoke test ${runId}`;
      const accepted = await fetch(`${origin}/job`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: 1,
          engine: "fake",
          runId,
          prompt,
          deadlineAt: Date.now() + 10_000,
        }),
        signal: AbortSignal.timeout(1_000),
      });
      assert.equal(accepted.status, 202);
      await accepted.body?.cancel();
      let status;
      for (let attempt = 0; attempt < 100; attempt++) {
        const response = await fetch(`${origin}/job/${runId}`, {
          signal: AbortSignal.timeout(1_000),
        });
        assert.equal(response.status, 200);
        status = await response.json();
        if (status.status !== "running") break;
        await setTimeout(20);
      }
      assert.equal(status?.status, "succeeded");
      assert.equal(status.reply, `Fake agent completed: ${prompt}`);
      assert.equal(child.exitCode, null, stderr);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
