---
summary: "Decomposes mcp-shell into configuration, HTTP/auth, MCP session, tool, command-policy, and logging responsibilities."
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
- resolution of the MCP tool workspace;
- validation of required server configuration.

`AppConfig` is mode-dependent: local mode carries the shared runtime configuration only, while remote mode additionally requires OAuth/public-base-url settings. The shared configuration contains an explicit tool workspace (`MCP_WORKDIR`), resolved independently from the server process working directory. If it is not configured, the workspace defaults to the current user's home directory.

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

## Host Tools (`src/tools/`)

Tool registration is modular:

- `basic.ts`: `read`, `write`, `edit`, `bash` adapters around Pi coding-agent tools;
- `apply-patch.ts`: structured patch application;
- `read-image.ts`: image inspection;
- `lsp.ts`: definition, reference, symbol, diagnostic, and rename operations.

These tools receive the configured MCP tool workspace and, where relevant, command-path policy. Relative shell and filesystem operations are rooted in that workspace. The workspace is independent from the server process working directory, so changing how or where `mcp-shell` is launched does not change tool path semantics. They do not decide network exposure or authorization.

## Command Policy (`src/command-path.ts`, `bin/`)

`applyCommandPath` pins user command overrides first and repository command wrappers second. The repository wrappers currently bound `rg`, `grep`, `find`, and `fd` unless `--unsafe` is supplied.

## Tool Logging (`src/tool-logs.ts`)

Owns asynchronous call context and per-call persistence. Complete call payloads are gzip-compressed; `index.jsonl` records lightweight metadata. Logging failure is reported but does not replace the tool result with a logging failure.

## Dependency Direction

```text
main -> config + http/app
http/app -> auth + mcp
mcp -> tools
basic/lsp -> command-path
tools -> tool-logs
```

Authorization may annotate request context for logging, but tool implementations do not depend on OAuth protocol services.
