---
summary: "Defines workspace-oriented tool activity, authoritative activity presence, durable observability state, read models, live delivery, and client boundaries."
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

Activity answers:

> Which working directories are agents operating in, what are they doing there now, and is a particular Shell still active?

The overview groups calls by Shell root `cwd`, because that is the useful project-level identity for an operator. A Shell remains a distinct durable execution context identified by `shell_id`; multiple Shells with one `cwd` are grouped only in the read model.

No durable Workspace entity is introduced.

## Identity Rules

- `ShellStore` is authoritative for Shell existence, `shell_id -> cwd`, and creation time.
- Workspace identity is the normalized absolute `cwd` already stored by `ShellStore`.
- Activity code does not add `realpath()` canonicalization or otherwise redefine Shell identity.
- Multiple Shells may share one `cwd` and remain distinct.
- A Shell root remains stable even if one command changes its child-process working directory.
- `create_shell` can publish its requested `cwd` before a resulting `shell_id` exists.
- `client_name` is the MCP client's declared `initialize.clientInfo.name` for the transport. `client_session_id` is a separate optional, namespaced logical-session hint extracted by the MCP request boundary; neither changes Shell identity or represents authorization.
- The OpenAI-specific adapter prefers valid `params._meta["openai/session"]` and falls back to valid `x-openai-session` when metadata is absent or invalid. Both use the same `openai:<opaque value>` namespace; no schema or historical ID rewrite is required. A 2026-10-08 one-request raw-value probe confirmed byte-for-byte equality for both sources, and the preceding Journal diagnostic found a consistent one-to-one grouping over 670 paired requests. These observations do not guarantee future vendor behavior: if both valid sources disagree, metadata wins and one value-free warning per process is emitted. Missing/invalid hints or ambiguous batches leave the logical-session field null. The existing `session` remains the MCP transport session ID. No vendor-specific rules belong in the generic resolver, tool implementations, or observability persistence.
- Client session hints are untrusted and stored verbatim, with no guarantee of cross-client or cross-version stability. They are strictly observational and may be sensitive. `Tool Logs Contain Sensitive Payloads` and `Client-Declared Logical Sessions Are Linkable and Unverified` in the [current architecture risks](../11-risks-and-technical-debt/current-architecture-risks.md) govern residual exposure; never use hints as an authorization boundary.

## Client-Session Usage Relationships

The installation treats `clientInfo.name` as the unique client identity. Logical-session identity is the composite `(client_id, client_session_id)`, where `client_id` is that name and `client_session_id` retains its adapter namespace. The same session string declared by different clients names different sessions.

`session_shells` records many-to-many usage with the primary key `(client_id, client_session_id, shell_id)` and a reverse index beginning with `shell_id`. Relationships persist independently of complete-call retention and the five-minute active window. A valid Shell invocation establishes membership before executing; successful `create_shell` establishes it when the created ID becomes available. Failed operations on valid Shells count as activity. Calls with no resolved Shell, including unknown-ID failures, do not establish membership or affect session presence.

Session activity is derived from the activity of its member Shells. The Shell-to-session point query takes the union of member Shells belonging to the requested Shell's directly associated sessions. An indexed join deduplicates shared members, and live running calls overlay durable completion times. This is a one-way aggregation: session activity never changes a Shell's own activity, and sessions are not recursively merged through shared Shells. The response exposes one aggregate boolean and deadline without an unbounded membership listing.

## Activity Policy

`src/observability/activity-policy.ts` is the single authority for active presence.

A Shell or workspace is active when:

- it owns at least one running call; or
- with no running calls, the current server time is earlier than five minutes after its latest lifecycle event.

The exact deadline is inactive. For a completed call the five-minute window begins at `finished_at`, not `started_at`. A long-running call therefore remains active for its entire run and receives a fresh five-minute window when it finishes.

The API exposes `active`, `active_until`, `server_time`, and `active_window_ms`. Clients may use the returned deadline to refresh presentation locally, but they do not reproduce the five-minute rule.

## Tool-Call Lifecycle

