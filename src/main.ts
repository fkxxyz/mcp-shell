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
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    server.close();
    await runtime.close();
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
