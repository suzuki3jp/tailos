export function readLoginConfig(env, origin = env.MEGURI_PUBLIC_ORIGIN) {
  const vars = {
    MEGURI_GITHUB_OAUTH_CLIENT_ID: env.MEGURI_GITHUB_OAUTH_CLIENT_ID,
    MEGURI_OPERATOR_GITHUB_ID: env.MEGURI_OPERATOR_GITHUB_ID,
  };
  const secrets = {
    MEGURI_GITHUB_OAUTH_CLIENT_SECRET: env.MEGURI_GITHUB_OAUTH_CLIENT_SECRET,
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
  };
  const settings = [...Object.values(vars), ...Object.values(secrets)];
  if (!settings.some(Boolean)) return { vars: {}, secrets: {} };

  if (
    !settings.every(Boolean) ||
    !/^[1-9]\d*$/.test(vars.MEGURI_OPERATOR_GITHUB_ID) ||
    secrets.BETTER_AUTH_SECRET.length < 32
  ) {
    throw new Error(
      "GitHub login requires a Client ID and Secret, a numeric operator GitHub ID, and a Better Auth secret of at least 32 characters.",
    );
  }
  const publicUrl = URL.parse(origin || "");
  if (publicUrl?.protocol !== "https:" || publicUrl.origin !== origin) {
    throw new Error(
      "Set MEGURI_PUBLIC_ORIGIN to the HTTPS origin of the Worker.",
    );
  }
  return { vars: { ...vars, MEGURI_PUBLIC_ORIGIN: origin }, secrets };
}
