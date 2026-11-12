import { createHash, randomBytes } from "node:crypto";

const [ownerId, lifetime = "30"] = process.argv.slice(2);
if (
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    ownerId ?? "",
  ) ||
  !/^\d+$/.test(lifetime) ||
  Number(lifetime) < 1 ||
  Number(lifetime) > 90
) {
  throw new Error(
    "Usage: pnpm --filter @tailos/api mcp:key <Tailos user UUID> [lifetime in days, 1-90; default 30]",
  );
}
const key = "tailos_read_" + randomBytes(32).toString("base64url");
const expiresAt = Date.now() + Number(lifetime) * 24 * 60 * 60 * 1000;
// oxlint-disable-next-line no-console -- Explicit local key issuance; never run in CI.
console.log(
  JSON.stringify(
    {
      apiKey: key,
      expiresAt: new Date(expiresAt).toISOString(),
      TAILOS_MCP_READ_KEY_CONFIG: JSON.stringify({
        version: 1,
        ownerId,
        sha256: createHash("sha256").update(key).digest("hex"),
        expiresAt,
      }),
    },
    null,
    2,
  ),
);
