import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  StdioLspConnection,
  type LspConnection,
  type LspLaunchSpec,
} from "./connection.js";

export type Position = {
  line: number;
  character: number;
};

export type Range = {
  start: Position;
  end: Position;
};

export type Diagnostic = {
  range: Range;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
};

type ProviderCapability = boolean | Record<string, unknown>;

type RenameProviderCapability =
  | boolean
  | {
      prepareProvider?: boolean;
      [key: string]: unknown;
    };

type DiagnosticProviderCapability =
  | boolean
  | {
      identifier?: string;
      interFileDependencies?: boolean;
      workspaceDiagnostics?: boolean;
      [key: string]: unknown;
    };

type ServerCapabilities = {
  definitionProvider?: ProviderCapability;
  referencesProvider?: ProviderCapability;
  documentSymbolProvider?: ProviderCapability;
  workspaceSymbolProvider?: ProviderCapability;
  renameProvider?: RenameProviderCapability;
  diagnosticProvider?: DiagnosticProviderCapability;
};

type InitializeResult = {
  capabilities?: ServerCapabilities;
};

type PushDiagnosticState = {
  sequence: number;
  version?: number;
  items: Diagnostic[];
};

type PullDiagnosticState = {
  resultId?: string;
  items: Diagnostic[];
};

type DiagnosticWaiter = {
  afterSequence: number;
  version: number;
  signal?: AbortSignal;
  abortListener?: () => void;
  timeout?: ReturnType<typeof setTimeout>;
  resolve: (state: PushDiagnosticState) => void;
  reject: (error: Error) => void;
};

type DocumentSyncState = {
  uri: string;
  version: number;
  changed: boolean;
  diagnosticSequence: number;
};

type FullDocumentDiagnosticReport = {
  kind?: "full";
  resultId?: string;
  items?: Diagnostic[];
};

type UnchangedDocumentDiagnosticReport = {
  kind: "unchanged";
  resultId?: string;
};

export type LspClientOptions = {
  serverId: string;
  initializationOptions?: Record<string, unknown>;
  languageIdForPath: (filePath: string) => string;
  pushDiagnosticsDeadlineMs?: number;
};

const DEFAULT_PUSH_DIAGNOSTICS_DEADLINE_MS = 15_000;
const SHUTDOWN_REQUEST_TIMEOUT_MS = 1_000;
const GRACEFUL_EXIT_WAIT_MS = 1_000;

function isCapabilityEnabled(
  capability: ProviderCapability | undefined,
): capability is ProviderCapability {
  return capability === true || (typeof capability === "object" && capability !== null);
}

export class LspClient {
  private readonly root: string;
  private readonly connection: LspConnection;
  private readonly openedFiles = new Set<string>();
  private readonly documentVersions = new Map<string, number>();
  private readonly lastSyncedText = new Map<string, string>();
  private readonly pushDiagnostics = new Map<string, PushDiagnosticState>();
  private readonly pullDiagnostics = new Map<string, PullDiagnosticState>();
  private readonly diagnosticWaiters = new Map<string, Set<DiagnosticWaiter>>();
  private serverCapabilities: ServerCapabilities = {};
  private initialized = false;
  private stopPromise: Promise<void> | undefined;

  constructor(
    private readonly options: LspClientOptions,
    launch: LspLaunchSpec,
    connection: LspConnection = new StdioLspConnection(launch),
  ) {
    this.root = launch.cwd;
    this.connection = connection;

    this.connection.onNotification("textDocument/publishDiagnostics", (params) => {
      this.handlePublishedDiagnostics(params);
    });
    this.connection.onRequest("workspace/configuration", (params) => {
      const items = (params as { items?: Array<{ section?: string }> } | undefined)?.items ?? [];
      return items.map((item) => (item.section === "json" ? { validate: { enable: true } } : {}));
    });
    this.connection.onClose((error) => {
      this.rejectDiagnosticWaiters(error);
    });
  }

  async start(): Promise<void> {
    await this.connection.start();
  }

