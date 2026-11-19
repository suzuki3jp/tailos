import type {
  DiagnosticAttributes,
  Diagnostics,
} from "@tailos/core/diagnostics";

// Do not serialize arbitrary Error properties: subprocess errors may carry
// credentials in command arguments, environment, stdout, or stderr.
export function systemErrorDetails(error: unknown) {
  const details: Record<string, string | number> = {};
  if (typeof error !== "object" || error === null) return details;
  for (const key of ["code", "errno", "syscall", "path", "dest"]) {
    const value = Reflect.get(error, key);
    if (typeof value === "string" || typeof value === "number")
      details[key] = value;
  }
  return details;
}

// Bodies go through RunnerDiagnostics' redaction and existing size limits.
// Serialization must never replace the error being investigated.
export function diagnosticErrorBody(error: unknown): string {
  try {
    const errors = [];
    const seen = new Set<Error>();
    let current = error;
    while (current instanceof Error && !seen.has(current)) {
      seen.add(current);
      errors.push({
        name: current.name,
        message: current.message,
        stack: current.stack,
        ...systemErrorDetails(current),
      });
      current = current.cause;
    }
    if (current !== undefined)
      errors.push({
        name: "UnknownError",
        message:
          typeof current === "string" ? current : "Non-Error or circular cause",
      });
    return JSON.stringify({ errors });
  } catch {
    return JSON.stringify({
      errors: [{ message: "Error details unavailable" }],
    });
  }
}

export async function withDiagnosticSpan<T>(
  diagnostics: Diagnostics | undefined,
  operation: NonNullable<DiagnosticAttributes["operation"]>,
  work: () => Promise<T>,
  body?: string,
): Promise<T> {
  const span = diagnostics?.start(operation, body);
  try {
    const result = await work();
    if (span) diagnostics?.end(span, { outcome: "succeeded" });
    return result;
  } catch (error) {
    if (span)
      diagnostics?.end(span, { outcome: "failed" }, diagnosticErrorBody(error));
    throw error;
  }
}
