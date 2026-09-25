import { listenHostForMode, loadConfig } from "./config.js";
import { createApp } from "./http/app.js";

async function main(): Promise<void> {
  const config = await loadConfig();
  const runtime = await createApp(config);
  const listenHost = listenHostForMode(config.mode);

  const server = runtime.app.listen(config.port, listenHost, () => {
    console.log(`MCP Shell listening on ${listenHost}:${config.port} (${config.mode} mode)`);
    if (config.mode === "local") {
      console.log(`Local MCP URL:  http://${listenHost}:${config.port}/mcp`);
    } else {
      console.log(`Public MCP URL: ${config.publicBaseUrl}/mcp`);
      console.log(`OAuth issuer:   ${config.publicBaseUrl}`);
      console.log(`State file:     ${config.paths.stateFile}`);
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
