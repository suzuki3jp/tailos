import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";
import { defineConfig } from "vite";
import vinext from "vinext";

export default defineConfig({
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
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
  server: { port: 3000, strictPort: true },
});
