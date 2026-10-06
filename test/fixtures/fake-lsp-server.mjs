const shouldExit = process.argv.includes("--exit-immediately");

if (shouldExit) {
  process.exitCode = 23;
  process.stdin.resume();
  setImmediate(() => process.exit());
} else {
  let buffer = Buffer.alloc(0);

  const send = (message) => {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
    process.stdout.write(body);
  };

  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const header = buffer.slice(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }

      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (buffer.length < bodyEnd) return;

      const message = JSON.parse(buffer.slice(bodyStart, bodyEnd).toString("utf8"));
      buffer = buffer.slice(bodyEnd);

      if (typeof message.id === "number" && typeof message.method === "string") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            method: message.method,
            params: message.params ?? null,
          },
        });
      }
    }
  });
}
