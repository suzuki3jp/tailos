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
