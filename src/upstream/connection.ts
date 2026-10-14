import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamDefinition } from "./config.js";

const CLIENT_INFO = { name: "mcp-shell-upstream", version: "0.1.0" };

/**
 * One long-lived Streamable HTTP client per upstream, shared by every MCP session.
 * A transport failure drops the client; the next call reconnects. An in-flight call
 * is never retried, because the upstream tool may already have run.
 */
export class UpstreamConnection {
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;

  constructor(
    readonly name: string,
    private readonly url: URL,
    private readonly timeoutMs: number,
  ) {}

  static fromDefinition(definition: UpstreamDefinition, timeoutMs: number): UpstreamConnection {
    return new UpstreamConnection(definition.name, definition.url, timeoutMs);
  }

  async listTools(): Promise<Tool[]> {
    const client = await this.ensureClient();
    const tools: Tool[] = [];
    let cursor: string | undefined;
    try {
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: this.timeoutMs });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
    } catch (error) {
      this.discardIfTransportFailure(client, error);
      throw describeFailure(this.name, error);
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown> | undefined, signal: AbortSignal | undefined): Promise<CallToolResult> {
    let client: Client;
    try {
      client = await this.ensureClient();
    } catch (error) {
      throw describeFailure(this.name, error);
    }

    try {
      return await client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: this.timeoutMs, signal },
      ) as CallToolResult;
    } catch (error) {
      if (signal?.aborted) throw error;
      this.discardIfTransportFailure(client, error);
      throw describeFailure(this.name, error);
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => undefined);
  }

  private async ensureClient(): Promise<Client> {
    if (this.client) return this.client;
    this.connecting ??= this.connect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connect(): Promise<Client> {
    const client = new Client(CLIENT_INFO);
    const transport = new StreamableHTTPClientTransport(this.url);
    client.onclose = () => {
      if (this.client === client) this.client = undefined;
    };
    await client.connect(transport, { timeout: this.timeoutMs });
    this.client = client;
    return client;
  }

  private discardIfTransportFailure(client: Client, error: unknown): void {
    if (!isTransportFailure(error)) return;
    if (this.client === client) this.client = undefined;
    void client.close().catch(() => undefined);
  }
}

/** Server-reported JSON-RPC errors leave the connection usable; everything else means it is gone. */
function isTransportFailure(error: unknown): boolean {
  if (error instanceof McpError) return error.code === ErrorCode.ConnectionClosed;
  return error instanceof Error;
}

function describeFailure(upstream: string, error: unknown): Error {
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
    return new Error(`upstream ${upstream} timed out`);
  }
  if (error instanceof McpError && error.code !== ErrorCode.ConnectionClosed) {
    return new Error(`upstream ${upstream} error: ${error.message}`);
  }
  if (isTransportFailure(error)) {
    return new Error(`upstream ${upstream} unavailable`);
  }
  return error instanceof Error ? error : new Error(String(error));
}
