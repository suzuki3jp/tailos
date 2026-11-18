import { assert, expect, test } from "vitest";
import { createTestDb } from "@/infrastructure/d1/testing.ts";
import { createLoginAuth } from "./login.ts";
import { testLoginBindings } from "./testing.ts";

test.for([
  {
    api: "https://api.tailos.example",
    web: "https://tailos.example",
    domain: "tailos.example",
    secure: true,
  },
  {
    api: "http://localhost:8787",
    web: "http://localhost:3000",
    domain: undefined,
    secure: false,
  },
  {
    api: "https://api.example",
    web: "https://unrelated.example",
    domain: undefined,
    secure: true,
  },
])(
  "shares only the session cookie with the configured web parent: $api",
  async ({ api, web, domain, secure }, t) => {
    const DB = await createTestDb(t);
    const auth = createLoginAuth({
      ...testLoginBindings(DB),
      TAILOS_PUBLIC_ORIGIN: api,
      TAILOS_WEB_ORIGIN: web,
    });
    assert(auth);
    const context = await auth.$context;
    expect(context.authCookies.sessionToken).toMatchObject({
      name: `${secure ? "__Secure-" : ""}tailos.session_token`,
      attributes: {
        domain,
        secure,
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      },
    });
    expect(context.authCookies.sessionData.attributes.domain).toBeUndefined();
    expect(
      context.authCookies.dontRememberToken.attributes.domain,
    ).toBeUndefined();
  },
);
