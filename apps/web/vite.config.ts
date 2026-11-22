import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { webBrowserApiPath } from "@tailos/core/auth";
import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";
import { defineConfig } from "vite";
import vinext from "vinext";

export default defineConfig(({ command }) => ({
  resolve: { tsconfigPaths: true },
  plugins: [
    tailwindcss(),
    vinext({
      images: { optimizer: imagesOptimizer() },
      nextConfig: {
        images: {
          localPatterns: [{ pathname: "/tailos-wordmark.png", search: "" }],
        },
      },
    }),
    cloudflare({
      config:
        command === "build"
          ? {
              services: [
                {
                  binding: "BROWSER_API",
                  service: "tailos-api",
                  entrypoint: "BrowserApiProxy",
                },
              ],
              assets: {
                binding: "ASSETS",
                run_worker_first: [webBrowserApiPath, `${webBrowserApiPath}/*`],
              },
            }
          : undefined,
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
  server: { port: 3000, strictPort: true },
}));
