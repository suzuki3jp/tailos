export const workers = {
  api: "tailos-preview-api",
  web: "tailos-preview-web",
};

export function previewName(number) {
  if (!/^[1-9]\d*$/.test(number ?? "")) throw new Error("Invalid PR number");
  return `pr-${number}`;
}

export function origins(name, env = process.env) {
  const base = (key) => {
    const value = env[key] ?? "";
    if (
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(value) ||
      [".tailos.app", ".workers.dev"].some((suffix) =>
        `.${value}`.endsWith(suffix),
      )
    ) {
      throw new Error(`Set ${key} to a dedicated Preview custom hostname`);
    }
    return value;
  };
  const web = base("TAILOS_PREVIEW_WEB_DOMAIN");
  const api = base("TAILOS_PREVIEW_API_DOMAIN");
  if (web === api)
    throw new Error("The Web and API Preview domains must differ");
  return { web: `https://${name}.${web}`, api: `https://${name}.${api}` };
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
