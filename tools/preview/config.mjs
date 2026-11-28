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

export function findApiDeploymentOrigin({
  deployment_id: id,
  deployment_urls: urls,
  preview_name: name,
  preview_urls: previewUrls,
}) {
  if (
    typeof id !== "string" ||
    !/^[a-f\d]{8}(?:-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})?$/.test(id)
  )
    throw new Error(
      "Wrangler did not report a valid API Preview deployment ID",
    );

  // Remove this workers.dev workaround once Workers can fetch Preview custom domains.
  // https://github.com/cloudflare/developer-platform/issues/119
  // Wrangler's authenticated Preview response includes the alias for this account.
  const alias = (previewUrls ?? [])
    .map((value) => URL.parse(value))
    .find((url) => {
      if (!url || url.href !== `https://${url.hostname}/`) return false;
      const [label, subdomain, ...suffix] = url.hostname.split(".");
      return (
        label === `${name}-${workers.api}` &&
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain ?? "") &&
        suffix.join(".") === "workers.dev"
      );
    });
  if (!alias)
    throw new Error(
      `Cloudflare did not return a workers.dev alias for ${workers.api}/${name}; enable its Preview URLs`,
    );
  const domain = alias.hostname.slice(name.length + 1);
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
