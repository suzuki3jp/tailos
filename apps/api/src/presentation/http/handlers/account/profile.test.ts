import { expect, test } from "vitest";
import app, { browserProxy } from "@/bootstrap/http.ts";
import { createTestDb } from "@/infrastructure/d1/testing.ts";
import {
  createTestOperator,
  testLoginBindings,
} from "@/infrastructure/auth/testing.ts";

test.for([false, true])(
  "profile exposes only the authenticated operator's public fields (Web proxy: %s)",
  async (viaWeb, t) => {
    const DB = await createTestDb(t);
    const bindings = {
      ...testLoginBindings(DB),
      TAILOS_BROWSER_API_VIA_WEB: viaWeb ? "true" : undefined,
    };
    const other = await createTestOperator({
      ...bindings,
      TAILOS_OPERATOR_GITHUB_ID: "456",
    });
    await DB.prepare("UPDATE users SET email = ? WHERE id = ?")
      .bind("other@example.test", other.id)
      .run();
    const operator = await createTestOperator(bindings);
    const image = "https://avatars.githubusercontent.com/u/123?v=4";
    await DB.prepare("UPDATE users SET image = ? WHERE id = ?")
      .bind(image, operator.id)
      .run();
    const router = viaWeb ? browserProxy : app;
    const url = viaWeb
      ? `${bindings.TAILOS_WEB_ORIGIN}/api/v1/account/profile`
      : `${bindings.TAILOS_PUBLIC_ORIGIN}/v1/account/profile`;
    const response = await router.request(
      url + `?userId=${other.id}`,
      {
        headers: {
          Cookie: operator.cookie,
          Origin: bindings.TAILOS_WEB_ORIGIN,
        },
      },
      bindings,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({
      name: "Operator",
      email: "operator@example.test",
      image,
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      bindings.TAILOS_WEB_ORIGIN,
    );
    expect((await router.request(url, {}, bindings)).status).toBe(401);
    expect(
      (
        await router.request(
          url,
          { headers: { Cookie: other.cookie } },
          bindings,
        )
      ).status,
    ).toBe(401);
  },
);
