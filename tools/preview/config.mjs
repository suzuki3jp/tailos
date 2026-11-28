export const workers = {
  api: "tailos-preview-api",
  web: "tailos-preview-web",
};

export const previewZone = "tailos.app";
export const webPreviewDomain = `preview.${previewZone}`;

export function previewName(number) {
  if (!/^[1-9]\d*$/.test(number ?? "")) throw new Error("Invalid PR number");
  return `pr-${number}`;
}

export function webPreviewOrigin(name) {
  return `https://${name}.${webPreviewDomain}`;
}

export function findApiDeploymentOrigin(
  { deployment_id: id, deployment_urls: urls },
  subdomain,
) {
  if (
    typeof subdomain !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)
  )
    throw new Error("Cloudflare did not return a valid Workers subdomain");
  if (
    typeof id !== "string" ||
    !/^[a-f\d]{8}(?:-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})?$/.test(id)
  )
    throw new Error(
      "Wrangler did not report a valid API Preview deployment ID",
    );

  // Remove this workers.dev workaround once Workers can fetch Preview custom domains.
  // https://github.com/cloudflare/developer-platform/issues/119
  const domain = `${workers.api}.${subdomain}.workers.dev`;
  const origins = [id, id.slice(0, 8)].map(
    (label) => `https://${label}-${domain}`,
  );
  for (const value of urls ?? []) {
    const url = URL.parse(value);
    if (url && url.href === `${url.origin}/` && origins.includes(url.origin))
      return url.origin;
  }
  throw new Error(
    `Cloudflare did not return a workers.dev deployment URL for ${workers.api}; enable its Preview URLs`,
  );
}
