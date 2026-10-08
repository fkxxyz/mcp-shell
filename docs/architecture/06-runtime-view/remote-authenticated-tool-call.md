---
summary: "Describes remote-mode authorization, MCP session initialization, durable Shell bootstrap, tool invocation, logging, and shutdown flow."
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
    - access-and-transport
    - mcp-runtime
    - host-tools
    - observability
---

# Remote Authenticated Tool Call

This View describes the **remote-mode implementation**.

## Authorization

1. The client reads protected-resource and authorization-server metadata.
2. `GET /authorize` validates response type, client ID, redirect URI, PKCE S256 challenge, and resource, then renders the password form.
3. `POST /authorize` verifies the configured administrator password and issues a short-lived one-time authorization code.
4. `POST /token` authenticates the configured OAuth client and exchanges the code plus verifier for an access token and refresh token.
5. Access tokens expire after one hour. Refresh tokens rotate when used.

Authorization-code, access-token, and refresh-token state is persisted asynchronously to `~/.mcp-shell/state.json` using an atomic rename sequence.

## MCP Initialization

1. The client sends `POST /mcp` with a valid bearer token.
2. Bearer middleware validates the token and derives a non-secret actor fingerprint for logging.
3. If the request has no session ID and is an MCP initialize request, `McpSessionManager` creates a `StreamableHTTPServerTransport` with a generated session ID.
4. A new `McpServer` is constructed and all tools are registered for that transport.
5. The initialized transport is stored in the process-local session map.

The session entry also retains its `McpServer`, so later tool requests can read the standard `clientInfo.name` from the SDK's initialized client version. That name is observational and is not an authorization claim.

A request with an unknown session ID, or a sessionless non-initialize POST, is rejected as a bad MCP request.

## Shell Bootstrap

1. The agent calls `create_shell` with an absolute directory.
2. mcp-shell validates that the directory exists and is accessible.
3. Global and project `AGENTS.md` guidance is read when present.
4. The application-owned `SkillCatalog` recursively scans `~/.agents/skills`, follows symlinks, skips invalid skills, and resolves duplicate valid names by deterministic last discovery. Duplicate replacement is diagnosed without changing the last-wins result.
5. `ShellStore` inserts the Shell into `~/.mcp-shell/shells.db`; SQLite assigns a committed monotonic `shell_id`.
6. `create_shell` returns the ID, a structured `skills` summary list, and concise bootstrap instructions. The bootstrap lists only skill names and descriptions; full skill instructions are not injected. Global `AGENTS.md` guidance still precedes project guidance.

The Shell is not owned by the MCP transport. The same root can have multiple independent Shell IDs, and Shell rows survive MCP disconnects and process restarts. There is no list or close operation.

## Skill Loading

1. The agent calls `skill` with an exact name previously advertised by `create_shell`.
2. `SkillCatalog` rescans the current filesystem rather than consulting Shell state or a cache.
3. The current winning valid skill with that case-sensitive name is selected; an absent name fails with `Skill not found`.
4. The tool returns the complete current `SKILL.md`, its name and description, and the real path of the logical directory containing the discovered file so relative skill resources have an explicit base.

The skill tree is global and mutable. Therefore a skill advertised during Shell creation may change or disappear before a later `skill` call; loading intentionally observes the newer filesystem state.

## Tool Invocation

1. `/mcp` resolves the transport from the session ID.
2. Tool-log context carries the MCP transport session, bearer-derived actor fingerprint, standard client name, and optional namespaced logical client-session hint. The shared resolver applies the [Activity Observability identity rules](../08-cross-cutting-concepts/activity-observability.md#identity-rules); individual tools do not interpret client-specific headers or metadata.
3. The MCP SDK dispatches the selected registered tool.
4. A Shell-aware tool enters the shared invocation helper, which resolves its `shell_id` through `ShellStore`; unknown IDs fail without falling back to a process working directory.
5. `ToolCallRecorder` snapshots client identity once, registers valid Shell work with `ActivityService`, persists client-scoped usage membership, and publishes the running call to the bounded activity projection before executing the tool.
6. Relative operations use the resolved Shell `cwd`.
7. After execution, `ActivityService` synchronously persists the latest Shell completion time and membership, then removes running state. `create_shell` supplies its new Shell ID at this stage. The live projection advances before full history persistence.
8. `ObservabilityStore` attempts to persist the completed success/error record plus bounded preview and enforce complete-call retention; `ToolCallRecorder` then publishes the finished event, including whether full payload detail was retained.
9. The original tool result or original tool error is returned through the MCP transport.

Logging persistence or activity-publication failure is reported but does not convert a successful host action into a failed MCP tool result and does not replace the original tool error. Activity read/write failure latches a process-local degraded state and activity queries return `503 activity_unavailable`. Durable history metadata and payload retirement share one retention policy; completed Shell state and usage membership have independent lifetimes and write paths, while ActivityTracker remains bounded for live/recent state.

## Session End and Process Shutdown

MCP transport close removes the session from the map. Process shutdown follows the authority and ordering rules in `../08-cross-cutting-concepts/process-lifecycle.md`: new requests, session initialization, and tool invocations are closed first; admitted tools receive a three-second natural-completion window; remaining managed external processes are then terminated; admitted HTTP responses drain before MCP transports and shared stores are closed.

A process restart invalidates active MCP sessions because the transport map is not durable. Persisted Shells remain addressable through their existing IDs after restart. Persisted OAuth tokens can remain valid until their own expiry or rotation rules invalidate them.
