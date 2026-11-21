import { assert, expect, test } from "vitest";
import { createTestDb } from "@/infrastructure/d1/testing.ts";
import { createLoginAuth } from "./login.ts";
import { testLoginBindings } from "./testing.ts";

test.for([
  {
    api: "https://api.tailos.example",
    web: "https://tailos.example",
    viaWeb: "true",
    name: "__Host-tailos.session_token",
    secure: true,
  },
  {
    api: "http://localhost:8787",
    web: "http://localhost:3000",
    viaWeb: undefined,
    name: "tailos.session_token",
    secure: false,
  },
  {
    api: "https://api.example",
    web: "https://unrelated.example",
    viaWeb: undefined,
    name: "__Secure-tailos.session_token",
    secure: true,
  },
])(
  "uses host-only cookies with the expected name and security attributes: $name",
  async ({ api, web, viaWeb, name, secure }, t) => {
    const DB = await createTestDb(t);
    const auth = createLoginAuth({
      ...testLoginBindings(DB),
      TAILOS_PUBLIC_ORIGIN: api,
      TAILOS_WEB_ORIGIN: web,
      TAILOS_BROWSER_API_VIA_WEB: viaWeb,
    });
    assert(auth);
    const context = await auth.$context;
    expect(context.authCookies.sessionToken).toMatchObject({
      name,
      attributes: {
        secure,
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      },
    });
    expect(context.authCookies.sessionToken.attributes.domain).toBeUndefined();
    expect(context.authCookies.sessionData.attributes.domain).toBeUndefined();
    expect(
      context.authCookies.dontRememberToken.attributes.domain,
    ).toBeUndefined();
  },
);
