export const apiOrigin = new URL(
  import.meta.env.VITE_API_ORIGIN ??
    (import.meta.env.DEV
      ? "http://localhost:8787"
      : "https://api.meguri.suzuki3.jp"),
).origin;
