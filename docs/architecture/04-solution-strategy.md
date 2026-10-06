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

A trusted outbound tunnel does not introduce another mcp-shell authentication profile. The common personal-host path tunnels local mode; deployments that need mcp-shell OAuth for all callers may tunnel remote mode instead.

## Single-Process Composition

Express, OAuth services, persisted authorization state, durable Shell state, MCP session management, and tool registration live in one process. This keeps ownership and shutdown behavior explicit and matches the intended personal-host deployment scale.

## Separate Protocol from Tools

`src/mcp/` owns MCP server/session behavior. `src/tools/` owns concrete host capabilities. Tool modules register against `McpServer` and do not own HTTP exposure or OAuth.

## Application-Owned Core Host Tools

mcp-shell owns the semantics of `read`, `write`, `edit`, and `bash` instead of adapting a full coding-agent runtime. Node filesystem and child-process primitives implement the core behavior; the small direct `diff` dependency supplies edit diagnostics.

Two narrow host control points cover cross-tool rules: `FileMutationCoordinator` serializes structured mutations of the same path across `write`, `edit`, `apply_patch`, and LSP rename, while `ProcessSupervisor` owns the lifecycle of tool-spawned processes such as Bash process groups and ImageMagick children. The governing decision and exact behavioral boundaries live in [Application-Owned Core Host Tools](09-architecture-decisions/application-owned-core-host-tools.md).

## Durable Shell Execution Context

MCP sessions are transport state. Shells are durable execution-state handles for agents. `create_shell` assigns a monotonically increasing `shell_id` to an absolute root directory; subsequent host operations resolve relative paths from that Shell. Multiple Shells may use the same root while remaining distinct execution contexts.

Shells are intentionally not enumerable or closable through MCP. An agent creates a Shell for its own session and retains the returned ID. The abstraction can grow with future Shell-scoped tool state without coupling that state to MCP transport lifetime.

## Lazy Global Skill Discovery

Skills are host-global agent guidance under `~/.agents/skills`, not Shell state. `create_shell` exposes only the current valid skill names and descriptions; the `skill` tool loads one named `SKILL.md` only when needed. Discovery is performed from the filesystem on each operation rather than cached, so edits and symlink changes take effect without reload or watcher lifecycle.

`SkillCatalog` owns recursive traversal, symlink following, metadata validation, deterministic duplicate resolution, and loading. `createApp` owns one catalog instance for the application runtime and injects it through MCP session/server construction to both `create_shell` and `skill`; tests may inject an isolated catalog. Tool adapters and Shell bootstrap consume that one authority rather than creating or duplicating discovery rules.

## Local Persistence for Local Authority

OAuth token state, durable Shell state, and tool logs live under `~/.mcp-shell/`. OAuth state remains JSON; Shell state uses SQLite because Shell count grows monotonically and access is by `shell_id`, avoiding whole-history loads or rewrites. The system still assumes one host and does not introduce a distributed coordinator.

## One Tool-Call Lifecycle, Multiple Observability Projections

Tool execution, durable evidence, and live browser activity share one tool-call lifecycle instead of maintaining separate instrumentation paths. `ShellStore` remains authoritative for Shell roots; one recorder coordinates call lifecycle; durable logs and bounded in-memory activity are separate projections.

The Activity feature groups Shells by persisted root `cwd`, because the working directory is the useful project-level identity for an operator. This grouping remains a read model rather than a durable Workspace entity.

## First-Class Web Console, Same Process

The browser surface is a first-class Web Console rather than an Activity-owned static subtree. React + TypeScript + Vite provide the application shell; TanStack Router owns addressable navigation; TanStack Query owns request-derived server state; native SSE continues to deliver Activity lifecycle facts. The framework-independent Activity model retains the two-tier stable-ordering policy.

The Web Console remains a client of explicit `/api/*` HTTP/SSE contracts. It does not import observability stores, Shell persistence, or MCP runtime objects. Browser and backend are one repository, one release, one origin, and one production process; Vite is development/build tooling rather than another deployed server.

The current Web authority remains read-only. WebSocket transport, durable event replay, independent frontend deployment, SSR/full-stack React frameworks, global client-state libraries, API versioning, analytics, and a tool-log database migration require demonstrated need before adoption.

## Build Once, Run Compiled Output

Development may run TypeScript and Vite watchers, but production does not transpile source at startup. `npm run build` produces compiled server output plus content-hashed browser assets, and `npm start` runs the compiled Node entry point. Enabling the Web Console in production while its browser build is missing is a startup error.

## Guardrails, Not Sandboxing

Search wrappers bound accidental broad scans; tool annotations describe read/write/destructive intent to MCP clients; logs record actions. None of these are treated as containment against an authorized caller.
