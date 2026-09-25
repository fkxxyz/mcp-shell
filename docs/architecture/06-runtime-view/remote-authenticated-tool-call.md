---
summary: "Describes remote-mode authorization, MCP session initialization, tool invocation, logging, and shutdown flow."
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

A request with an unknown session ID, or a sessionless non-initialize POST, is rejected as a bad MCP request.

## Tool Invocation

1. `/mcp` resolves the transport from the session ID.
2. Tool-log context carries the session and bearer-derived actor fingerprint.
3. The MCP SDK dispatches the selected registered tool.
4. `recordToolCall` records start time and input, runs the tool, then persists either output or serialized error.
5. The tool result or tool error is returned through the MCP transport.

Logging persistence failure is written to stderr and does not convert a successful host action into a failed MCP tool result.

## Session End and Process Shutdown

MCP transport close removes the session from the map. On SIGINT or SIGTERM, the HTTP server stops accepting work, all known transports are closed, and authorization state is persisted.

A process restart invalidates active MCP sessions because the transport map is not durable. Persisted OAuth tokens can remain valid until their own expiry or rotation rules invalidate them.