  async initialize(): Promise<void> {
    const rootUri = pathToFileURL(this.root).href;
    const result = await this.connection.sendRequest<InitializeResult>("initialize", {
      processId: process.pid,
      rootUri,
      rootPath: this.root,
      workspaceFolders: [{ uri: rootUri, name: "workspace" }],
      capabilities: {
        textDocument: {
          definition: { linkSupport: true },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: { versionSupport: true },
          diagnostic: {
            dynamicRegistration: false,
            relatedDocumentSupport: false,
          },
          rename: {
            prepareSupport: true,
            prepareSupportDefaultBehavior: 1,
          },
        },
        workspace: {
          symbol: {},
          configuration: true,
        },
      },
      initializationOptions: this.options.initializationOptions,
    });

    this.serverCapabilities = result?.capabilities ?? {};
    this.connection.sendNotification("initialized");
    this.connection.sendNotification("workspace/didChangeConfiguration", {
      settings: { json: { validate: { enable: true } } },
    });
    this.initialized = true;
  }

  isAlive(): boolean {
    return this.connection.isAlive();
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopInternal();
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    let gracefulExitMs = 0;
    if (this.initialized && this.connection.isAlive()) {
      try {
        await this.connection.sendRequest("shutdown", undefined, {
          timeoutMs: SHUTDOWN_REQUEST_TIMEOUT_MS,
        });
        if (this.connection.isAlive()) {
          this.connection.sendNotification("exit");
          gracefulExitMs = GRACEFUL_EXIT_WAIT_MS;
        }
      } catch {}
    }

    this.rejectDiagnosticWaiters(new Error("LSP client stopped"));
    this.pushDiagnostics.clear();
    this.pullDiagnostics.clear();
    await this.connection.close({ gracefulExitMs });
  }

  async definition(filePath: string, line: number, character: number): Promise<unknown> {
    this.requireCapability(
      this.serverCapabilities.definitionProvider,
      "go-to-definition",
      "definitionProvider",
    );
    const sync = this.syncDocument(filePath);
    return this.connection.sendRequest("textDocument/definition", {
      textDocument: { uri: sync.uri },
      position: { line: line - 1, character },
    });
  }

  async references(
    filePath: string,
    line: number,
    character: number,
    includeDeclaration = true,
  ): Promise<unknown> {
    this.requireCapability(
      this.serverCapabilities.referencesProvider,
      "find-references",
      "referencesProvider",
    );
    const sync = this.syncDocument(filePath);
    return this.connection.sendRequest("textDocument/references", {
      textDocument: { uri: sync.uri },
      position: { line: line - 1, character },
      context: { includeDeclaration },
    });
  }

