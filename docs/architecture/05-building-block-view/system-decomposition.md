---
summary: "Decomposes mcp-shell into configuration, HTTP/auth, MCP session, durable Shell, tool, command-policy, and logging responsibilities."
viewpoint: static
stakeholders:
  - architect
  - developer
concerns:
  - architecture-coherence
  - correctness
  - maintainability
activities:
  - orient
  - change
  - diagnose
  - assess
facets:
  domain:
    - whole-system
    - access-and-transport
    - mcp-runtime
    - host-tools
    - observability
---

# System Decomposition

## Composition Root

`mcp-shell.ts` delegates to `src/main.ts`. `src/main.ts` loads configuration, constructs the HTTP application, chooses the listener, and coordinates process shutdown.

The listener host is profile-dependent here rather than in the MCP implementation.

## Configuration (`src/config.ts`)

Owns:

- `~/.mcp-shell/` paths;
- parsing the server env file;
- optional shell-environment sourcing;
- command-path construction;
- validation of required server configuration.

`AppConfig` is mode-dependent: local mode carries the shared runtime configuration only, while remote mode additionally requires OAuth/public-base-url settings. Shell roots are runtime data created through `create_shell`, not server configuration.

## HTTP and Authorization (`src/http/`, `src/auth/`)

`src/http/app.ts` composes Express middleware and protocol routers.

`src/auth/` owns:

- OAuth discovery and authorization/token routes;
- authorization parameter and PKCE validation;
- token issuance and refresh;
- persisted authorization state;
- bearer middleware and tool-log actor derivation.

In the local profile, this block is not on the `/mcp` request path; in remote profile its responsibilities remain unchanged.

## MCP Runtime (`src/mcp/`)

`McpSessionManager` owns the in-process map from MCP session IDs to `StreamableHTTPServerTransport` instances. It creates one `McpServer` per newly initialized session, closes transports on shutdown, and rejects non-initialization requests that lack a valid session.

`createMcpRouter` maps HTTP `POST`, `GET`, and `DELETE` at `/mcp` to the resolved transport and attaches tool-log context.

`createMcpServer` owns server construction and delegates tool registration.

## Durable Shell State (`src/shell.ts`, `src/shell-store.ts`)

`ShellStore` owns `~/.mcp-shell/shells.db`. Shell rows are addressed directly by integer `shell_id`; the store does not load or enumerate all Shells. SQLite `INTEGER PRIMARY KEY AUTOINCREMENT` makes committed IDs monotonically increasing and never reused within one mcp-shell installation.

`create_shell` requires an accessible absolute directory, reads `~/.agents/AGENTS.md` as global guidance when present, then reads a root `AGENTS.md` as project guidance when present, commits the Shell, and returns its ID plus concise bootstrap instructions. Global guidance is returned before project guidance so the more specific project rules can override it. `AGENTS.md` contents are returned to the agent but are not copied into the database.

A Shell is independent from an MCP session and from project identity. Multiple Shells may have the same `cwd`; each remains a distinct durable execution context. There is no MCP operation to list or close Shells.

## Host Tools (`src/tools/`)

Tool registration is modular:

- `basic.ts`: `read`, `write`, `edit`, `bash` adapters around Pi coding-agent tools;
- `apply-patch.ts`: structured patch application;
- `read-image.ts`: image inspection;
- `lsp.ts`: definition, reference, symbol, diagnostic, and rename operations.

Shell-aware tools require `shell_id`, resolve it through `ShellStore`, and root relative operations at that Shell's `cwd`. An unknown ID is rejected instead of falling back to process or server working directory. Tools do not decide network exposure or authorization.

## Command Policy (`src/command-path.ts`, `bin/`)

`applyCommandPath` pins user command overrides first and repository command wrappers second. The repository wrappers currently bound `rg`, `grep`, `find`, and `fd` unless `--unsafe` is supplied.

## Tool Logging (`src/tool-logs.ts`)

Owns asynchronous call context and per-call persistence. Complete call payloads are gzip-compressed; `index.jsonl` records lightweight metadata. Logging failure is reported but does not replace the tool result with a logging failure.

## Dependency Direction

```text
main -> config + http/app
http/app -> auth + mcp + shell-store
mcp -> tools + shell-store
tools -> shell-store
basic/lsp -> command-path
tools -> tool-logs
```

Authorization may annotate request context for logging, but tool implementations do not depend on OAuth protocol services.
