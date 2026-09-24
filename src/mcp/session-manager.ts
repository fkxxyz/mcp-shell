import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./server.js";

export class McpSessionManager {
  private readonly transports = new Map<string, StreamableHTTPServerTransport>();

  constructor(private readonly cwd: string) {}

  get(sessionId: string | undefined): StreamableHTTPServerTransport | undefined {
    return sessionId ? this.transports.get(sessionId) : undefined;
  }

  async resolveForPost(
    sessionId: string | undefined,
    body: unknown,
  ): Promise<StreamableHTTPServerTransport | undefined> {
    const existing = this.get(sessionId);
    if (existing) return existing;
    if (sessionId || !isInitializeRequest(body)) return undefined;

    let transport: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.transports.set(id, transport);
      },
    });

    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) this.transports.delete(id);
    };

    const server = createMcpServer(this.cwd);
    await server.connect(transport);
    return transport;
  }

  async closeAll(): Promise<void> {
    const transports = [...this.transports.values()];
    this.transports.clear();
    await Promise.allSettled(transports.map((transport) => transport.close()));
  }
}