`ToolCallRecorder` is the single control point for recorded invocation lifecycle:

1. assign call ID and start time, and snapshot the request's client identity;
2. derive a bounded, tool-agnostic input preview;
3. register valid Shell work and its usage relationship with `ActivityService`, then publish the running call to `ActivityTracker`;
4. execute the original tool operation;
5. construct the final success/error record with complete input;
6. synchronously update authoritative Shell completion state and the live projection, independently of full payload persistence;
7. ask `ObservabilityStore` to persist the completed record and preview, then publish the finished event with settled payload availability; and
8. preserve the original tool result or original tool error.

Input-preview construction is mechanical rather than semantic: it bounds string length, collection width, and nesting depth without knowing tool names or argument names.

Observability is best-effort relative to host-tool semantics. Persistence or activity-publication failure must not convert a successful host operation into a failed tool call and must not replace the original tool error.

`ActivityService` owns the authoritative running-call IDs, a Shell-to-running-call index, and Shell/session point queries. Completion synchronously commits usage plus the monotonic latest completion time before removing running state; no query can observe a gap between those transitions. The live projection also advances before asynchronous payload writes, while the finished SSE event waits for payload availability to settle. A state read/write failure is diagnosed once and latches `activity_unavailable` for this process: a later successful write cannot prove that previously lost relationships were recovered. Activity JSON reads and new streams return `503`; existing streams close when serialization detects the failure. History and original tool outcomes remain independent.

The projection tracks calls awaiting full history separately from host execution. Call-detail reads retain `409 tool_call_running` until history persistence settles, including when an early completed summary has already appeared in a snapshot; pending payloads are not mistaken for permanently unavailable detail.

## Shell-Aware Invocation

`src/tools/invoke.ts` is the shared invocation boundary for Shell-aware tools. It resolves `shell_id` through `ShellStore`, obtains the Shell root, and supplies that identity to `ToolCallRecorder` before invoking tool-specific behavior.

Basic file/shell tools, patching, image inspection, and LSP tools do not independently reimplement Shell resolution plus activity recording.

Unknown `shell_id` failures remain observable calls: the requested ID is known while resolved `cwd` is absent.

`create_shell` uses the general recorder rather than Shell-aware invocation. Its requested `cwd` is available while running; after success the completed call carries the created `shell_id`.

## ObservabilityStore

`ObservabilityStore` owns one SQLite metadata database plus sharded payload files under `TOOL_LOG_DIR`.

It has three persistence lifecycles sharing the same database.

### Complete Call History

Count-retained completed calls use:

- compact SQLite metadata in `history.db`;
- date-sharded gzip payloads under `payloads/YYYY/MM/DD/`;
- atomic payload publication before metadata visibility;
- indexed Shell-history pagination and recent-summary reads;
- bounded input previews in metadata;
- nullable client identity columns in the indexed history summary and matching fields in the full gzip payload; and
- full payload lookup by call ID.

Metadata and payload retire together under `TOOL_LOG_MAX_CALLS`.

### Latest Shell Activity

`history.db` also stores one compact `shell_activity` row per observed Shell:

- `shell_id`;
- `cwd`; and
- latest completed lifecycle-event time.

This row is updated through the independent synchronous activity-write path, in the same transaction as the completed call's usage relationship, before full payload persistence. It is **not** retired with complete-call retention. Its purpose is semantic continuity of Shell activity across history eviction and process restart, not history caching. Clearing `history.db` or `TOOL_LOG_DIR` removes historical calls, durable Shell activity, and usage relationships; retention-based call eviction does not.

Running-call counts are deliberately not persisted. A process restart terminates process-local running work, so restored running count is zero.

Schema v1 history upgrades to this projection by backfilling the latest retained completed event per Shell. Legacy gzip import also backfills imported Shell activity once. Normal startup does not rescan complete retained history for Shell activity.

Schema v3 adds nullable `client_name` and `client_session_id` columns to retained call metadata. Existing v1/v2 history is migrated in place; older gzip payloads are not rewritten, and API detail reads normalize absent identity fields to `null`.

### Persistent Session Membership

