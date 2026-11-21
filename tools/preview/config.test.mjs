import assert from "node:assert/strict";
import { test } from "node:test";
import { findApiDeploymentOrigin } from "./config.mjs";

test("selects the API deployment URL with or without the Preview name", () => {
  const domain = "tailos-preview-api.example.test";
  const stable = `https://pr-120.${domain}`;
  for (const label of ["ab73e124", "ab73e124-pr-120"]) {
    const expected = `https://${label}.${domain}`;
    assert.equal(findApiDeploymentOrigin([stable, expected], stable), expected);
  }
  assert.throws(
    () =>
      findApiDeploymentOrigin(
        [
          stable,
          `https://ab73e124-pr-121.${domain}`,
          `https://ab73e124.${domain}.unrelated.test`,
          `https://ab73e124.${domain}:8080`,
          `https://ab73e124.${domain}/other`,
        ],
        stable,
      ),
    /did not return a deployment URL/,
  );
});
