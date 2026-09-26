---
summary: "Defines the system-wide strategies used to keep host access powerful, explicit, small, and operable."
viewpoint: overview
stakeholders:
  - architect
  - developer
  - operator
concerns:
  - architecture-coherence
  - security
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
    - whole-system
    - access-and-transport
    - mcp-runtime
    - host-tools
    - observability
---

# Solution Strategy

## One MCP Core, Multiple Connection Profiles

MCP session handling and tool registration are independent from deployment exposure. Connection mode selects only how the HTTP endpoint is bound and protected:

- `remote`: bind to `0.0.0.0`, expose OAuth endpoints, and require bearer authentication for `/mcp`;
- `local`: bind to `127.0.0.1` and omit OAuth from the MCP request path.

A trusted outbound tunnel reuses local mode rather than introducing another mcp-shell authentication profile.

## Single-Process Composition

Express, OAuth services, persisted authorization state, durable Shell state, MCP session management, and tool registration live in one process. This keeps ownership and shutdown behavior explicit and matches the intended personal-host deployment scale.

## Separate Protocol from Tools

`src/mcp/` owns MCP server/session behavior. `src/tools/` owns concrete host capabilities. Tool modules register against `McpServer` and do not own HTTP exposure or OAuth.

## Durable Shell Execution Context

MCP sessions are transport state. Shells are durable execution-state handles for agents. `create_shell` assigns a monotonically increasing `shell_id` to an absolute root directory; subsequent host operations resolve relative paths from that Shell. Multiple Shells may use the same root while remaining distinct execution contexts.

Shells are intentionally not enumerable or closable through MCP. An agent creates a Shell for its own session and retains the returned ID. The abstraction can grow with future Shell-scoped tool state without coupling that state to MCP transport lifetime.

## Local Persistence for Local Authority

OAuth token state, durable Shell state, and tool logs live under `~/.mcp-shell/`. OAuth state remains JSON; Shell state uses SQLite because Shell count grows monotonically and access is by `shell_id`, avoiding whole-history loads or rewrites. The system still assumes one host and does not introduce a distributed coordinator.

## Guardrails, Not Sandboxing

Search wrappers bound accidental broad scans; tool annotations describe read/write/destructive intent to MCP clients; logs record actions. None of these are treated as containment against an authorized caller.
