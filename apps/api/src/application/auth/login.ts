export type LoginAuth = {
  api: {
    getSession(input: {
      headers: Headers;
    }): Promise<{ user: { id: string } } | null>;
    signInSocial(input: {
      body: { provider: "github"; callbackURL: string };
      headers: Headers;
      asResponse: true;
    }): Promise<Response>;
    signOut(input: { headers: Headers; asResponse: true }): Promise<Response>;
  };
  handler(request: Request): Promise<Response>;
};
export type BrowserApiOrigins = {
  TAILOS_PUBLIC_ORIGIN?: string;
  TAILOS_WEB_ORIGIN?: string;
  TAILOS_BROWSER_API_VIA_WEB?: string;
};

export function browserApiOrigin(env?: BrowserApiOrigins) {
  return env?.TAILOS_BROWSER_API_VIA_WEB === "true"
    ? env.TAILOS_WEB_ORIGIN
    : env?.TAILOS_PUBLIC_ORIGIN;
}