Schema v4 adds `session_shells` and atomically backfills client-scoped membership from retained calls with a resolved Shell and both identity fields. This occurs before startup retention removes calls; legacy imports also preserve identity and backfill membership. Normal startup does not scan history for membership. Evicted or unidentified older relationships cannot be recovered. Database/activity initialization is separate from payload setup and legacy import, so history initialization failure can leave a usable activity database.

## ActivityTracker

`ActivityTracker` owns process-local live state:

- currently running calls;
- bounded recent completed-call summaries;
- bounded per-workspace recent-call summaries;
- per-workspace latest lifecycle time;
- per-Shell active-window presence and running-call count; and
- connected SSE subscriber queues.

Per-Shell presence is independent from recent-call retention. It is retained while the Shell has running work or remains inside the backend active window, then pruned. High call volume can therefore evict recent call cards without making an otherwise active Shell disappear.

The complete-call live/recent window remains independently bounded at 10,000 completed calls even when durable payload retention is much larger.

At startup, the tracker receives:

1. the bounded recent-call summaries needed for live/recent presentation; and
2. durable Shell activity rows still inside the active window.

Durable retention depth therefore does not determine active-presence correctness or startup memory.

## Authority Composition

`ObservabilityQuery` is the single cross-authority read-model composer.

Its inputs have distinct ownership:

- `ShellStore` -> Shell existence, `cwd`, creation time, workspace Shell enumeration;
- `ActivityService` -> authoritative running Shell work and Shell/session point activity;
- `ActivityTracker` -> bounded live/recent call projection, workspace presence, and subscribers;
- `ObservabilityStore` -> durable latest completed Shell event, persistent usage relationships, retained completed history, full retained call payload;
- `activity-policy.ts` -> active/deadline semantics.

HTTP handlers do not recreate cross-store rules.

Shell and session point reads use `ActivityService`, combining durable completion times with its process-local running-call index. Each query captures one server time and applies the shared activity policy; a restart restores no running calls. Projection history bounds do not limit point-query correctness.

## Versioned HTTP Surface

The first-class read-only API lives under `/api/v1/*`:

    GET /api/v1/activity
    GET /api/v1/activity/stream
    GET /api/v1/shells?cwd=...
    GET /api/v1/shells/:shell_id/activity
    GET /api/v1/shells/:shell_id/session-activity
    GET /api/v1/shells/:shell_id/calls
    GET /api/v1/tool-calls/:call_id

`GET /api/v1/activity` supports polling. The SSE endpoint sends the same bounded current snapshot, then `tool_call.started` and `tool_call.finished` events.

Live events include the call plus server-derived workspace/Shell presence at publication time. Full tool input/output is never placed in the live feed by default.

`GET /api/v1/shells/:shell_id/activity` is the authoritative point query for Shell presence. Unknown durable Shell IDs return `404 shell_not_found`.

`GET /api/v1/shells/:shell_id/session-activity` returns `shell_id`, aggregate `active`, `active_until`, and `server_time`. Running work on any member yields no fixed deadline; otherwise the maximum member deadline applies, with the exact deadline inactive. A known Shell with no recorded membership returns false and a null deadline. Invalid IDs return `400 invalid_request`; unknown Shells return `404 shell_not_found`. Both point queries report unavailable activity state with `503 activity_unavailable` rather than an incomplete inactive answer.

Pagination cursors are opaque transport values. Consumers may persist and return a cursor but must not decode it as a Shell ID, call ID, sequence, timestamp, or storage key.

The API boundary and compatibility rules are governed by the Observability API Boundary ADR.

## Snapshot-to-Live Consistency

Opening a live feed is atomic with respect to the in-process projection:

1. register a bounded subscriber queue;
2. capture the current snapshot synchronously;
3. send the snapshot;
4. drain events queued after snapshot capture; and
5. continue live delivery.

This avoids the snapshot/live race without durable event replay or `Last-Event-ID`.

Each subscriber queue is bounded. A client that cannot drain its queue loses that stream instead of creating unbounded server memory. Reconnection obtains a fresh snapshot.

