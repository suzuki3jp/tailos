import { DurableObject } from "cloudflare:workers";

export class RunnerContainer extends DurableObject {
  async checkHealth(): Promise<boolean> {
    const container = this.ctx.container;
    const image = container?.images.runner;
    if (!container || !image) return false;

    try {
      container.start({ image, instance: "lite", enableInternet: false });
      await container.setInactivityTimeout(30_000);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          const response = await container
            .getTcpPort(8080)
            .fetch("http://runner/health", {
              signal: AbortSignal.timeout(1_000),
            });
          const body: unknown = await response.json();
          if (
            response.ok &&
            typeof body === "object" &&
            body !== null &&
            "status" in body &&
            body.status === "ok" &&
            "service" in body &&
            body.service === "runner"
          )
            return true;
        } catch {
          // The process may not have opened its port yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return false;
    } finally {
      await container.destroy().catch(() => {
        // oxlint-disable-next-line no-console -- Record cleanup failures without container data.
        console.warn("Runner health check container cleanup failed");
      });
    }
  }
}
