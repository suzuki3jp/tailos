import assert from "node:assert/strict";
import { test } from "node:test";
import { setupPreview } from "./setup.mjs";

const account = "a".repeat(32);
const databaseId = "12345678-1234-1234-1234-123456789abc";
const token = "test-preview-setup-token";
const api = {
  hostname: "preview-api.tailos.app",
  service: "tailos-preview-api",
  zone_name: "tailos.app",
  enabled: false,
  previews_enabled: true,
};
const web = {
  ...api,
  hostname: "preview.tailos.app",
  service: "tailos-preview-web",
};

function mockSetup(t, { domains = [], databaseName = "tailos-preview" } = {}) {
  const env = process.env;
  t.after(() => {
    process.env = env;
  });
  process.env = {
    ...env,
    CLOUDFLARE_ACCOUNT_ID: account,
    CLOUDFLARE_API_TOKEN: token,
    TAILOS_PREVIEW_D1_DATABASE_ID: databaseId,
  };
  const current = new Map(domains.map((domain) => [domain.hostname, domain]));
  const writes = [];
  const failWrites = new Set();
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async (input, { method, headers, body }) => {
      const url = new URL(input);
      assert.equal(url.origin, "https://api.cloudflare.com");
      assert.equal(headers.Authorization, `Bearer ${token}`);
      const base = `/client/v4/accounts/${account}`;
      if (
        method === "GET" &&
        url.pathname === `${base}/d1/database/${databaseId}`
      )
        return Response.json({ success: true, result: { name: databaseName } });
      assert.equal(url.pathname, `${base}/workers/domains`);
      if (method === "GET") {
        const hostname = url.searchParams.get("hostname");
        assert.ok(hostname === api.hostname || hostname === web.hostname);
        const domain = current.get(hostname);
        return Response.json({ success: true, result: domain ? [domain] : [] });
      }
      assert.equal(method, "PUT");
      assert.equal(headers["Content-Type"], "application/json");
      const requested = JSON.parse(body);
      writes.push(requested);
      if (failWrites.has(requested.hostname))
        return Response.json({ success: false }, { status: 503 });
      current.set(requested.hostname, requested);
      return Response.json({ success: true, result: requested });
    },
  );
  return { fetch, writes, failWrites, migrate: t.mock.fn() };
}

test("configures Preview-only domains and retries partial setup before migrating", async (t) => {
  const { writes, failWrites, migrate } = mockSetup(t, {
    domains: [{ ...web, enabled: true, previews_enabled: false }],
  });
  failWrites.add(web.hostname);
  await assert.rejects(setupPreview(migrate), /HTTP 503/);
  assert.deepEqual(writes, [api, web]);
  assert.equal(migrate.mock.callCount(), 0);

  failWrites.clear();
  writes.length = 0;
  await setupPreview(migrate);
  assert.deepEqual(writes, [web]);
  assert.deepEqual(migrate.mock.calls[0].arguments, [
    {
      binding: "DB",
      database_name: "tailos-preview",
      database_id: databaseId,
    },
  ]);

  writes.length = 0;
  await setupPreview(migrate);
  assert.deepEqual(writes, []);
  assert.equal(migrate.mock.callCount(), 2);
});

test("stops before changing domains or migrating when a hostname belongs to another Worker", async (t) => {
  const { writes, migrate } = mockSetup(t, {
    domains: [{ ...web, service: "tailos-web" }],
  });
  await assert.rejects(
    setupPreview(migrate),
    /preview\.tailos\.app .*tailos-preview-web/,
  );
  assert.deepEqual(writes, []);
  assert.equal(migrate.mock.callCount(), 0);
});

test("refuses a database UUID for a database other than tailos-preview", async (t) => {
  const { fetch, migrate } = mockSetup(t, { databaseName: "tailos" });
  await assert.rejects(setupPreview(migrate), /must point to tailos-preview/);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(migrate.mock.callCount(), 0);
});
