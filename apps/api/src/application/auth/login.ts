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
