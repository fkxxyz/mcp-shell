---
summary: "Defines hard security, protocol, deployment, persistence, and host-execution constraints for mcp-shell."
viewpoint: overview
stakeholders:
  - architect
  - developer
  - operator
concerns:
  - security
  - operability
  - correctness
activities:
  - orient
  - change
  - operate
  - assess
facets:
  domain:
    - whole-system
    - access-and-transport
    - host-tools
---

# Architecture Constraints

## Host Authority

- Tool implementations execute with the operating-system permissions of the mcp-shell process user.
- File tools accept host paths, including absolute paths where the underlying tool supports them.
- The `bash` tool can invoke arbitrary commands available to that user.
- Command wrappers and MCP tool annotations are guardrails and client hints, not a sandbox or privilege boundary.

## Transport and Exposure

- MCP protocol transport is Streamable HTTP at `/mcp`.
- **Remote profile:** network-reachable access requires authentication and is expected to sit behind HTTPS ingress.
- **Local profile:** unauthenticated MCP is permitted only while bound to loopback (`127.0.0.1`); the architecture must not permit `0.0.0.0 + no authentication` as a valid profile.
- A tunnel profile is transport placement, not a third authorization model: mcp-shell remains in local mode and a trusted outbound tunnel client makes that loopback endpoint usable by a remote MCP client environment.

## Authorization

The current remote implementation has one configured OAuth client, one administrator password, PKCE S256, one advertised `full` scope, short-lived authorization codes, one-hour access tokens, and rotating refresh tokens.

It is intentionally not a general identity platform.

## State and Scale

- OAuth state persists to a local JSON file and is also held in process memory.
- MCP transports are process-local and keyed by MCP session ID.
- Restarting the process terminates active MCP sessions.
- Multiple mcp-shell processes do not coordinate session or token mutation.

## Configuration

- Runtime configuration is read from `~/.mcp-shell/env`.
- An optional shell environment file may be sourced before server configuration is applied.
- Server configuration is authoritative over values inherited from that sourced shell environment.
- `MODE=local|remote` selects the connection profile; omitted `MODE` defaults to `remote` for compatibility with existing deployments.
- Remote OAuth/public-base-url settings are required only in `remote` mode.

## Command Lookup

`~/.mcp-shell/bin` is first in `PATH`, the repository `bin/` directory is second, and the remaining path follows. This ordering is re-applied at child-process spawn boundaries. User overrides intentionally outrank repository wrappers.

## Search Budget

Repository wrappers for `rg`, `grep`, `find`, and `fd` impose a 200 ms wall-clock budget unless the caller deliberately supplies wrapper-only `--unsafe`.
