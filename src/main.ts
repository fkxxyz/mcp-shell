import { loadConfig } from "./config.js";
import { createApp } from "./http/app.js";

async function main(): Promise<void> {
  const config = await loadConfig();
  const runtime = await createApp(config);

  const server = runtime.app.listen(config.port, "0.0.0.0", () => {
    console.log(`MCP demo listening on 0.0.0.0:${config.port}`);
    console.log(`Public MCP URL: ${config.publicBaseUrl}/mcp`);
    console.log(`OAuth issuer:   ${config.publicBaseUrl}`);
    console.log(`Config file:    ${config.paths.envFile}`);
    console.log(`Shell env file: ${config.paths.shellEnvFile ?? "(none)"}`);
    console.log(`State file:     ${config.paths.stateFile}`);
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
