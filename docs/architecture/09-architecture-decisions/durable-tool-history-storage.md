---
summary: "Records durable completed tool history as SQLite-indexed metadata plus sharded gzip payloads, separate from bounded live Activity state."
viewpoint: decision
stakeholders:
  - architect
  - developer
  - operator
concerns:
  - architecture-coherence
  - correctness
  - operability
  - maintainability
  - rationale
activities:
  - orient
  - change
  - assess
  - decide
facets:
  domain:
    - observability
    - whole-system
---

# Durable Tool History Storage

## Decision State

Accepted and implemented architecture decision.

## Context

Tool-call observability originally stored one gzip payload per completed call under a single `calls/` directory and appended lightweight metadata to `index.jsonl`. Payload retention was bounded by `TOOL_LOG_MAX_CALLS`, while metadata remained append-only.

That representation had three coupled problems once legitimate retention increased toward one million calls:

- retention inventory lived in process memory and oldest-first eviction scanned the retained filename set;
- a single payload directory accumulated every retained file; and
- durable payload depth exceeded the bounded `ActivityTracker` history used by Shell-history APIs, so retained calls older than the live/recent projection were not normally discoverable.

The project already depends on Node's built-in SQLite implementation for durable Shell state. Full tool payloads, however, may be much larger than metadata and are written from the same single Node process. Storing all compressed payload bytes through synchronous SQLite calls would unnecessarily put large I/O on the event loop.

## Decision

Completed tool history has one durable authority: `ToolHistoryStore`.

`ToolHistoryStore` uses two coordinated representations under `TOOL_LOG_DIR`:

- `history.db`: SQLite metadata, ordering, Shell-history query indexes, retention inventory, and bounded input previews; and
- `payloads/YYYY/MM/DD/<call-id>.json.gz`: complete compressed call records.

`ActivityTracker` remains an independent bounded in-memory projection for running and recent activity. It does not provide durable Shell-history pagination.

`TOOL_LOG_MAX_CALLS=N` means at most N complete completed-call history records are retained. Metadata and payload share the same retention lifetime.

Retention order follows invocation start order using `started_at_ms`, process-local `sequence`, and call `id` as a deterministic tie-breaker. SQLite indexes provide oldest-first retention and Shell-scoped newest-first pagination without scanning retained payload files or loading complete history into memory.

Input previews are stored with metadata. Because metadata and payload now retire together, preview lifetime cannot exceed the complete retained record's policy.

## Persistence and Failure Semantics

Payload publication precedes metadata visibility:

1. gzip the complete call record;
2. write a temporary payload in its final shard;
3. atomically rename the payload into place;
4. publish metadata and apply retention in one SQLite transaction; and
5. remove payload files whose metadata was retired.

This ordering prefers user-visible consistency over perfect garbage collection. A failure before metadata commit may leave an invisible orphan payload, and a payload unlink failure after metadata retirement may do the same. Normal operation does not publish metadata that intentionally points to a missing payload.

`history.db` uses SQLite WAL mode with `synchronous=NORMAL`. Tool history is explicitly best-effort observability rather than host-action durability: the database remains transactionally consistent, while a sudden host power loss may lose the newest committed history that has not reached stable storage. This avoids imposing a synchronous durable fsync on every completed host action.

Measured evidence motivated the choice. With one million retained metadata rows, the default DELETE/FULL transaction path added about 21 ms median and 25 ms p95 to a real `ToolHistoryStore.persist()` workload. Isolating the same metadata transaction showed DELETE/FULL at about 17.9 ms median, WAL/FULL at about 6.0 ms, and WAL/NORMAL at about 0.04 ms. A post-change real-store run at 100,000 retained rows measured about 0.46 ms median and 0.86 ms p95; the host lacked enough free disk for a second safe one-million-row run.

Logging remains best-effort relative to host-tool semantics. Persistence failure is diagnosed but cannot replace a successful host action or the original tool error. If initialization fails, that process keeps the history store in a degraded state and subsequent writes fail fast rather than repeatedly rerunning initialization or legacy migration; a process restart is the retry boundary.

## Query Ownership

Durable and live queries have separate authorities:

- Activity snapshot and SSE lifecycle events -> `ActivityTracker`;
- completed Shell history and pagination -> `ToolHistoryStore`;
- completed call detail -> `ToolHistoryStore`;
- running-call detail state -> `ActivityTracker` before durable lookup;
- Shell inventory -> `ShellStore`.

Browser pagination cursors remain opaque. Their current durable position encodes the history ordering tuple rather than depending on a call remaining in the bounded Activity projection.

## Startup and Shutdown

Startup opens and validates the history schema, imports legacy retained gzip payloads when present, converges retention to the configured count, and reads only the bounded recent summaries needed to bootstrap `ActivityTracker`.

Legacy import is one-way and idempotent. Retained legacy payloads are moved into the new sharded layout and indexed; old metadata-only entries whose payloads were already retired are not preserved. Malformed legacy payloads are moved once to `legacy-rejected/` with a diagnostic so they remain inspectable without blocking migration convergence on every restart. Migration reports bounded progress and has no permanent dual-read compatibility path.

Application shutdown closes `ToolHistoryStore` after admitted tool invocations and requests drain. No external database service, worker, or deployment unit is introduced.

## Alternatives Rejected

### Keep `index.jsonl` and optimize the in-memory filename set

Rejected because it would improve eviction while preserving independent metadata/payload lifetimes, single-directory filesystem scaling, and the mismatch between retained depth and queryable history.

### Store complete compressed payloads as SQLite BLOBs

Rejected as the default because mcp-shell uses synchronous `node:sqlite` in the application process. Metadata operations are small and indexed; large payload reads and writes remain asynchronous filesystem I/O.

### Introduce a database package or external database service

Rejected because Node's built-in SQLite plus the existing local filesystem satisfies the single-host, single-process requirements without another dependency or deployment component.

### Add byte-based retention now

Rejected because current operator intent is expressed as retained call count. Byte limits would introduce a second product policy without evidence that count-based retention is insufficient.

## Consequences

Positive consequences:

- retained history is actually queryable to the configured depth;
- steady-state oldest selection is indexed rather than O(N);
- startup no longer enumerates every retained payload file;
- payload directories are naturally bounded by date shards;
- metadata cannot grow independently for the lifetime of the installation; and
- restart-restored Activity summaries retain bounded argument previews.

Accepted costs:

- metadata and payload are stored in two media that cannot share one atomic transaction;
- rare failure paths may leave invisible orphan payload files;
- WAL/NORMAL may lose the newest tool-history transactions on sudden host power loss while preserving database consistency; and
- SQLite schema evolution becomes an explicit ToolHistoryStore responsibility.

## Reassessment

Reassess this decision if:

- measured SQLite metadata operations become material event-loop latency;
- payload orphan accumulation becomes operationally significant;
- count-based retention no longer bounds operator disk requirements;
- multi-process writers become a supported topology; or
- history queries require dimensions that no longer fit the compact metadata model.
