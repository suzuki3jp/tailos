export async function cloudflare(
  path,
  { method = "GET", missing = [], json } = {},
) {
  const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } =
    process.env;
  if (!/^[\da-f]{32}$/i.test(account ?? "") || !token)
    throw new Error("Set the Preview Cloudflare account ID and API token");
  const headers = { Authorization: `Bearer ${token}` };
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/${path}`,
    {
      method,
      headers,
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    },
  );
  const body = await response.json().catch(() => null);
  if (method === "DELETE" && response.status === 204) return { success: true };
  if (response.ok && body?.success === true) return body;
  const codes = body?.errors?.map(({ code }) => code) ?? [];
  if (codes.length && codes.every((code) => missing.includes(code)))
    return null;
  throw new Error(
    `Cloudflare ${method} ${path} failed (HTTP ${response.status}, codes ${codes.join(", ")})`,
  );
}

export async function previewDatabase() {
  const database = {
    binding: "DB",
    database_name: "tailos-preview",
    database_id: process.env.TAILOS_PREVIEW_D1_DATABASE_ID,
  };
  if (
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(
      database.database_id ?? "",
    )
  )
    throw new Error(
      "Set TAILOS_PREVIEW_D1_DATABASE_ID to the Preview database UUID",
    );
  const { result } = await cloudflare(`d1/database/${database.database_id}`);
  if (result?.name !== database.database_name)
    throw new Error(
      "TAILOS_PREVIEW_D1_DATABASE_ID must point to tailos-preview",
    );
  return database;
}

export function previewsPath(worker) {
  // This is the same Worker Previews API used by the pinned Wrangler CLI.
  return `workers/workers/${worker}/previews`;
}
