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
import type { ToolHistoryStore } from "./tool-history-store.js";

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
  private historyFailureReported = false;

  constructor(
    private readonly logs: ToolHistoryStore,
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

      const persisted = await this.persistSafely(record, inputPreview);
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
        payloadAvailable: persisted?.retained ?? false,
      });
      if (persisted?.evictedCallIds.length) {
        this.markCallsEvictedSafely(persisted.evictedCallIds);
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

      const persisted = await this.persistSafely(record, inputPreview);
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
        payloadAvailable: persisted?.retained ?? false,
      });
      if (persisted?.evictedCallIds.length) {
        this.markCallsEvictedSafely(persisted.evictedCallIds);
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

  private async persistSafely(
    record: ToolCallRecord,
    inputPreview?: Record<string, unknown>,
  ) {
    try {
      const persisted = await this.logs.persist(record, inputPreview);
      this.historyFailureReported = false;
      return persisted;
    } catch (error) {
      if (!this.historyFailureReported) {
        this.historyFailureReported = true;
        console.error("Failed to persist tool log:", error);
      }
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

  private markCallsEvictedSafely(callIds: string[]): void {
    try {
      this.activity.markCallsEvicted(callIds);
    } catch (error) {
      console.error("Failed to update tool payload retention state:", error);
    }
  }
}
