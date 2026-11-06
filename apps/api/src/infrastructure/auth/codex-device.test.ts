import { assert, expect, test } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { CodexDeviceAuth, ReauthenticationRequired } from "./codex-device.ts";

test("exchanges a device code, verifies its account, and preserves rotated credentials", async () => {
  const issuer = "https://auth.openai.com";
  const clientId = "app_EMoamEEZ73f0CkXaXp7hrann";
  const key = await generateKeyPair("ES256");
  const jwk = await exportJWK(key.publicKey);
  const idToken = await new SignJWT({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "account-id",
      chatgpt_plan_type: "plus",
    },
  })
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer(issuer)
    .setAudience(clientId)
    .setExpirationTime("15m")
    .sign(key.privateKey);
  const accessToken = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setExpirationTime("15m")
    .sign(key.privateKey);

  let waiting = true;
  let revoke = false;
  const provider = new CodexDeviceAuth(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(issuer);
    if (url.pathname === "/api/accounts/deviceauth/usercode") {
      return Response.json({
        device_auth_id: "opaque",
        user_code: "DISPLAY",
        interval: 5,
      });
    }
    if (url.pathname === "/api/accounts/deviceauth/token") {
      if (waiting) return new Response(null, { status: 403 });
      return Response.json({
        authorization_code: "one-time",
        code_verifier: "pkce",
      });
    }
    if (url.pathname === "/.well-known/jwks.json") {
      return Response.json({ keys: [jwk] });
    }
    expect(url.pathname).toBe("/oauth/token");
    if (init?.body instanceof URLSearchParams) {
      expect(init.body.get("code_verifier")).toBe("pkce");
      return Response.json({
        access_token: accessToken,
        id_token: idToken,
        refresh_token: "first",
      });
    }
    expect(String(init?.body)).toMatch(/"refresh_token":"first"/);
    return revoke
      ? new Response(null, { status: 401 })
      : Response.json({ access_token: accessToken, refresh_token: "rotated" });
  });
  const challenge = await provider.begin();
  expect(challenge.userCode).toBe("DISPLAY");
  expect(await provider.complete(challenge)).toBe(null);
  waiting = false;
  const creds = await provider.complete(challenge);
  assert(creds);
  expect(creds.accountId).toBe("account-id");
  expect((await provider.refresh(creds)).refreshToken).toBe("rotated");
  revoke = true;
  await expect(provider.refresh(creds)).rejects.toThrow(
    ReauthenticationRequired,
  );
});
