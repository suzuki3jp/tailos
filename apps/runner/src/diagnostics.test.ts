import { expect, test } from "vitest";
import { DiagnosticBatch, maxDiagnosticBody } from "@tailos/core/diagnostics";
import type { RunnerJob } from "@tailos/core/runner";
import * as v from "valibot";
import { RunnerDiagnostics } from "@/diagnostics.ts";

function job(): RunnerJob {
  return {
    version: 1,
    engine: "fake",
    runId: crypto.randomUUID(),
    prompt: "test",
    deadlineAt: Date.now() + 60_000,
    diagnostics: {
      traceId: "run/test",
      parentSpanId: "run/test",
      producerId: crypto.randomUUID(),
      url: "https://api.example/diagnostics",
      bearer: "a".repeat(64),
      expiresAt: Date.now() + 60_000,
    },
  };
}

test("redacts before transport and retries a lost ACK with the identical batch", async () => {
  const sent: string[] = [];
  const diagnostics = new RunnerDiagnostics(job(), async (_url, init) => {
    sent.push(String(init?.body));
    if (sent.length === 1) throw new Error("response lost");
    return new Response(null, { status: 204 });
  });
  const token = "ghp_" + "b".repeat(36);
  const span = diagnostics.start("command", `echo ${token}`);
  diagnostics.end(span, { exitCode: 0 }, "checks passed");
  await diagnostics.flush();
  await diagnostics.finish();
  expect(sent[0]).toBe(sent[1]);
  expect(sent.join("")).not.toContain(token);
  const last = v.parse(DiagnosticBatch, JSON.parse(sent.at(-1)!));
  expect(last.completed).toEqual({ lastSeq: 2, dropped: 0 });
});

test("omits entire oversized bodies and reports unfinished spans as partial", async () => {
  const sent: string[] = [];
  const diagnostics = new RunnerDiagnostics(job(), async (_url, init) => {
    sent.push(String(init?.body));
    return new Response(null, { status: 204 });
  });
  diagnostics.start("command", "x".repeat(maxDiagnosticBody + 1));
  await diagnostics.finish();
  const first = v.parse(DiagnosticBatch, JSON.parse(sent[0]!));
  expect(first.records[0]?.body).toBeUndefined();
  expect(first.records[0]?.attributes.reason).toBe("limit");
  const last = v.parse(DiagnosticBatch, JSON.parse(sent.at(-1)!));
  expect(last.completed?.dropped).toBe(2);
});

test("omits bodies whose JSON escaping would exceed the wire limit", async () => {
  const sent: string[] = [];
  const diagnostics = new RunnerDiagnostics(job(), async (_url, init) => {
    sent.push(String(init?.body));
    return new Response(null, { status: 204 });
  });
  const span = diagnostics.start("command", "\0".repeat(maxDiagnosticBody));
  diagnostics.end(span);
  await diagnostics.finish();
  expect(sent).toHaveLength(2);
  const first = parse(sent[0]!);
  expect(first.records[0]?.body).toBeUndefined();
  expect(first.records[0]?.attributes.reason).toBe("limit");
  expect(parse(sent[1]!).completed?.dropped).toBe(1);
});

function parse(input: string) {
  return v.parse(DiagnosticBatch, JSON.parse(input));
}

test("drops a permanently rejected packet and sends a partial completion marker", async () => {
  const sent: string[] = [];
  const diagnostics = new RunnerDiagnostics(job(), async (_url, init) => {
    sent.push(String(init?.body));
    return new Response(null, { status: sent.length === 1 ? 413 : 204 });
  });
  const span = diagnostics.start("command", "some output");
  diagnostics.end(span);
  await diagnostics.finish();
  expect(sent).toHaveLength(2);
  expect(parse(sent[1]!).completed).toEqual({ lastSeq: 2, dropped: 2 });
});

test("redacts the credentials of a Claude job", async () => {
  const sent: string[] = [];
  const token = "claude-oauth-token";
  const leaseBearer = "c".repeat(64);
  const diagnostics = new RunnerDiagnostics(
    {
      ...job(),
      engine: "claude",
      access: { token, connectionVersion: crypto.randomUUID() },
      lease: { url: "https://api.example/credentials", bearer: leaseBearer },
      checkout: {
        repository: "acme/widgets",
        baseSha: "a".repeat(40),
        branch: `tailos/issue-1/${crypto.randomUUID()}`,
        token: "checkout-token",
      },
    },
    async (_url, init) => {
      sent.push(String(init?.body));
      return new Response(null, { status: 204 });
    },
  );
  const span = diagnostics.start(
    "command",
    `echo ${token} ${leaseBearer} checkout-token`,
  );
  diagnostics.end(span);
  await diagnostics.finish();
  expect(sent.join("")).not.toContain(token);
  expect(sent.join("")).not.toContain(leaseBearer);
  expect(sent.join("")).not.toContain("checkout-token");
});
