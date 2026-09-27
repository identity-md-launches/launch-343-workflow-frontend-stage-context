import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "serve-attested-config-in-development",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const path = req.url?.split("?")[0];
          if (
            !path ||
            !/^\/(imd-deployment\.json|abi\/[A-Za-z0-9_-]+\.json)$/.test(path)
          )
            return next();
          try {
            const data = await readFile(
              new URL(`../dist${path}`, import.meta.url),
            );
            res.setHeader("Content-Type", "application/json");
            res.end(data);
          } catch {
            res.statusCode = 503;
            res.end("Build the deployment export first with npm run build.");
          }
        });
      },
    },
  ],
  base: "./",
  build: { outDir: "../dist", emptyOutDir: true, sourcemap: false },
});
