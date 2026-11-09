import { createRemoteJWKSet, customFetch, decodeJwt, jwtVerify } from "jose";
import * as v from "valibot";
import {
  TransientDevicePollError,
  type DeviceAuthAdapter,
  type DeviceChallenge,
} from "../../application/auth/device.ts";

const issuer = "https://auth.openai.com";
const clientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const nonempty = v.pipe(v.string(), v.minLength(1));
const userCodeSchema = v.object({
  device_auth_id: nonempty,
  user_code: v.optional(nonempty),
  usercode: v.optional(nonempty),
  interval: v.optional(v.union([v.number(), v.string()])),
  expires_in: v.optional(v.number()),
});
const exchangeSchema = v.object({
  authorization_code: nonempty,
  code_verifier: nonempty,
});
const tokensSchema = v.object({
  access_token: nonempty,
  id_token: v.optional(nonempty),
  refresh_token: v.optional(nonempty),
});
const identitySchema = v.object({
  "https://api.openai.com/auth": v.object({
    chatgpt_account_id: nonempty,
    chatgpt_plan_type: v.optional(nonempty),
  }),
});

export const codexCredentialsSchema = v.strictObject({
  accessToken: nonempty,
  refreshToken: nonempty,
  idToken: nonempty,
  accountId: nonempty,
  planType: v.optional(nonempty),
  expiresAt: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});
export type CodexCredentials = v.InferOutput<typeof codexCredentialsSchema>;

export class ReauthenticationRequired extends Error {}

type OpenAIConnectionStage =
  | "request_device_code"
  | "poll_device_authorization"
  | "exchange_authorization_code"
  | "fetch_signing_keys"
  | "validate_tokens";

export class CodexDeviceError extends Error {
  constructor(
    readonly stage: OpenAIConnectionStage,
    readonly httpStatus?: number,
  ) {
    super(stage);
  }
}

async function readOpenAIResponse<T>(
  stage: OpenAIConnectionStage,
  request: () => Promise<Response>,
  read: (response: Response) => T | Promise<T>,
): Promise<T> {
  let response: Response | undefined;
  try {
    response = await request();
    return await read(response);
  } catch (error) {
    if (
      error instanceof CodexDeviceError ||
      error instanceof TransientDevicePollError
    )
      throw error;
    // Parsing and fetch errors can carry provider data. Keep only the stage and status.
    throw new CodexDeviceError(stage, response?.status);
  }
}

export class CodexDeviceAuth implements DeviceAuthAdapter<CodexCredentials> {
  private readonly http: typeof fetch;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    http: typeof fetch = (input, init) => globalThis.fetch(input, init),
  ) {
    this.http = http;
    this.jwks = createRemoteJWKSet(new URL(issuer + "/.well-known/jwks.json"), {
      [customFetch]: (input, init) =>
        readOpenAIResponse(
          "fetch_signing_keys",
          () => http(input, init),
          (response) => {
            if (response.status !== 200)
              throw new Error("Signing keys unavailable");
            return response;
          },
        ),
      timeoutDuration: 5_000,
    });
  }

  async begin(): Promise<DeviceChallenge> {
    return readOpenAIResponse(
      "request_device_code",
      () =>
        this.post("/api/accounts/deviceauth/usercode", { client_id: clientId }),
      async (response) => {
        if (!response.ok)
          throw new Error("Device authorization could not start");
        const data = v.parse(userCodeSchema, await response.json());
        const userCode = data.user_code ?? data.usercode;
        if (!userCode) throw new Error("Device code is missing");

        return {
          id: data.device_auth_id,
          userCode,
          verificationUrl: issuer + "/codex/device",
          intervalMs:
            1000 * Math.min(60, Math.max(5, Number(data.interval) || 5)),
          expiresAt:
            Date.now() +
            1000 * Math.min(900, Math.max(5, data.expires_in ?? 900)),
        };
      },
    );
  }

  async complete(challenge: DeviceChallenge): Promise<CodexCredentials | null> {
    const data = await readOpenAIResponse(
      "poll_device_authorization",
      () =>
        this.post("/api/accounts/deviceauth/token", {
          device_auth_id: challenge.id,
          user_code: challenge.userCode,
        }).catch(() => {
          throw new TransientDevicePollError();
        }),
      async (response) => {
        if (response.status === 403 || response.status === 404) return null;
        if (response.status === 429 || response.status >= 500)
          throw new TransientDevicePollError(response.status);
        if (!response.ok) throw new Error("Device authorization failed");
        return v.parse(exchangeSchema, await response.json());
      },
    );
    if (!data) return null;

    return readOpenAIResponse(
      "exchange_authorization_code",
      () =>
        this.post(
          "/oauth/token",
          new URLSearchParams({
            grant_type: "authorization_code",
            client_id: clientId,
            code: data.authorization_code,
            code_verifier: data.code_verifier,
            redirect_uri: issuer + "/deviceauth/callback",
          }),
        ),
      async (response) => {
        if (!response.ok) throw new Error("Authorization code exchange failed");
        const value: unknown = await response.json();
        return this.validate(value).catch((error) => {
          if (error instanceof CodexDeviceError) throw error;
          throw new CodexDeviceError("validate_tokens", response.status);
        });
      },
    );
  }

  async refresh(previous: CodexCredentials): Promise<CodexCredentials> {
    const response = await this.post("/oauth/token", {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: previous.refreshToken,
    });
    if (
      response.status === 400 ||
      response.status === 401 ||
      response.status === 403
    )
      throw new ReauthenticationRequired();
    if (!response.ok) throw new Error("ChatGPT token refresh failed");
    return this.validate(await response.json(), previous);
  }

  private async post(
    path: string,
    payload: Record<string, string> | URLSearchParams,
  ) {
    const isForm = payload instanceof URLSearchParams;
    return this.http(issuer + path, {
      method: "POST",
      // Workers supports manual redirects. Callers reject the non-2xx response.
      redirect: "manual",
      headers: {
        "Content-Type": isForm
          ? "application/x-www-form-urlencoded"
          : "application/json",
      },
      body: isForm ? payload : JSON.stringify(payload),
      signal: AbortSignal.timeout(7_000),
    });
  }

  private async validate(value: unknown, previous?: CodexCredentials) {
    const tokens = v.parse(tokensSchema, value);
    const idToken = tokens.id_token ?? previous?.idToken;
    const refreshToken = tokens.refresh_token ?? previous?.refreshToken;
    if (!idToken || !refreshToken)
      throw new Error("Incomplete ChatGPT credentials");

    const claims = tokens.id_token
      ? (await jwtVerify(idToken, this.jwks, { issuer, audience: clientId }))
          .payload
      : decodeJwt(idToken);
    const identity = v.parse(identitySchema, claims)[
      "https://api.openai.com/auth"
    ];
    if (previous && previous.accountId !== identity.chatgpt_account_id)
      throw new Error("Connection account changed");
    const accessClaims = decodeJwt(tokens.access_token);
    const expiresAt = (accessClaims.exp ?? 0) * 1000;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
      throw new Error("Invalid access token expiration");

    return {
      accessToken: tokens.access_token,
      refreshToken,
      idToken,
      accountId: identity.chatgpt_account_id,
      planType: identity.chatgpt_plan_type,
      expiresAt,
    };
  }
}
