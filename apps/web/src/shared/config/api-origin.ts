export const apiOrigin = new URL(
  import.meta.env.VITE_API_ORIGIN ??
    (import.meta.env.DEV ? "http://localhost:8787" : "https://api.tailos.app"),
).origin;

export const isPreview = import.meta.env.VITE_TAILOS_PREVIEW === "1";
