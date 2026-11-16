import { expect, test } from "vitest";
import { cn } from "./cn";

test("semantic typography overrides font sizes without removing text colors", () => {
  expect(cn("text-sm text-muted-foreground", "text-body")).toBe(
    "text-muted-foreground text-body",
  );
  expect(cn("text-control text-foreground", "text-control-xs")).toBe(
    "text-foreground text-control-xs",
  );
  expect(cn("md:text-sm", "md:text-body")).toBe("md:text-body");
});
