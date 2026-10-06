import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { ActivityTracker } from "./activity-tracker.js";
import { createInputPreview } from "./input-preview.js";
import type {
  FinishedToolCallSummary,
  ToolCallRecord,
  ToolLogContext,
} from "./tool-call.js";
import { serializeToolError } from "./tool-call.js";
import type { ToolLogStore } from "./tool-log-store.js";

export type RecordedCallContext = {
  tool: string;
  input: unknown;
  shellId?: number;
  cwd?: string;
};

export type CompletionIdentity = {
  shellId?: number;
  cwd?: string;
};

const contextStorage = new AsyncLocalStorage<ToolLogContext>();

export function withToolLogContext<T>(context: ToolLogContext, callback: () => T): T {
  return contextStorage.run(context, callback);
}

export function toolLogActorFromToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export class ToolCallRecorder {
  private sequence = 0;

  constructor(
    private readonly logs: ToolLogStore,
    private readonly activity: ActivityTracker,
  ) {}

  async run<T>(
    meta: RecordedCallContext,
    execute: () => Promise<T>,
    completionIdentity?: (output: T) => CompletionIdentity | undefined,
  ): Promise<T> {
    const id = randomUUID();
    const sequence = ++this.sequence;
    const startedAt = Date.now();
    const context = contextStorage.getStore();
    const inputPreview = this.createInputPreviewSafely(meta.input);

    this.publishStarted({
      id,
      tool: meta.tool,
      shellId: meta.shellId,
      cwd: meta.cwd,
      inputPreview,
      startedAt,
    });

    try {
      const output = await execute();
      const finishedAt = Date.now();
      const completedIdentity = this.resolveCompletionIdentitySafely(completionIdentity, output);

      const record: ToolCallRecord = {
        version: 2,
        id,
        sequence,
        shell_id: completedIdentity?.shellId ?? meta.shellId,
        cwd: completedIdentity?.cwd ?? meta.cwd,
        started_at: new Date(startedAt).toISOString(),
        finished_at: new Date(finishedAt).toISOString(),
        duration_ms: finishedAt - startedAt,
        session: context?.session,
        actor: context?.actor,
        tool: meta.tool,
        input: meta.input,
        status: "success",
        output,
      };

      const persisted = await this.persistSafely(record);
      this.publishFinished({
        id,
        tool: meta.tool,
        shellId: record.shell_id,
        cwd: record.cwd,
        inputPreview,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        status: "success",
        payloadAvailable: persisted !== undefined,
        payloadFile: persisted?.file,
      });
      if (persisted?.evictedFiles.length) {
        this.markPayloadsEvictedSafely(persisted.evictedFiles);
      }

      return output;
    } catch (error) {
      const finishedAt = Date.now();
      const record: ToolCallRecord = {
        version: 2,
        id,
        sequence,
        shell_id: meta.shellId,
        cwd: meta.cwd,
        started_at: new Date(startedAt).toISOString(),
        finished_at: new Date(finishedAt).toISOString(),
        duration_ms: finishedAt - startedAt,
        session: context?.session,
        actor: context?.actor,
        tool: meta.tool,
        input: meta.input,
        status: "error",
        error: serializeToolError(error),
      };

      const persisted = await this.persistSafely(record);
      this.publishFinished({
        id,
        tool: meta.tool,
        shellId: meta.shellId,
        cwd: meta.cwd,
        inputPreview,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        status: "error",
        payloadAvailable: persisted !== undefined,
        payloadFile: persisted?.file,
      });
      if (persisted?.evictedFiles.length) {
        this.markPayloadsEvictedSafely(persisted.evictedFiles);
      }

      throw error;
    }
  }

  private resolveCompletionIdentitySafely<T>(
    resolver: ((output: T) => CompletionIdentity | undefined) | undefined,
    output: T,
  ): CompletionIdentity | undefined {
    if (!resolver) return undefined;
    try {
      return resolver(output);
    } catch (error) {
      console.error("Failed to resolve tool activity completion identity:", error);
      return undefined;
    }
  }

  private createInputPreviewSafely(input: unknown): Record<string, unknown> | undefined {
    try {
      return createInputPreview(input);
    } catch (error) {
      console.error("Failed to create tool activity input preview:", error);
      return undefined;
    }
  }

  private async persistSafely(record: ToolCallRecord) {
    try {
      return await this.logs.persist(record);
    } catch (error) {
      console.error("Failed to persist tool log:", error);
      return undefined;
    }
  }

  private publishStarted(call: {
    id: string;
    tool: string;
    shellId?: number;
    cwd?: string;
    inputPreview?: Record<string, unknown>;
    startedAt: number;
  }): void {
    try {
      this.activity.started(call);
    } catch (error) {
      console.error("Failed to publish tool activity start:", error);
    }
  }

  private publishFinished(call: FinishedToolCallSummary): void {
    try {
      this.activity.finished(call);
    } catch (error) {
      console.error("Failed to publish tool activity finish:", error);
    }
  }

  private markPayloadsEvictedSafely(files: string[]): void {
    try {
      this.activity.markPayloadsEvicted(files);
    } catch (error) {
      console.error("Failed to update tool payload retention state:", error);
    }
  }
}
