import { expect, test, vi } from "vitest";
import type { CodexAccess } from "@tailos/core/runner";
import { CredentialBroker } from "@/infrastructure/cloudflare/credential-broker.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      protected ctx: unknown,
      protected env: unknown,
    ) {}
  },
}));

function createBroker(
  lookup: () => Promise<{ model: string; efforts: string[] }[] | null>,
) {
  const catalog = vi.fn(lookup);
  const runner = {
    newUniqueId: vi.fn(() => "isolated-runner"),
    get: vi.fn(() => ({ codexModels: catalog })),
  };
  const broker = new CredentialBroker(
    {} as ConstructorParameters<typeof CredentialBroker>[0],
    // This test exercises the catalog coordination, not Cloudflare namespace construction.
    { RUNNER: runner } as unknown as ConstructorParameters<
      typeof CredentialBroker
    >[1],
  );
  const access: CodexAccess = {
    accessToken: "short-lived-access",
    accountId: "account",
    accessVersion: crypto.randomUUID(),
    connectionVersion: crypto.randomUUID(),
  };
  const issueAccess = vi.spyOn(broker, "issueAccess").mockResolvedValue(access);
  return { broker, catalog, access, issueAccess };
}

test("concurrent catalog requests share one Runner lookup for the same connection", async () => {
  let finish = (_models: { model: string; efforts: string[] }[]) => {};
  const pending = new Promise<{ model: string; efforts: string[] }[]>(
    (resolve) => {
      finish = resolve;
    },
  );
  const { broker, catalog } = createBroker(() => pending);
  const first = broker.codexModels();
  const second = broker.codexModels();
  await vi.waitFor(() => expect(catalog).toHaveBeenCalledTimes(1));
  const models = [{ model: "model", efforts: ["high"] }];
  finish(models);
  expect(await first).toEqual(models);
  expect(await second).toEqual(models);
});

test("failed catalog lookups are retried and disconnected credentials never use an in-flight result", async () => {
  const { broker, catalog, issueAccess } = createBroker(async () => null);
  expect(await broker.codexModels()).toBeNull();
  expect(await broker.codexModels()).toBeNull();
  expect(catalog).toHaveBeenCalledTimes(2);
  catalog.mockRejectedValueOnce(new Error("Unavailable"));
  await expect(broker.codexModels()).rejects.toThrow("Unavailable");
  expect(await broker.codexModels()).toBeNull();
  expect(catalog).toHaveBeenCalledTimes(4);
  issueAccess.mockResolvedValue(null);
  expect(await broker.codexModels()).toBeNull();
  expect(catalog).toHaveBeenCalledTimes(4);
});

test("a new connection does not join the previous connection's lookup", async () => {
  let finish = (_models: { model: string; efforts: string[] }[]) => {};
  const pending = new Promise<{ model: string; efforts: string[] }[]>(
    (resolve) => {
      finish = resolve;
    },
  );
  const { broker, catalog, access, issueAccess } = createBroker(() => pending);
  const first = broker.codexModels();
  await vi.waitFor(() => expect(catalog).toHaveBeenCalledTimes(1));
  issueAccess.mockResolvedValue({
    ...access,
    connectionVersion: crypto.randomUUID(),
  });
  catalog.mockResolvedValueOnce([{ model: "new-model", efforts: ["high"] }]);
  expect(await broker.codexModels()).toEqual([
    { model: "new-model", efforts: ["high"] },
  ]);
  finish([{ model: "old-model", efforts: ["high"] }]);
  expect(await first).toEqual([{ model: "old-model", efforts: ["high"] }]);
  expect(catalog).toHaveBeenCalledTimes(2);
});
