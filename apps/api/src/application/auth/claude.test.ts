import { expect, test } from "vitest";
import * as v from "valibot";
import {
  ClaudeToken,
  claudeConnectionStatus,
} from "@/application/auth/claude.ts";

const day = 24 * 60 * 60 * 1000;

test("warns about the Claude token expiry from 30 days before one year after saving", () => {
  const savedAt = Date.UTC(2026, 0, 1);
  const expiresAt = savedAt + 365 * day;
  const expiry = (now: number) => {
    const status = claudeConnectionStatus(savedAt, now);
    return status.state === "connected" ? status.expiry : status.state;
  };
  expect(claudeConnectionStatus(undefined, savedAt)).toStrictEqual({
    state: "disconnected",
  });
  expect(claudeConnectionStatus(savedAt, savedAt)).toStrictEqual({
    state: "connected",
    savedAt,
    expiresAt,
    expiry: "valid",
  });
  expect(expiry(expiresAt - 30 * day - 1)).toBe("valid");
  expect(expiry(expiresAt - 30 * day)).toBe("soon");
  expect(expiry(expiresAt - 1)).toBe("soon");
  expect(expiry(expiresAt)).toBe("passed");
});

test("accepts only the format of a setup-token OAuth token", () => {
  const body = "Aa0_-".repeat(20);
  expect(v.is(ClaudeToken, "sk-ant-oat01-" + body)).toBe(true);
  for (const value of [
    "sk-ant-api03-" + body,
    " sk-ant-oat01-" + body,
    "sk-ant-oat01-" + body + "\n",
    "sk-ant-oat01-short",
    "sk-ant-oat01-" + "a".repeat(513),
    "sk-ant-oat01-" + body + "!",
    "",
  ])
    expect(v.is(ClaudeToken, value), value).toBe(false);
});
