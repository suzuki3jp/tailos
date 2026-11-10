import { assert, expect, test } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  CodexDeviceAuth,
  ReauthenticationRequired,
} from "#api/infrastructure/auth/codex-device.ts";
import { TransientDevicePollError } from "#api/application/auth/device.ts";

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

test("retains the status for a retryable poll failure and distinguishes code exchange failures", async () => {
  let pollStatus = 429;
  const provider = new CodexDeviceAuth(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/accounts/deviceauth/token") {
      if (pollStatus !== 200) return new Response(null, { status: pollStatus });
      return Response.json({
        authorization_code: "one-time",
        code_verifier: "pkce",
      });
    }
    expect(path).toBe("/oauth/token");
    return new Response(null, { status: 502 });
  });
  const challenge = {
    id: "opaque",
    userCode: "DISPLAY",
    verificationUrl: "https://auth.openai.com/codex/device",
    intervalMs: 5000,
    expiresAt: Date.now() + 60_000,
  };

  await expect(provider.complete(challenge)).rejects.toMatchObject(
    new TransientDevicePollError(429),
  );
  pollStatus = 200;
  await expect(provider.complete(challenge)).rejects.toMatchObject({
    stage: "exchange_authorization_code",
    httpStatus: 502,
  });
});
