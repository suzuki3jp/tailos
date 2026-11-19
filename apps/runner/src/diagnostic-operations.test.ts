import { expect, test } from "vitest";
import { diagnosticErrorBody } from "@/diagnostic-operations.ts";

test("handles circular causes and exceptions that cannot be inspected", () => {
  const circular = new Error("original");
  circular.cause = circular;
  const body = JSON.parse(diagnosticErrorBody(circular));
  expect(body.errors[0].message).toBe("original");
  expect(body.errors).toHaveLength(2);
  const unreadable = Object.defineProperty(new Error("original"), "code", {
    get() {
      throw new Error("unreadable");
    },
  });
  expect(JSON.parse(diagnosticErrorBody(unreadable))).toEqual({
    errors: [{ message: "Error details unavailable" }],
  });
  expect(
    JSON.parse(diagnosticErrorBody("untyped rejection")).errors[0].message,
  ).toBe("untyped rejection");
});
