import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, Tool, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { fromJSONSchema, ZodObject } from "zod";
import type { InvocationGate } from "../tools/invocation-gate.js";
import type { UpstreamConfig } from "./config.js";
import { UpstreamConnection } from "./connection.js";

const RESULT_TEXT_LIMIT_BYTES = 50 * 1024;
const TRUNCATION_NOTICE = "\n[truncated by mcp-shell: upstream result exceeded 50KB]";

type ProxiedTool = {
  upstream: string;
  name: string;
  description?: string;
  annotations?: ToolAnnotations;
  inputSchema: ZodObject;
};

/**
 * Upstream tool definitions, fetched once at startup and fixed for the process lifetime.
 * Every MCP session registers the same proxied tools; the connections are shared.
 */
export class UpstreamSet {
  private constructor(
    private readonly connections: UpstreamConnection[],
    readonly tools: ProxiedTool[],
    private readonly byName: Map<string, UpstreamConnection>,
  ) {}

  static async connect(config: UpstreamConfig): Promise<UpstreamSet> {
    const connections = config.upstreams.map((definition) =>
      UpstreamConnection.fromDefinition(definition, config.timeoutMs),
    );
    const listings = await Promise.all(connections.map(async (connection) => {
      try {
        return { connection, tools: await connection.listTools() };
      } catch (error) {
        await Promise.all(connections.map((other) => other.close()));
        throw new Error(`Upstream "${connection.name}" failed at startup: ${(error as Error).message}`);
      }
    }));

    const tools: ProxiedTool[] = [];
    const byName = new Map<string, UpstreamConnection>();
    for (const { connection, tools: listed } of listings) {
      console.log(`Upstream ${connection.name}: ${listed.length} tool(s)`);
      byName.set(connection.name, connection);
      for (const tool of listed) tools.push(toProxiedTool(connection.name, tool));
    }
    return new UpstreamSet(connections, tools, byName);
  }

  async callTool(upstream: string, name: string, args: Record<string, unknown> | undefined, signal: AbortSignal | undefined): Promise<CallToolResult> {
    const connection = this.byName.get(upstream);
    if (!connection) throw new Error(`upstream ${upstream} is not configured`);
    return boundResult(await connection.callTool(name, args, signal));
  }

  /** Closing also fails in-flight calls; the shutdown path relies on that to stop waiting on them. */
  async close(): Promise<void> {
    await Promise.all(this.connections.map((connection) => connection.close()));
  }
}

/**
 * Registers proxied tools on a server. McpServer rejects duplicate names, so passing
 * this a server that already has native tools detects collisions.
 */
export function registerUpstreamTools(server: McpServer, set: UpstreamSet, invocations: InvocationGate): void {
  for (const tool of set.tools) {
    try {
      server.registerTool(tool.name, {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      }, async (args, extra) => invocations.run(
        (context) => context.execute(() => set.callTool(
          tool.upstream,
          tool.name,
          args as Record<string, unknown>,
          extra.signal,
        )),
        { shutdownCancellable: true },
      ));
    } catch (error) {
      throw new Error(`Upstream "${tool.upstream}" tool "${tool.name}" conflicts with an existing tool: ${(error as Error).message}`);
    }
  }
}

function toProxiedTool(upstream: string, tool: Tool): ProxiedTool {
  if (tool.inputSchema.type !== "object") {
    throw new Error(`Upstream "${upstream}" tool "${tool.name}" has a non-object input schema`);
  }
  // fromJSONSchema does not throw on unfamiliar keywords; it ignores them. Type, enum, pattern,
  // and format checks are enforced as pre-validation. The upstream remains the authority and
  // validates again, so an ignored keyword can only let an invalid call through to the upstream,
  // never bypass it.
  const schema = fromJSONSchema(tool.inputSchema as Record<string, unknown>);
  if (!(schema instanceof ZodObject)) {
    throw new Error(`Upstream "${upstream}" tool "${tool.name}" input schema did not convert to an object`);
  }
  return {
    upstream,
    name: tool.name,
    description: tool.description,
    annotations: tool.annotations,
    inputSchema: schema,
  };
}

function boundResult(result: CallToolResult): CallToolResult {
  let remaining = RESULT_TEXT_LIMIT_BYTES;
  let truncated = false;
  const content = result.content.map((block) => {
    if (block.type !== "text") return block;
    const bytes = Buffer.byteLength(block.text, "utf8");
    if (bytes <= remaining) {
      remaining -= bytes;
      return block;
    }
    truncated = true;
    const text = Buffer.from(block.text, "utf8").subarray(0, Math.max(remaining, 0)).toString("utf8");
    remaining = 0;
    return { ...block, text };
  });
  if (!truncated) return result;
  const notice = { type: "text" as const, text: TRUNCATION_NOTICE };
  return { ...result, content: [...content, notice] };
}
