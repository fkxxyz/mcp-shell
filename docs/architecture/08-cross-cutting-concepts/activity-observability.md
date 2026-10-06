---
summary: "Defines workspace-oriented tool activity, observability ownership, read models, live delivery, and browser UI boundaries."
viewpoint: static
stakeholders:
  - architect
  - developer
  - operator
concerns:
  - architecture-coherence
  - correctness
  - maintainability
  - operability
  - security
activities:
  - orient
  - change
  - diagnose
  - operate
  - assess
facets:
  domain:
    - observability
    - access-and-transport
    - host-tools
    - whole-system
---

# Activity Observability

## User Model

The activity surface answers one primary question:

> Which working directories are agents operating in, and what are they doing there now?

The user-facing grouping key is a Shell root cwd, not shell_id. A Shell remains a distinct durable execution context; multiple Shells rooted at the same cwd are grouped as one workspace in the activity read model.

This grouping is a projection only. It does not introduce a durable Workspace entity.

## Identity Rules

- ShellStore is authoritative for shell_id -> cwd.
- Workspace identity is the normalized absolute cwd already stored by ShellStore.
- Activity code does not add realpath() canonicalization or otherwise change Shell identity semantics.
- Multiple Shells may share one cwd and remain distinct.
- A Shell root is stable even if one command changes its own process working directory.
- create_shell knows its requested cwd before a resulting shell_id exists, so activity metadata permits shell_id to be absent while cwd is known.

## Tool-Call Lifecycle

ToolCallRecorder is the single control point for recorded tool invocation lifecycle:

1. assign call ID and start time;
2. derive a bounded, tool-agnostic input preview for live activity;
3. publish the running call to ActivityTracker;
4. execute the original tool operation;
5. construct the final success or error record with the complete input;
6. ask ToolHistoryStore to persist the completed record and bounded input preview;
7. publish the completed state to ActivityTracker; and
8. preserve the original tool result or original tool error.

Input-preview construction is mechanical rather than semantic: it bounds string length, collection width, and nesting depth without knowing tool names or argument names. Preview failure is observability failure and must not alter tool semantics.

Observability is best-effort with respect to host-tool semantics. Logging or activity publication failure must not convert a successful host operation into a failed tool call, and must not replace the original tool error.

## Shell-Aware Invocation

src/tools/invoke.ts is the shared invocation boundary for Shell-aware tools. It resolves the requested shell_id through ShellStore, obtains the Shell root, and supplies that identity to ToolCallRecorder before invoking tool-specific behavior.

Basic file/shell tools, patching, image inspection, and LSP tools do not independently reimplement Shell resolution plus activity recording.

Unknown shell_id failures remain observable calls: the requested Shell ID is known while resolved cwd is absent.

create_shell uses the general recorder rather than Shell-aware invocation. Its requested cwd is available while running; after success the completed call may also include the created shell_id.

## ToolHistoryStore

ToolHistoryStore is the durable authority for completed tool-call history. It owns:

- compact SQLite metadata in `history.db`;
- date-sharded gzip payload files under `payloads/YYYY/MM/DD/`;
- atomic payload publication before metadata visibility;
- count-bounded retention of complete call history;
- indexed Shell-history pagination and recent-summary reads;
- full payload retrieval by call ID; and
- one-way import of the legacy `index.jsonl` plus `calls/*.json.gz` representation.

Completed records are durable evidence. Running calls are not persisted merely for the UI, avoiding recovery semantics for orphaned running records after process termination.

SQLite metadata stores identity, chronology, Shell/workspace identity, status, stored size, payload location, and the bounded input preview. Full input, output, and serialized errors remain in gzip payloads and are fetched only when a specific call is opened. Metadata and payload retire together under `TOOL_LOG_MAX_CALLS`, so preview lifetime cannot exceed the retained complete call.

Payload bytes stay on asynchronous filesystem I/O rather than becoming synchronous `node:sqlite` BLOB writes. The SQLite index supplies durable ordering and lookup without loading retained filenames into memory or enumerating payload directories during normal startup. Metadata uses SQLite WAL mode with `synchronous=NORMAL`: tool history remains transactionally consistent, while the newest history may be lost on sudden host power loss because observability is explicitly best-effort relative to host actions.

Legacy import preserves only retained payload-backed calls. Historical metadata whose payload was already removed by the old retention model is intentionally not promoted into the new durable authority. Malformed legacy payloads are moved to `legacy-rejected/` so a bad source record is diagnosed once and no longer prevents migration convergence on later restarts.

## Bounded Startup and Runtime State

Durable retention depth must not determine live-activity memory. ToolHistoryStore opens the indexed metadata store, converges retained count if configuration decreased, and reads only the bounded recent summaries needed for Activity bootstrap.

The in-memory activity-history window is independently capped at 10,000 completed calls, even when `TOOL_LOG_MAX_CALLS` is configured much higher for payload retention. Raising durable payload retention therefore does not proportionally increase activity bootstrap time or steady-state activity memory.

