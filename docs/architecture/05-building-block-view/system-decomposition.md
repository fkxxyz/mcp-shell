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
- validation of required server configuration; and
- optional `ACTIVITY_PASSWORD`, which enables the Basic-authenticated `/activity/*` surface when configured.

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

`ShellStore` owns `~/.mcp-shell/shells.db`. Shell rows are addressed directly by integer `shell_id`; bounded `cwd` queries support the activity read model without making tool logs authoritative for Shell existence. SQLite `INTEGER PRIMARY KEY AUTOINCREMENT` makes committed IDs monotonically increasing and never reused within one mcp-shell installation.

`create_shell` requires an accessible absolute directory, reads `~/.agents/AGENTS.md` as global guidance when present, then reads a root `AGENTS.md` as project guidance when present, commits the Shell, and returns its ID plus concise bootstrap instructions. Global guidance is returned before project guidance so the more specific project rules can override it. `AGENTS.md` contents are returned to the agent but are not copied into the database.

A Shell is independent from an MCP session and from project identity. Multiple Shells may have the same `cwd`; each remains a distinct durable execution context. There is no MCP operation to list or close Shells.

## Host Tools (`src/tools/`)

Tool registration is modular:

- `basic.ts`: `read`, `write`, `edit`, `bash` adapters around Pi coding-agent tools;
- `apply-patch.ts`: structured patch application;
- `read-image.ts`: image inspection;
- `lsp.ts`: definition, reference, symbol, diagnostic, and rename operations.

Shell-aware tools require `shell_id`, resolve it through `ShellStore`, and root relative operations at that Shell's `cwd`. An unknown ID is rejected instead of falling back to process or server working directory. Tools do not decide network exposure or authorization.

`src/tools/invoke.ts` is the shared Shell-aware invocation boundary. It centralizes Shell resolution plus tool-call recording so individual host-tool modules do not duplicate observability behavior.

## Command Policy (`src/command-path.ts`, `bin/`)

`applyCommandPath` pins user command overrides first and repository command wrappers second. The repository wrappers currently bound `rg`, `grep`, `find`, and `fd` unless `--unsafe` is supplied.

## Observability (`src/observability/`)

`ToolCallRecorder` owns the recorded invocation lifecycle. `ToolLogStore` owns gzip payload persistence, lightweight index access, and bounded payload retention. `ActivityTracker` owns bounded live state and subscribers. `ActivityQuery` composes UI read models from activity, Shell, and retained-log facts.

Complete call payloads remain gzip-compressed and the lightweight index gains Shell/workspace identity for new records. Startup tail-reads only a bounded recent index window rather than scanning installation-lifetime history. Older entries without Shell/workspace identity remain valid logs but are not decompressed solely for activity reconstruction.

The activity projection groups calls by Shell root `cwd` while preserving `shell_id` as execution-context identity. Running calls are process-local; only completed records are persisted. Logging and activity failures remain best-effort and do not replace original tool semantics.

## Activity HTTP and UI (`src/http/`, `web/`)

The activity browser surface is served from `/activity/*` on the existing application listener. Static UI, SSE, and read-only activity APIs share one HTTP Basic Auth boundary. `/mcp` remains on its existing OAuth bearer boundary; activity credentials are not accepted there.

The browser owns the ten-minute ACTIVE/EARLIER presentation rule and stable ordering. The backend exposes facts and bounded history rather than server-side activity ranks.

## Dependency Direction

```text
main -> config + http/app
http/app -> auth + mcp + shell-store + observability + activity-http
mcp -> tools + shell-store + tool-call-recorder
tools -> shell-store + tool-call-recorder
tool-call-recorder -> tool-log-store + activity-tracker
activity-http -> activity-query + activity-tracker
activity-query -> shell-store + tool-log-store + activity-tracker
basic/lsp -> command-path
```

Authorization may annotate request context for logging, but tool implementations do not depend on OAuth protocol services.
