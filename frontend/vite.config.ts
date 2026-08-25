import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(({ command, mode, isPreview }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const enableThreeBossesLocal =
    command === "serve"
    && mode === "development"
    && !isPreview
    && env.VITE_ENABLE_THREE_BOSSES_LOCAL === "1";

  return {
    plugins: [react()],
    root: ".",
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "ts"),
      },
    },
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": {
          target: "http://localhost:8080",
          changeOrigin: true,
        },
        ...(enableThreeBossesLocal
          ? {
              "/__local/three-bosses/": {
                target: "http://127.0.0.1:4174",
                changeOrigin: true,
                rewrite: (requestPath: string) =>
                  requestPath.replace(/^\/__local\/three-bosses\//, "/"),
              },
            }
          : {}),
      },
    },
    preview: {
      port: 4173,
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