Legacy source corruption is quarantined and diagnosed without making valid retained history unreadable. Infrastructure/storage failures do not quarantine otherwise valid history; they fail initialization so the process enters a degraded history state. That same process does not repeatedly rerun initialization or migration on each tool completion, and continuous persistence failure is reported once until recovery. Observability remains subordinate to host-tool availability.

ActivityTracker owns only bounded in-process state:

- currently running calls;
- recent completed summaries;
- per-workspace recent summaries;
- per-workspace latest lifecycle-event time; and
- connected live-feed subscribers.

Activity snapshots derive per-Shell recent activity facts from the same bounded completed-call history plus current running calls. This supporting projection carries `shell_id`, latest lifecycle time, and running-call count so the browser can calculate active-Shell counts without querying the durable Shell inventory or introducing a second mutable activity authority.

Completed-call retirement is one lifecycle inside the live projection: when a call leaves the bounded global recent window it also leaves any workspace recent-call projection, and a workspace with neither running nor retained recent calls is removed. Durable completed history may remain queryable long after that live/recent projection has forgotten the call.

It does not read gzip payloads, enumerate Shells, persist workspace state, or decide visual ranking tiers.

## Query Composition

ActivityQuery composes read models from ActivityTracker, ShellStore, and ToolHistoryStore.

ShellStore remains authoritative for Shell existence and provides bounded cwd -> Shells queries needed by the UI. ToolHistoryStore is authoritative for retained completed-call history and latest retained Shell activity. ActivityTracker is authoritative only for running/recent in-process lifecycle state. Tool history is not used to infer the complete Shell inventory.

HTTP handlers delegate read-model assembly to ActivityQuery; they do not accumulate cross-store query logic.

## HTTP Surface

Activity is one feature inside the Web Console rather than the owner of the browser namespace. Its browser-facing endpoints are:

    /api/activity/stream
    /api/shells?cwd=...
    /api/shells/:shell_id/calls
    /api/tool-calls/:call_id

The SPA itself lives under `/console/*`.

The API is read-only. It does not expose tool execution, rerun, Shell close, log deletion, settings mutation, ranking, analytics, or workspace CRUD.

Pagination cursors are opaque transport values. Browser code may persist and return a cursor but must not interpret it as a Shell ID, call ID, sequence, timestamp, or storage key.

The live endpoint uses Server-Sent Events because delivery is server-to-browser only. A connection receives:

1. a bounded current snapshot;
2. tool_call.started events; and
3. tool_call.finished events.

Summary events contain identity, lifecycle timestamps, status, payload availability, and an optional bounded input preview. They never contain complete tool inputs or outputs.

Snapshot workspace summaries also include `recent_shells`, a bounded supporting activity projection rather than complete Shell inventory. `/api/shells?cwd=...` remains authoritative for enumerating durable Shells belonging to a workspace.

## Snapshot-to-Live Consistency

Opening a live feed is atomic with respect to the in-process projection:

1. register a bounded subscriber queue;
2. capture the current snapshot synchronously;
3. send the snapshot;
4. drain events queued after snapshot capture; and
5. continue live delivery.

This avoids the snapshot/live race without introducing durable event replay or Last-Event-ID.

Each subscriber queue is bounded. If a client cannot consume events fast enough, the stream is closed rather than allowing unbounded server memory growth. Reconnection obtains a fresh snapshot.

## Browser State and Ordering

The framework-independent Activity model owns presentation policy. It maintains exactly two groups:

- ACTIVE: a workspace has a running call, or its latest lifecycle event is less than ten minutes old;
- EARLIER: otherwise.

Repeated calls within ACTIVE update content without reordering the workspace. A workspace promoted from EARLIER enters the front of ACTIVE. A local expiry timer demotes inactive workspaces even when no new server event arrives.

A Shell is active under the same ten-minute lifecycle rule, or while it owns a running call. The Activity model derives active-workspace, active-Shell, and running-call summary counts from these facts; the backend does not persist or rank those presentation states.

The Activity overview is a dense workspace wall rather than a Shell-grouped feed. Each workspace card shows at most five current-and-recent calls. Running calls are protected first, ordered by start time; the remaining slots use most recently completed calls. Shell identity is row metadata rather than a grouping level, preserving one readable activity trajectory per workspace. EARLIER workspaces use the same card representation behind a collapsed section by default.

The browser also attaches an ephemeral update revision to each call in the live projection. Calls received in an SSE snapshot establish a quiet baseline at revision zero; each subsequent `tool_call.started` or `tool_call.finished` event increments the affected call revision. The revision exists only to identify a live lifecycle update for presentation and is neither persisted nor derived from wall-clock freshness.

The ten-minute threshold, ACTIVE/EARLIER state, stable ordering, update revision, and visual rank are not persisted backend state.

## Browser Implementation Boundary

