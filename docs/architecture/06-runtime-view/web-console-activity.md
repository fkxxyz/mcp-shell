---
summary: "Describes Web Console Activity loading, live tool-call projection, detail reads, reconnect behavior, and failure isolation."
viewpoint: dynamic
stakeholders:
  - architect
  - developer
  - operator
concerns:
  - correctness
  - security
  - operability
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
---

# Web Console Activity Runtime

## Browser Entry

1. The browser requests `/console/` over the same public HTTPS origin and listener used by mcp-shell.
2. The Web Basic Auth middleware challenges missing or invalid credentials.
3. After successful HTTP Basic authentication, Express serves the built React SPA.
4. The browser opens `/api/v1/activity/stream` on the same origin; browser-managed Basic credentials authenticate the request in remote mode.
5. No MCP OAuth access token is exposed to the activity JavaScript application.

The Web credential authorizes `/console/*` and read-only `/api/v1/*`; it never authorizes `/mcp`. The API is a first-class interface rather than a browser-owned implementation detail, so external monitors may instead use `OBSERVABILITY_TOKEN` in remote mode. Local mode follows the loopback trust boundary.

## Live Feed Establishment

When the SSE endpoint is accepted:

1. ActivityTracker creates and registers a bounded subscriber queue.
2. It captures a bounded snapshot from the current in-process projection.
3. The HTTP route sends the snapshot.
4. Events that arrived after snapshot capture are drained from the subscriber queue.
5. Subsequent events are streamed live.

There is no durable replay cursor. If the connection is interrupted, the browser reconnects and receives a new current snapshot.

If a subscriber cannot drain its bounded queue, the server terminates that stream. Fresh snapshot recovery is preferred over unbounded buffering or partial silent event loss.

## Shell-Aware Tool Call

For a normal Shell-scoped tool:

1. the MCP tool handler enters the shared Shell-aware invocation helper;
2. ShellStore resolves the requested shell_id;
3. ToolCallRecorder creates the call identity and a bounded, tool-agnostic input preview;
4. ToolCallRecorder publishes tool_call.started with that preview;
5. ActivityTracker updates current workspace/Shell running presence before subscriber fan-out;
6. the tool executes from the resolved Shell root;
7. ToolCallRecorder builds the final success or error record with the complete input;
8. ObservabilityStore attempts durable persistence of the completed call and latest completed Shell lifecycle event;
9. ToolCallRecorder publishes tool_call.finished; ActivityTracker closes the running lifecycle and starts the post-completion active window from `finished_at`; and
10. the original tool result or original tool error is returned to the MCP client.

If Shell lookup fails, the failed invocation is still observable with its requested shell_id and no resolved workspace cwd.

## create_shell Activity

create_shell is observable before a Shell ID exists:

1. the request provides an absolute cwd;
2. ToolCallRecorder publishes a running call containing that cwd;
3. Shell creation validates the directory and commits the Shell;
4. the completed call includes the resulting shell_id; and
5. the same activity call is patched from running to success or error.

This allows a newly entered workspace to appear immediately rather than waiting for a later Shell-scoped tool call.

## Activity Presence and Browser Ordering

The server owns the five-minute activity policy and serializes `active`, `active_until`, `server_time`, and running counts. A running call is active regardless of age; otherwise the exact `active_until` deadline is inactive.

The framework-independent browser model owns only two-tier ordering:

    server-derived active presence -> ACTIVE
    otherwise                      -> EARLIER

An ACTIVE workspace does not move on every new event. Promotion from EARLIER moves it to the front of ACTIVE. The latest snapshot/reconnect calibrates server-clock offset; queued live events do not move that clock backward. A local timer compares server-provided `active_until` with server-adjusted time so expiry occurs even if the SSE stream is otherwise idle; the browser does not contain its own five-minute rule.

## Historical Reads

When a workspace or Shell history page is opened:

1. `/api/v1/shells?cwd=...` obtains bounded Shell inventory from ShellStore;
2. `/api/v1/shells/:shell_id/activity` provides authoritative current Shell presence;
3. `/api/v1/shells/:shell_id/calls` reads retained completed-call summaries from ObservabilityStore with opaque durable cursor pagination; and
4. `/api/v1/tool-calls/:call_id` reads the retained gzip payload from ObservabilityStore only when full input/output/error detail is requested.

The browser follows returned cursors with an explicit Load more action so bounded API pages do not silently hide older retained history. Cursors are returned unchanged to the API and are never decoded by browser code.

The browser formats summaries as function-style invocations from the bounded preview. One feature-local formatter owns argument priority and value compaction for both Activity cards and Shell history. Unknown argument names remain visible after known prioritized names; the backend does not encode tool-specific presentation semantics.

Completed SSE events invalidate affected TanStack Query entries for Shell history and workspace Shell inventory. Those queries refetch authoritative history rather than having the live feed duplicate pagination or insertion rules.

The live stream never carries full payloads by default.

If a recent Activity summary outlives its durable retained call, the API reports that detail is unavailable rather than reconstructing it from another source. Durable metadata itself is retired with its payload.

## Restart

At process startup:

1. ObservabilityStore opens and validates `history.db`;
2. retained legacy gzip payloads are imported once when the old layout exists;
3. schema v1 history is upgraded to the independent `shell_activity` projection when necessary;
4. configured complete-call retention is converged;
5. only the bounded recent summary window plus Shell activity still inside the active window are read into ActivityTracker; and
6. HTTP/MCP serving starts with those projections available.

Running calls are process-local and disappear on restart. Durable latest Shell activity survives independently of complete-call retention, so a recently completed Shell retains the remaining active window after restart. Retained completed calls remain queryable independently of the Activity bootstrap cap, and durable Shells remain.

## Failure Isolation

- Tool-log persistence failure is reported but does not replace the original tool outcome.
- Activity publication failure does not alter tool semantics.
- Malformed legacy payloads are diagnosed without invalidating already indexed history.
- A slow activity browser cannot create unbounded subscriber memory.
- A read-credential failure does not reach remote Observability API data.
- Web Basic and Observability Bearer credentials cannot authorize `/mcp`.
