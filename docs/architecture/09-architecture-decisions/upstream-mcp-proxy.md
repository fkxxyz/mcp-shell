---
summary: "Records the decision to proxy unauthenticated upstream Streamable HTTP MCP servers through mcp-shell's own /mcp endpoint, fixed at startup and shared across sessions."
viewpoint: decision
stakeholders:
  - architect
  - developer
  - operator
concerns:
  - architecture-coherence
  - correctness
  - security
  - operability
  - maintainability
  - rationale
activities:
  - orient
  - change
  - assess
  - decide
  - operate
facets:
  domain:
    - mcp-runtime
    - access-and-transport
---

# Upstream MCP Server Proxying

## Decision State

Accepted and implemented on branch `feat/upstream-proxy`. Not yet merged to `master`.

## Context

Some MCP servers are useful only to a host that is already authorized to run mcp-shell, and they expose no authentication of their own. Clients that connect to mcp-shell should reach those tools through the same OAuth-protected `/mcp` endpoint, without a second public endpoint and without a second credential.

Upstream tools run with the process user's authority, exactly like mcp-shell's own tools, so the operator must trust each configured upstream as much as mcp-shell itself.

## Decision

- Read optional upstream definitions from `~/.mcp-shell/upstreams.yaml`. The file accepts `name`, `url`, and a global `timeoutMs`. A missing file means no upstreams.
- Support Streamable HTTP upstreams only. Reject URLs that use non-HTTP schemes, embed credentials, or point at this mcp-shell instance (same public origin, or loopback on the listen port).
- Fetch each upstream's complete tool list once at startup. Any unreachable upstream, or any tool name that repeats a built-in tool or another upstream's tool, aborts startup. Names are never prefixed, so a client sees the upstream's own names.
- Expose proxied tools with the upstream's description, annotations, and an input schema converted once at startup. Output schemas are not forwarded; `structuredContent` passes through unchanged.
- Share one client per upstream across all MCP sessions. After a transport failure, the next call reconnects. An in-flight call is never replayed, because the upstream tool may already have run.
- Run every proxied call through the same invocation gate as built-in tools, so refusal during shutdown applies to both. Shutdown closes upstream clients after the grace period, which unblocks any call still waiting.
- Bound each proxied result's text to 50KB, with a notice when truncated.
- Keep proxied calls out of tool-call history, Activity, and the Web Console. Only mcp-shell's own tools are observed.

## Alternatives Rejected

### Replace `McpServer` tool registration with a custom registry

Rejected for now. SDK 1.29's `McpServer` installs its own `tools/list` and `tools/call` handlers and refuses to replace them. Overriding them needs private SDK state or a rewrite of every built-in tool. Converting upstream JSON Schema with `fromJSONSchema` and registering through the public API costs less and keeps built-in tool code unchanged. Reassess when the SDK exposes a supported way to register raw JSON Schema tools.

### Stdio upstreams

Rejected because they need child-process lifecycle, signal handling, and environment policy that mcp-shell does not own. Operators can front a stdio server with a Streamable HTTP bridge outside mcp-shell.

### Prefixing upstream tool names

Rejected because it changes names that clients already know, and collisions are rare enough to fail fast at startup instead.

### Starting with unreachable upstreams skipped

Rejected because a silently missing tool set is hard to diagnose, and conflict detection needs the complete tool set before the first session. Operators who need independent restarts should run mcp-shell after the upstreams it depends on.

### Per-session upstream connections

Rejected because each session would start its own upstream initialization, multiplying connections, and tools would be listed per session. The upstream contract therefore must tolerate concurrent callers. Reassess if an upstream carries per-client state.

### Replaying a failed call after reconnect

Rejected because the upstream may have executed a non-idempotent tool before the connection dropped.

### Per-upstream timeouts

Rejected for now because one global timeout covers the known upstreams. Add a per-entry override when a concrete upstream needs a different bound.

### Forwarding `tools/list_changed`

Rejected because tool sets are fixed at startup, so changes need a restart. Reassess together with dynamic tool registration.

## Consequences

- Operators restart mcp-shell after changing an upstream's tool set or after adding an upstream.
- `upstreams.yaml` must be owner-only (`0600`), because upstream URLs may carry credentials.
- A failing upstream blocks mcp-shell's startup, and the operator sees which upstream failed.
- Proxied calls appear in neither history nor the Web Console. Diagnosing them relies on the upstream's own logs and on mcp-shell's process logs.
- Tests cover configuration validation, proxied listing and calls, error pass-through, timeouts, result bounding, reconnection without replay, startup failure, name collisions at registration and at `createApp`, refusal after shutdown, and unblocking in-flight calls on shutdown.

## Reassessment

Reassess if the SDK offers public registration of raw JSON Schema tools, if upstreams need per-client state or dynamic tool sets, if proxied calls must be observable, or if stdio upstreams become necessary.
