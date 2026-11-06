import { expect, test } from "vitest";
import app from "./http.ts";

test("the Worker serves the health endpoint", async () => {
  const response = await app.request("/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toStrictEqual({ status: "ok" });
});
