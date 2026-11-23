export const workers = {
  api: "tailos-preview-api",
  web: "tailos-preview-web",
};

export function previewName(number) {
  if (!/^[1-9]\d*$/.test(number ?? "")) throw new Error("Invalid PR number");
  return `pr-${number}`;
}

export function origins(name) {
  return {
    web: `https://${name}.preview.tailos.app`,
    api: `https://${name}.preview-api.tailos.app`,
  };
}

export function findApiDeploymentOrigin(urls, apiOrigin) {
  const [name, ...domain] = new URL(apiOrigin).hostname.split(".");
  const suffix = "." + domain.join(".");
  for (const value of urls ?? []) {
    const url = URL.parse(value);
    if (
      url?.protocol !== "https:" ||
      url.href !== url.origin + "/" ||
      url.port ||
      !url.hostname.endsWith(suffix)
    ) {
      continue;
    }
    // Cloudflare can use either the deployment ID alone or ID followed by the Preview name.
    const label = url.hostname.slice(0, -suffix.length);
    const id = label.endsWith(`-${name}`)
      ? label.slice(0, -name.length - 1)
      : label;
    if (
      /^[a-f\d]{8}(?:-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})?$/.test(id)
    )
      return url.origin;
  }
  throw new Error(
    "Cloudflare did not return a deployment URL on the API Preview domain",
  );
}
