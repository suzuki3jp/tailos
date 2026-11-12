export type McpKey = {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  expiresAt: number;
};

export type McpKeyStore = {
  list(ownerId: string): Promise<McpKey[]>;
  create(ownerId: string, key: McpKey & { sha256: string }): Promise<boolean>;
  revoke(ownerId: string, id: string, now: number): Promise<boolean>;
  owner(sha256: string, now: number): Promise<string | null>;
};

export async function hashMcpKey(token: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function issueMcpKey(
  store: McpKeyStore,
  ownerId: string,
  name: string,
  lifetimeDays: number,
) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token =
    "tailos_read_" +
    btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  const now = Date.now();
  const key: McpKey = {
    id: crypto.randomUUID(),
    name,
    prefix: token.slice(0, 20),
    createdAt: now,
    expiresAt: now + lifetimeDays * 86_400_000,
  };
  const created = await store.create(ownerId, {
    ...key,
    sha256: await hashMcpKey(token),
  });
  return created ? { key, token } : null;
}

export type McpAuthentication =
  | { state: "disabled" }
  | { state: "unauthorized" }
  | { state: "authenticated"; ownerId: string };
