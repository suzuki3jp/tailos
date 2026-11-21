export async function cloudflare(path, { method = "GET", missing = [] } = {}) {
  const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token } =
    process.env;
  if (!/^[\da-f]{32}$/i.test(account ?? "") || !token)
    throw new Error("Set the Preview Cloudflare account ID and API token");
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/${path}`,
    {
      method,
      headers: { Authorization: `Bearer ${token}` },
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

export function previewsPath(worker) {
  // This is the same Worker Previews API used by the pinned Wrangler CLI.
  return `workers/workers/${worker}/previews`;
}
