import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findApiDeploymentOrigin,
  previewName,
  webPreviewOrigin,
} from "./config.mjs";

const id = "ab73e124-1234-1234-1234-123456789abc";
const domain = "tailos-preview-api.preview-account.workers.dev";

test("uses the dedicated Tailos Web hostname for the PR", () => {
  assert.equal(
    webPreviewOrigin(previewName(123)),
    "https://pr-123.preview.tailos.app",
  );
});

test("selects the matching workers.dev deployment URL for the API", () => {
  for (const label of [id, id.slice(0, 8)]) {
    const expected = `https://${label}-${domain}`;
    assert.equal(
      findApiDeploymentOrigin(
        {
          deployment_id: id,
          deployment_urls: [
            `https://${label}-pr-123.preview-api.tailos.app`,
            expected,
          ],
        },
        "preview-account",
      ),
      expected,
    );
  }
});

test("rejects URLs outside the matching API deployment and Cloudflare account", () => {
  assert.throws(
    () =>
      findApiDeploymentOrigin(
        {
          deployment_id: id,
          deployment_urls: [
            "https://ab73e124.preview-api.tailos.app",
            `https://pr-123-${domain}`,
            `https://12345678-${domain}`,
            "https://ab73e124-tailos-preview-api.other-account.workers.dev",
            "https://ab73e124-tailos-preview-web.preview-account.workers.dev",
            `https://ab73e124-${domain}.example.com`,
            `http://ab73e124-${domain}`,
            `https://secret@ab73e124-${domain}`,
            `https://ab73e124-${domain}:8080`,
            `https://ab73e124-${domain}/other`,
          ],
        },
        "preview-account",
      ),
    /enable its Preview URLs/,
  );
});
