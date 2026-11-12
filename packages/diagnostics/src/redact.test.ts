import { generateKeyPairSync } from "node:crypto";
import { expect, test } from "vitest";
import { redactDiagnosticBody } from "./redact.js";

test("masks credentials in Unicode text and ignores suppression directives", async () => {
  const token = "ghp_" + "a".repeat(36);
  const output = await redactDiagnosticBody(
    `// secretlint-disable\n日本語 ${token}\nchecks passed`,
  );
  expect(output).not.toContain(token);
  expect(output).toContain("日本語");
  expect(output).toContain("checks passed");
});

test("masks multiline keys and opaque known values", async () => {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const output = await redactDiagnosticBody(
    `${privateKey}\nBearer opaque-test-secret`,
    ["opaque-test-secret"],
  );
  expect(output).not.toContain("BEGIN PRIVATE KEY");
  expect(output).not.toContain("opaque-test-secret");
  expect(output).toContain("[REDACTED]");
  expect(
    await redactDiagnosticBody(JSON.stringify({ output: privateKey })),
  ).not.toContain("BEGIN PRIVATE KEY");
});
