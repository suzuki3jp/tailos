export function runResult(result: string | null): {
  plan?: string;
  url?: string;
} {
  if (!result) return {};
  try {
    const data: unknown = JSON.parse(result);
    if (!data || typeof data !== "object" || !("kind" in data)) return {};
    if (
      data.kind === "plan" &&
      "planPresented" in data &&
      typeof data.planPresented === "boolean" &&
      "needsAnswer" in data &&
      typeof data.needsAnswer === "boolean"
    ) {
      return {
        plan: [
          data.planPresented ? "計画あり" : "計画未提示",
          data.needsAnswer ? "回答待ち" : "質問なし",
        ].join("・"),
      };
    }
    if (
      data.kind === "pull_request" &&
      "url" in data &&
      typeof data.url === "string"
    ) {
      const url = new URL(data.url);
      if (
        url.origin === "https://github.com" &&
        /^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(url.pathname)
      )
        return { url: url.href };
    }
  } catch {
    return {};
  }
  return {};
}