  async documentSymbols(filePath: string): Promise<unknown> {
    this.requireCapability(
      this.serverCapabilities.documentSymbolProvider,
      "document-symbol",
      "documentSymbolProvider",
    );
    const sync = this.syncDocument(filePath);
    return this.connection.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri: sync.uri },
    });
  }

  async workspaceSymbols(query: string): Promise<unknown> {
    this.requireCapability(
      this.serverCapabilities.workspaceSymbolProvider,
      "workspace-symbol",
      "workspaceSymbolProvider",
    );
    return this.connection.sendRequest("workspace/symbol", { query });
  }

  async diagnostics(filePath: string, signal?: AbortSignal): Promise<{ items: Diagnostic[] }> {
    const sync = this.syncDocument(filePath);
    const provider = this.serverCapabilities.diagnosticProvider;

    if (isCapabilityEnabled(provider)) {
      return this.pullDocumentDiagnostics(sync.uri, provider);
    }

    const current = this.pushDiagnostics.get(sync.uri);
    if (
      current
      && this.pushStateMatchesVersion(current, sync.version)
      && (!sync.changed || current.sequence > sync.diagnosticSequence)
    ) {
      return { items: current.items };
    }

    const published = await this.waitForPublishedDiagnostics(
      sync.uri,
      sync.version,
      sync.diagnosticSequence,
      signal,
    );
    return { items: published.items };
  }

  async prepareRename(filePath: string, line: number, character: number): Promise<unknown> {
    const provider = this.serverCapabilities.renameProvider;
    if (
      typeof provider !== "object"
      || provider === null
      || provider.prepareProvider !== true
    ) {
      throw new Error(
        `LSP server '${this.options.serverId}' does not advertise prepare-rename support (renameProvider.prepareProvider).`,
      );
    }

    const sync = this.syncDocument(filePath);
    return this.connection.sendRequest("textDocument/prepareRename", {
      textDocument: { uri: sync.uri },
      position: { line: line - 1, character },
    });
  }

  async rename(
    filePath: string,
    line: number,
    character: number,
    newName: string,
  ): Promise<unknown> {
    this.requireCapability(
      this.serverCapabilities.renameProvider,
      "rename",
      "renameProvider",
    );
    const sync = this.syncDocument(filePath);
    return this.connection.sendRequest("textDocument/rename", {
      textDocument: { uri: sync.uri },
      position: { line: line - 1, character },
      newName,
    });
  }

  private syncDocument(filePath: string): DocumentSyncState {
    const absPath = resolve(filePath);
    const uri = pathToFileURL(absPath).href;
    const text = readFileSync(absPath, "utf-8");
    const diagnosticSequence = this.pushDiagnostics.get(uri)?.sequence ?? 0;

    if (!this.openedFiles.has(absPath)) {
      const version = 1;
      this.connection.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: this.options.languageIdForPath(absPath),
          version,
          text,
        },
      });
      this.openedFiles.add(absPath);
      this.documentVersions.set(uri, version);
      this.lastSyncedText.set(uri, text);
      return { uri, version, changed: true, diagnosticSequence };
    }

    const previousText = this.lastSyncedText.get(uri);
    const currentVersion = this.documentVersions.get(uri) ?? 1;
    if (previousText === text) {
      return { uri, version: currentVersion, changed: false, diagnosticSequence };
    }

    const nextVersion = currentVersion + 1;
    this.documentVersions.set(uri, nextVersion);
    this.lastSyncedText.set(uri, text);

    this.connection.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: nextVersion },
      contentChanges: [{ text }],
    });
    this.connection.sendNotification("textDocument/didSave", {
      textDocument: { uri },
      text,
    });

    return { uri, version: nextVersion, changed: true, diagnosticSequence };
  }

  private async pullDocumentDiagnostics(
    uri: string,
    provider: DiagnosticProviderCapability,
  ): Promise<{ items: Diagnostic[] }> {
    const previous = this.pullDiagnostics.get(uri);
    const params: Record<string, unknown> = {
      textDocument: { uri },
    };

    if (typeof provider === "object" && provider !== null && typeof provider.identifier === "string") {
      params.identifier = provider.identifier;
    }
    if (previous?.resultId) {
      params.previousResultId = previous.resultId;
    }

    const result = await this.connection.sendRequest<
      FullDocumentDiagnosticReport | UnchangedDocumentDiagnosticReport
    >("textDocument/diagnostic", params);

    if (result?.kind === "unchanged") {
      if (!previous) {
        throw new Error("LSP server returned unchanged diagnostics without a previous result.");
      }
      if (result.resultId) previous.resultId = result.resultId;
      return { items: previous.items };
    }

    if (!result || !Array.isArray(result.items)) {
      throw new Error("LSP server returned an invalid textDocument/diagnostic result.");
    }

    const state: PullDiagnosticState = {
      ...(result.resultId ? { resultId: result.resultId } : {}),
      items: result.items,
    };
    this.pullDiagnostics.set(uri, state);
    return { items: state.items };
  }

  private handlePublishedDiagnostics(params: unknown): void {
    const value = params as {
      uri?: unknown;
      version?: unknown;
      diagnostics?: unknown;
    } | undefined;
    if (!value || typeof value.uri !== "string" || !Array.isArray(value.diagnostics)) return;

    const currentVersion = this.documentVersions.get(value.uri);
    const publishedVersion = typeof value.version === "number" ? value.version : undefined;
    if (
      publishedVersion !== undefined
      && currentVersion !== undefined
      && publishedVersion !== currentVersion
    ) {
      return;
    }

    const previous = this.pushDiagnostics.get(value.uri);
    const state: PushDiagnosticState = {
      sequence: (previous?.sequence ?? 0) + 1,
      ...(publishedVersion === undefined ? {} : { version: publishedVersion }),
      items: value.diagnostics as Diagnostic[],
    };
    this.pushDiagnostics.set(value.uri, state);
    this.resolveDiagnosticWaiters(value.uri, state);
  }

  private waitForPublishedDiagnostics(
    uri: string,
    version: number,
    afterSequence: number,
    signal?: AbortSignal,
  ): Promise<PushDiagnosticState> {
    const current = this.pushDiagnostics.get(uri);
    if (
      current
      && current.sequence > afterSequence
      && this.pushStateMatchesVersion(current, version)
    ) {
      return Promise.resolve(current);
    }

    if (signal?.aborted) {
      return Promise.reject(new Error("LSP diagnostics aborted"));
    }

    return new Promise<PushDiagnosticState>((resolvePromise, rejectPromise) => {
      const waiter: DiagnosticWaiter = {
        afterSequence,
        version,
        signal,
        resolve: resolvePromise,
        reject: rejectPromise,
      };

      waiter.timeout = setTimeout(() => {
        this.finishDiagnosticWaiter(
          uri,
          waiter,
          undefined,
          new Error(
            `LSP server '${this.options.serverId}' did not publish diagnostics for the current document version before the deadline.`,
          ),
        );
      }, this.options.pushDiagnosticsDeadlineMs ?? DEFAULT_PUSH_DIAGNOSTICS_DEADLINE_MS);

      if (signal) {
        waiter.abortListener = () => {
          this.finishDiagnosticWaiter(
            uri,
            waiter,
            undefined,
            new Error("LSP diagnostics aborted"),
          );
        };
        signal.addEventListener("abort", waiter.abortListener, { once: true });
      }

      const waiters = this.diagnosticWaiters.get(uri) ?? new Set<DiagnosticWaiter>();
      waiters.add(waiter);
      this.diagnosticWaiters.set(uri, waiters);

      const latest = this.pushDiagnostics.get(uri);
      if (
        latest
        && latest.sequence > afterSequence
        && this.pushStateMatchesVersion(latest, version)
      ) {
        this.finishDiagnosticWaiter(uri, waiter, latest);
      }
    });
  }

  private resolveDiagnosticWaiters(uri: string, state: PushDiagnosticState): void {
    const waiters = this.diagnosticWaiters.get(uri);
    if (!waiters) return;

    for (const waiter of [...waiters]) {
      if (
        state.sequence > waiter.afterSequence
        && this.pushStateMatchesVersion(state, waiter.version)
      ) {
        this.finishDiagnosticWaiter(uri, waiter, state);
      }
    }
  }

  private finishDiagnosticWaiter(
    uri: string,
    waiter: DiagnosticWaiter,
    state?: PushDiagnosticState,
    error?: Error,
  ): void {
    const waiters = this.diagnosticWaiters.get(uri);
    if (!waiters?.delete(waiter)) return;
    if (waiters.size === 0) this.diagnosticWaiters.delete(uri);

    if (waiter.timeout) clearTimeout(waiter.timeout);
    if (waiter.signal && waiter.abortListener) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
    }

    if (error) waiter.reject(error);
    else waiter.resolve(state!);
  }

  private rejectDiagnosticWaiters(error: Error): void {
    for (const [uri, waiters] of [...this.diagnosticWaiters]) {
      for (const waiter of [...waiters]) {
        this.finishDiagnosticWaiter(uri, waiter, undefined, error);
      }
    }
  }

  private pushStateMatchesVersion(state: PushDiagnosticState, version: number): boolean {
    return state.version === undefined || state.version === version;
  }

  private requireCapability(
    capability: ProviderCapability | RenameProviderCapability | undefined,
    feature: string,
    capabilityName: string,
  ): void {
    if (isCapabilityEnabled(capability)) return;
    throw new Error(
      `LSP server '${this.options.serverId}' does not advertise ${feature} support (${capabilityName}).`,
    );
  }
}