## Browser State and Ordering

The browser owns only presentation ordering.

It maintains two groups:

- ACTIVE: server-derived presence is still active;
- EARLIER: otherwise.

Repeated calls inside ACTIVE update content without moving the workspace. Promotion from EARLIER moves a workspace to the front of ACTIVE. The connection/reconnection snapshot establishes the browser's server-clock offset; delayed live events do not recalibrate that clock. A local timer compares server-provided `active_until` with that server-adjusted time so idle SSE connections still visually expire on time.

The timer is a rendering mechanism, not an independent five-minute business rule.

The Activity overview remains a dense workspace wall. Each workspace card shows at most five current-and-recent calls. Running calls are protected first; remaining slots use most recently completed calls. Shell identity stays row metadata rather than a grouping level.

The browser attaches an ephemeral update revision to each live call. Snapshot calls begin at revision zero; subsequent lifecycle events increment the affected call revision. This signal is presentation-only and is neither persisted nor derived from wall-clock freshness.

## Browser Implementation Boundary

The Web Console is a React + TypeScript SPA built by Vite:

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

`api.ts` consumes `/api/v1/*`. `activity-model.ts` owns stable two-tier ordering and event merge rules without React dependencies. `ActivityProvider` owns the long-lived SSE connection while navigation changes.

TanStack Query owns historical reads. A completed SSE event invalidates affected Shell-history/workspace-Shell queries so the browser rereads authoritative history rather than reimplementing durable insertion or pagination.

Shell detail composes paginated completed history with the bounded live-call overlay. It merges by call ID: running/live-only calls come from the Activity projection; once durable history contains the completed call, history fields become authoritative while the ephemeral live revision may remain.

The live call overlay is still bounded by the per-workspace recent-call projection. It does not claim to enumerate arbitrarily many simultaneous call rows after reconnect; this is distinct from Shell **active presence**, which is now lifecycle-complete inside its active window.

Tool inputs, outputs, errors, previews, and repository-controlled text are rendered as text rather than executable markup.

## Access Boundary

One listener carries three distinct authorities:

    /mcp        -> remote OAuth or local profile       -> full MCP/host authority
    /console/*  -> WEB_PASSWORD HTTP Basic            -> read-only Web Console
    /api/v1/*   -> read-only observability authority  -> read-only API

In remote mode the API accepts `OBSERVABILITY_TOKEN` Bearer credentials and, when configured, the same `WEB_PASSWORD` Basic credential used by the Web Console. It is absent when neither read credential exists.

In local mode `/api/v1/*` is available on the loopback-only listener without another credential, matching the stronger local placement invariant already trusted for unauthenticated `/mcp`.

Neither read credential authorizes `/mcp`. MCP bearer tokens are not exposed to browser code.

Remote Basic/Bearer read access requires HTTPS at the ingress. API responses and the SPA HTML shell use `Cache-Control: no-store`; content-hashed Web assets may be cached immutably. Cross-origin API access is not enabled.

Any future API or browser mutation requires explicit security reassessment rather than inheriting this read-only authority.

## Source Organization

    src/
      api/
        observability-auth.ts
        v1/
          router.ts
      contracts/
        observability.ts
      observability/
        activity-policy.ts
        activity-service.ts
        activity-tracker.ts
        observability-query.ts
        observability-store.ts
        tool-call.ts
        tool-call-recorder.ts
        legacy-tool-log-import.ts
      http/
        app.ts
        web-auth.ts
        web-ui-routes.ts

No generic repository/service/adapter hierarchy is introduced. Each module corresponds to an observed ownership boundary.

## Deliberate Non-Goals

The current design does not introduce:

- WebSocket transport;
- durable event replay;
- a durable Workspace entity;
- an external database service or independent history worker;
- server-side activity scores;
- API mutation;
- multi-user RBAC;
- GraphQL or generated SDKs;
- a separate API process or listener;
- configurable per-client activity windows;
- SSR or a full-stack React framework;
- independently deployed frontend services; or
- analytics dashboards.

These remain reassessment points rather than abstractions to build in advance.
