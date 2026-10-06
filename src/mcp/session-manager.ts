import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { CommandPathPolicy } from "../command-path.js";
import type { FileMutationCoordinator } from "../host/file-mutation-coordinator.js";
import type { ProcessSupervisor } from "../host/process-supervisor.js";
import type { ToolCallRecorder } from "../observability/tool-call-recorder.js";
import type { ShellStore } from "../shell-store.js";
import type { SkillCatalog } from "../skills.js";
import type { InvocationGate } from "../tools/invocation-gate.js";
import type { LSPServerManager } from "../tools/lsp.js";
import { createMcpServer } from "./server.js";

export class McpSessionManager {
  private readonly transports = new Map<string, StreamableHTTPServerTransport>();
  private closing = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly invocations: InvocationGate,
    private readonly shells: ShellStore,
    private readonly recorder: ToolCallRecorder,
    private readonly commandPath: CommandPathPolicy,
    private readonly skills: SkillCatalog,
    private readonly mutations: FileMutationCoordinator,
    private readonly processes: ProcessSupervisor,
    private readonly lspManager: LSPServerManager,
  ) {}

  get(sessionId: string | undefined): StreamableHTTPServerTransport | undefined {
    return sessionId ? this.transports.get(sessionId) : undefined;
  }

  async resolveForPost(
    sessionId: string | undefined,
    body: unknown,
  ): Promise<StreamableHTTPServerTransport | undefined> {
    const existing = this.get(sessionId);
    if (existing) return existing;
    if (this.closing) return undefined;
    if (sessionId || !isInitializeRequest(body)) return undefined;

    let transport: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: async (id) => {
        if (this.closing) {
          await transport.close();
          return;
        }
        this.transports.set(id, transport);
      },
    });

    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) this.transports.delete(id);
    };

    const server = createMcpServer(
      this.invocations,
      this.shells,
      this.recorder,
      this.commandPath,
      this.skills,
      this.mutations,
      this.processes,
      this.lspManager,
    );
    await server.connect(transport);
    if (this.closing) {
      await transport.close();
      return undefined;
    }
    return transport;
  }

  stopAccepting(): void {
    this.closing = true;
  }

  closeStandaloneStreams(): void {
    for (const transport of this.transports.values()) {
      transport.closeStandaloneSSEStream();
    }
  }

  close(): Promise<void> {
    this.stopAccepting();
    this.closePromise ??= this.closeTransports();
    return this.closePromise;
  }

  private async closeTransports(): Promise<void> {
    while (this.transports.size > 0) {
      const transports = [...this.transports.values()];
      this.transports.clear();
      await Promise.allSettled(transports.map((transport) => transport.close()));
    }
  }
}
