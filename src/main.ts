import type { Server } from "node:http";
import { listenHostForMode, loadConfig } from "./config.js";
import { createApp } from "./http/app.js";

async function main(): Promise<void> {
  const announceDevOrigin = process.env.MCP_SHELL_DEV_ANNOUNCE === "1";
  const config = await loadConfig();
  const runtime = await createApp(config);
  const listenHost = listenHostForMode(config.mode);

  const server = runtime.app.listen(config.port, listenHost, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : config.port;
    console.log(`MCP Shell listening on ${listenHost}:${actualPort} (${config.mode} mode)`);
    if (announceDevOrigin) {
      const devHost = listenHost === "0.0.0.0" ? "127.0.0.1" : listenHost;
      console.log(`MCP_SHELL_DEV_ORIGIN=http://${devHost}:${actualPort}`);
    }
    if (config.mode === "local") {
      console.log(`Local MCP URL:  http://${listenHost}:${actualPort}/mcp`);
    } else {
      console.log(`Public MCP URL: ${config.publicBaseUrl}/mcp`);
      console.log(`OAuth issuer:   ${config.publicBaseUrl}`);
      console.log(`State file:     ${config.paths.stateFile}`);
    }
    if (config.webPassword) {
      const webBase = config.mode === "local"
        ? `http://${listenHost}:${actualPort}`
        : config.publicBaseUrl;
      console.log(`Web Console:    ${webBase}/console/`);
      console.log("Web user:       activity");
    }
    console.log(`Config file:    ${config.paths.envFile}`);
    console.log(`Shell env file: ${config.paths.shellEnvFile ?? "(none)"}`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;

    const startedAt = Date.now();
    console.log(`Shutdown started: signal=${signal}`);

    const runtimeClose = runtime.close();
    const serverClose = closeServer(server);
    try {
      await runtimeClose;
      server.closeIdleConnections();
      await serverClose;
      console.log(`Shutdown completed: duration=${Date.now() - startedAt}ms`);
    } catch (error) {
      console.error("Shutdown failed:", error);
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
