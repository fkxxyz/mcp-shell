import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => {
  const apiOrigin = process.env.MCP_SHELL_DEV_API_ORIGIN;
  if (command === "serve" && !apiOrigin) {
    throw new Error("MCP_SHELL_DEV_API_ORIGIN is required. Use `npm run dev` to start the full development stack.");
  }

  return {
    root: "web",
    base: "/console/",
    plugins: [react()],
    build: {
      outDir: "../dist/web",
      emptyOutDir: true,
    },
    server: {
      host: "127.0.0.1",
      proxy: apiOrigin ? {
        "/api": {
          target: apiOrigin,
          changeOrigin: false,
        },
      } : undefined,
    },
  };
});
