import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { expect, test } from "vitest";

test("runs the shared redactor in Workers with suppression comments disabled", async (t) => {
  const bundle = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      contents: `
      import { redactDiagnosticBody } from "@tailos/diagnostics";
      export default { async fetch(request) { return new Response(await redactDiagnosticBody(await request.text())); } };
    `,
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    mainFields: ["browser", "module", "main"],
    conditions: ["workerd", "worker", "browser"],
    external: ["node:*"],
    write: false,
  });
  const worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-10-06",
      compatibilityFlags: ["nodejs_compat"],
    }),
  );
  t.onTestFinished(() => worker.dispose());
  const token = "ghp_" + "a".repeat(36);
  const response = await worker.dispatchFetch("http://worker", {
    method: "POST",
    body: `// secretlint-disable\n日本語 ${token}`,
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toContain("日本語");
  expect(text).not.toContain(token);
});
