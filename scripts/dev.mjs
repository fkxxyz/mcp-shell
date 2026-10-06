import { spawn } from "node:child_process";

let stopping = false;
let web;
let stdoutBuffer = "";

const server = spawn("npm", ["run", "dev:server"], {
  stdio: ["inherit", "pipe", "inherit"],
  env: {
    ...process.env,
    MCP_SHELL_DEV_ANNOUNCE: "1",
  },
});

server.stdout.setEncoding("utf8");
server.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  stdoutBuffer += chunk;

  for (;;) {
    const newline = stdoutBuffer.indexOf("\n");
    if (newline < 0) break;

    const line = stdoutBuffer.slice(0, newline);
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    maybeStartWeb(line);
  }
});

server.on("error", fail);
server.on("exit", (code, signal) => {
  if (stopping) return;
  stop();
  process.exitCode = code ?? (signal ? 1 : 0);
});

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

function maybeStartWeb(line) {
  if (web) return;

  const match = /^MCP_SHELL_DEV_ORIGIN=(http:\/\/127\.0\.0\.1:\d+)$/.exec(line);
  if (!match) return;

  const apiOrigin = match[1];

  web = spawn("npm", ["run", "dev:web"], {
    stdio: "inherit",
    env: {
      ...process.env,
      MCP_SHELL_DEV_API_ORIGIN: apiOrigin,
    },
  });
  web.on("error", fail);
  web.on("exit", (code, signal) => {
    if (stopping) return;
    stop();
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

function fail(error) {
  console.error(error);
  stop();
  process.exitCode = 1;
}

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;

  if (!server.killed) server.kill(signal);
  if (web && !web.killed) web.kill(signal);
}
