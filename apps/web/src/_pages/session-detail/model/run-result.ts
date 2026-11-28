const pullRequestUrl = (value: unknown) => {
  if (typeof value !== "string" || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  return url.origin === "https://github.com" &&
    /^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(url.pathname)
    ? url.origin + url.pathname.replace(/\/$/, "")
    : undefined;
};

/**
 * What a finished Run left to show: the pull requests of the branches it
 * pushed. Older Runs kept one pull request, and older planning Runs kept
 * whether they presented a plan.
 */
export function runResult(result: string | null): {
  plan?: string;
  urls?: string[];
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
      const url = pullRequestUrl(data.url);
      return url ? { urls: [url] } : {};
    }
    if (
      data.kind === "pull_requests" &&
      "pullRequests" in data &&
      Array.isArray(data.pullRequests)
    ) {
      const urls = data.pullRequests.flatMap((pull: unknown) => {
        const url =
          pull && typeof pull === "object" && "url" in pull
            ? pullRequestUrl(pull.url)
            : undefined;
        return url ? [url] : [];
      });
      return urls.length ? { urls } : {};
    }
  } catch {
    return {};
  }
  return {};
}
