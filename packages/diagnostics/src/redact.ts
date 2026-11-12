import { lintSource } from "@secretlint/core";
import { secretLintProfiler } from "@secretlint/profiler";
import { creator } from "@secretlint/secretlint-rule-preset-recommend";

secretLintProfiler.setEnabled(false);
const rules = creator.rules
  .filter(
    (rule) => rule.meta.id !== "@secretlint/secretlint-rule-filter-comments",
  )
  .map((rule) => ({ id: rule.meta.id, rule }));

// Whole bounded records are scanned before transport chunking. Incomplete or
// oversized logical outputs must be omitted by the caller, never scanned as
// unrelated fragments. The result and exceptions must not be logged.
export async function redactDiagnosticBody(
  input: string,
  secrets: Iterable<string> = [],
): Promise<string> {
  let text = input;
  for (const secret of secrets) {
    if (secret) text = text.replaceAll(secret, "[REDACTED]");
  }
  const result = await lintSource({
    source: {
      content: text,
      contentType: "text",
      filePath: "diagnostics.txt",
      ext: ".txt",
    },
    options: { config: { rules }, noPhysicFilePath: true, maskSecrets: true },
  });
  // Equal-length replacements preserve UTF-16 ranges, including overlaps.
  const chars = text.split("");
  for (const {
    range: [start, end],
  } of result.messages)
    chars.fill("*", start, end);
  return chars.join("");
}
