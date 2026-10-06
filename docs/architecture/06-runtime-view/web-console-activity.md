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
4. The browser opens `/api/activity/stream` on the same origin; browser-managed Basic credentials authenticate the request.
5. No MCP OAuth access token is exposed to the activity JavaScript application.

The Web credential authorizes only `/console/*` and `/api/*`. `/mcp` continues to use the authority selected by the local/remote connection profile.

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
5. ActivityTracker updates its workspace projection before subscriber fan-out;
6. the tool executes from the resolved Shell root;
7. ToolCallRecorder builds the final success or error record with the complete input;
8. ToolLogStore attempts durable persistence;
9. ToolCallRecorder publishes tool_call.finished with the same preview and payload availability reflecting persistence outcome; and
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

## Browser Ordering

The server sends facts rather than ranks. The framework-independent Activity model applies the ten-minute two-tier policy:

    running call or recent lifecycle event -> ACTIVE
    otherwise                              -> EARLIER

An ACTIVE workspace does not move on every new event. Promotion from EARLIER moves it to the front of ACTIVE. A local timer performs expiry even if the SSE stream is otherwise idle.

## Historical Reads

When a workspace or Shell history page is opened:

1. `/api/shells?cwd=...` obtains bounded Shell inventory from ShellStore;
2. `/api/shells/:shell_id/calls` returns bounded call summaries with opaque cursor pagination; and
3. `/api/tool-calls/:call_id` reads the retained gzip payload only when full input/output/error detail is requested.

The browser follows returned cursors with an explicit Load more action so bounded API pages do not silently hide older retained history. Cursors are returned unchanged to the API and are never decoded by browser code.

The browser formats summaries as function-style invocations from the bounded preview. One feature-local formatter owns argument priority and value compaction for both Activity cards and Shell history. Unknown argument names remain visible after known prioritized names; the backend does not encode tool-specific presentation semantics.

Completed SSE events invalidate affected TanStack Query entries for Shell history and workspace Shell inventory. Those queries refetch authoritative history rather than having the live feed duplicate pagination or insertion rules.

The live stream never carries full payloads by default.

If metadata remains but the retained payload has been evicted, the API reports that detail is unavailable rather than reconstructing it from another source.

## Restart

At process startup:

1. ToolLogStore restores payload-retention state;
2. it tail-reads only the bounded recent lightweight index window;
3. compatible recent entries seed ActivityTracker; and
4. HTTP/MCP serving starts with that recent projection available.

The lightweight index does not persist input previews, because its current append-only lifetime can exceed retained payload lifetime. Restart-restored summaries therefore may format as `tool_name()` until new live calls populate previews. Old index entries lacking workspace identity remain valid log records and retained payloads are not decompressed solely to rebuild workspace identity or previews.

Running calls are process-local and disappear on restart. Persisted completed calls and durable Shells remain.

## Failure Isolation

- Tool-log persistence failure is reported but does not replace the original tool outcome.
- Activity publication failure does not alter tool semantics.
- Malformed historical index lines do not prevent server startup.
- A slow activity browser cannot create unbounded subscriber memory.
- A Web authentication failure does not reach Web API data.
- Web Basic credentials cannot authorize `/mcp`.