The Web Console is a React + TypeScript SPA built by Vite. Activity remains feature-local:

    web/
      index.html
      src/
        app/
        routes/
        features/
          activity/
            api.ts
            activity-model.ts
            ActivityProvider.tsx
            components/
        lib/
        styles/

`activity-model.ts` owns the two-tier ordering and event-merge rules without React dependencies. `ActivityProvider` owns the long-lived SSE connection and exposes model state to the application. The connection remains active while navigating to Shell or tool-call detail routes.

TanStack Query owns bounded historical reads. A completed SSE event invalidates the affected Shell-history query and workspace-Shell query; the browser then rereads authoritative history instead of reproducing backend insertion/pagination rules inside the cache.

Shell detail composes two projections without changing either authority: paginated `/api/shells/:shell_id/calls` supplies completed history, while the bounded Activity model supplies current live calls for that Shell. The browser merges them by call ID: running/live-only calls come from the Activity projection; once completed history contains the same call, its data fields become authoritative while the live update revision may remain as a transient presentation signal. Running calls remain outside the paginated completed-history contract, so transient lifecycle state cannot change cursor semantics. History loading or failure does not hide already-known live calls. The live Shell overlay is intentionally bounded by the same recent-call Activity projection available in the SSE snapshot; it does not claim to enumerate every concurrently running call under arbitrarily high workspace fan-out.

Shell and tool-call detail use addressable routes so refresh, browser back/forward, and copied links preserve user context. State with the same user expectation should prefer route/search state over hidden component state.

The browser owns invocation presentation. A feature-local pure formatter orders preview arguments by a single global importance policy, keeps unknown arguments visible after known arguments, renders calls as `tool_name(arg=value, ...)`, and collapses structured values before CSS applies final single-line ellipsis. The backend does not know argument importance or construct presentation labels. Activity cards and Shell history share this formatter and one status indicator: running calls use motion/shape to distinguish in-progress work, successful calls use a success marker, and failed calls use a distinct error marker. Live update emphasis is driven by the ephemeral update revision rather than DOM mount timing or timestamp heuristics. Reduced-motion preferences suppress nonessential animation while preserving status shape and color.

Tool inputs, outputs, errors, previews, and repository-controlled text are rendered through React text nodes. Untrusted tool content must not be interpreted as executable markup.

## Access and Browser Security

The existing remote service continues to use one listener and one public origin. Authentication is separated by path and authority:

    /mcp        -> existing OAuth/local profile -> full MCP/host authority
    /console/*  -> HTTP Basic Auth             -> read-only Web Console
    /api/*      -> HTTP Basic Auth             -> read-only browser API

The credential types are not interchangeable. Web Basic credentials are never accepted by `/mcp`; the browser does not need or receive an MCP bearer token.

The Web Basic password is configured independently through `WEB_PASSWORD`; the Basic username remains fixed as `activity` rather than adding another configuration surface. If `WEB_PASSWORD` is absent, both `/console/*` and `/api/*` are not mounted. This makes browser exposure opt-in and fail-closed.

Brute-force protection and public-edge rate limiting are deployment concerns owned by the upstream ingress rather than application-local state.

Because HTTP Basic credentials are replayable credentials, remote Web Console access requires HTTPS at the public ingress.

All `/console/*` and `/api/*` resources sit behind the same Basic Auth middleware. API responses and the SPA HTML shell use `Cache-Control: no-store`; Vite content-hashed assets under `/console/assets/*` use immutable long-term caching. Cross-origin API access is not enabled.

The UI uses a restrictive Content Security Policy appropriate for same-origin static assets and SSE, including no object embedding, no framing, and no interpretation of tool output as executable markup.

The current Web authority is read-only. Adding any browser mutation is an explicit security reassessment point rather than an extension of this Activity design.

## Target Source Organization

    src/
      shell.ts
      shell-store.ts
      tools/
        invoke.ts
        ...
      observability/
        tool-call.ts
        tool-call-recorder.ts
        tool-history-store.ts
        legacy-tool-log-import.ts
        activity-tracker.ts
        activity-query.ts
      http/
        app.ts
        activity-routes.ts
        web-auth.ts
        web-ui-routes.ts
      contracts/
        activity.ts

    web/
      index.html
      vite.config.ts
      src/
        app/
        routes/
        features/activity/
        lib/
        styles/

No generic repository/service/adapter hierarchy is introduced. Each module corresponds to a concrete ownership boundary.

## Deliberate Non-Goals

The current implementation does not introduce:

- WebSocket transport;
- durable event replay;
- a second workspace database;
- an external database service or independent history worker;
- server-side activity scores or tiers;
- SSR or a full-stack React framework;
- independently deployed frontend services;
- global Redux/Zustand-style client state;
- API versioning without an independently evolving consumer;
- application-local brute-force state; or
- analytics dashboards.

These remain reassessment points rather than abstractions to build in advance.
