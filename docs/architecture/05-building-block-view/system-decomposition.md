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

`mcp-shell.ts` delegates to `src/main.ts`. `src/main.ts` loads configuration, constructs the HTTP application, chooses the listener, and is the sole process-signal owner. It waits for both application cleanup and HTTP-server close during shutdown.

The listener host is profile-dependent here rather than in the MCP implementation.

## Configuration (`src/config.ts`)

Owns:

- `~/.mcp-shell/` paths;
- parsing the server env file;
- optional shell-environment sourcing;
- command-path construction;
- validation of required server configuration;
- parsing exact HTTPS OAuth resource aliases for remote mode; and
- optional `WEB_PASSWORD`, which enables the Basic-authenticated `/console/*` and `/api/*` Web surface together when configured.

`AppConfig` is mode-dependent: local mode carries the shared runtime configuration only, while remote mode additionally requires OAuth/public-base-url settings. Shell roots are runtime data created through `create_shell`, not server configuration.

## HTTP and Authorization (`src/http/`, `src/auth/`)

`src/http/app.ts` composes Express middleware and protocol routers. A process-wide request admission gate is installed before body parsing so shutdown can reject every new route uniformly while admitted requests remain drainable. The application runtime owns shared runtime resources such as the `SkillCatalog` and `LSPServerManager`, creating one default instance of each per application runtime (or accepting injected instances for isolated composition such as tests) and passing those same instances through MCP session construction.

`src/auth/` owns:

- OAuth discovery and authorization/token routes;
- authorization parameter and PKCE validation;
- one accepted-resource policy covering the primary public base URL plus configured aliases;
- token issuance and refresh;
- persisted authorization state;
- bearer middleware and tool-log actor derivation.

In the local profile, this block is not on the `/mcp` request path; in remote profile its responsibilities remain unchanged.

## MCP Runtime (`src/mcp/`)

`McpSessionManager` owns the in-process map from MCP session IDs to `StreamableHTTPServerTransport` instances. It creates one `McpServer` per newly initialized session, enters a non-reopenable closing state during shutdown, prevents late initialization from escaping transport cleanup, closes standalone SSE streams during quiescence, and closes all transports after admitted requests drain.

`createMcpRouter` maps HTTP `POST`, `GET`, and `DELETE` at `/mcp` to the resolved transport and attaches tool-log context.

`createMcpServer` owns server construction and delegates tool registration.

## Durable Shell State (`src/shell.ts`, `src/shell-store.ts`)

`ShellStore` owns `~/.mcp-shell/shells.db`. Shell rows are addressed directly by integer `shell_id`; bounded `cwd` queries support the activity read model without making tool logs authoritative for Shell existence. SQLite `INTEGER PRIMARY KEY AUTOINCREMENT` makes committed IDs monotonically increasing and never reused within one mcp-shell installation.

`create_shell` requires an accessible absolute directory, reads `~/.agents/AGENTS.md` as global guidance when present, reads a root `AGENTS.md` as project guidance when present, discovers the current global Skill Catalog, commits the Shell, and returns its ID plus concise bootstrap instructions. Skill bodies are not injected; only valid skill names and descriptions are listed. Global guidance is returned before project guidance so the more specific project rules can override it. Neither `AGENTS.md` nor skill contents are copied into the database.

A Shell is independent from an MCP session and from project identity. Multiple Shells may have the same `cwd`; each remains a distinct durable execution context. There is no MCP operation to list or close Shells.

## Skill Catalog (`src/skills.ts`)

`SkillCatalog` owns host-global skill discovery and loading under `~/.agents/skills`. It recursively walks directories, follows directory and `SKILL.md` symlinks including targets outside the skill root, and tracks real directories/files to terminate cycles and avoid duplicate physical traversal. A valid `SKILL.md` requires YAML frontmatter with non-empty string `name` and `description`; malformed, unreadable, or otherwise invalid entries are diagnosed and skipped without failing the catalog.

Traversal is deterministic: each directory's entries are sorted by JavaScript string ordering and processed in order with immediate depth-first recursion. Every valid discovery updates the catalog by frontmatter `name`, so a later valid discovery deterministically replaces an earlier skill with the same name and emits a diagnostic identifying the shadowed source. Final summaries are sorted by name for presentation. Discovery and loading rescan the filesystem rather than persisting or caching skill state.

The `skill` tool uses exact case-sensitive name matching and returns the full current `SKILL.md` plus the real path of the logical containing directory. For a symlinked `SKILL.md`, relative resources therefore remain based on the directory where that `SKILL.md` was discovered; for a symlinked skill directory, that directory resolves to its target.

## Host Tools (`src/tools/`)

Tool registration is modular:

- `skill.ts`: lazy loading of one globally discovered skill;
- `basic.ts`: MCP registration for application-owned `read`, `write`, `edit`, and `bash` implementations under `src/tools/basic/`;
- `apply-patch.ts`: structured patch application;
- `read-image.ts`: image inspection;
- `lsp.ts`: definition, reference, symbol, diagnostic, and rename operations.

Shell-aware tools require `shell_id`, resolve it through `ShellStore`, and root relative operations at that Shell's `cwd`. An unknown ID is rejected instead of falling back to process or server working directory. Tools do not decide network exposure or authorization.

`src/tools/invocation-gate.ts` owns process-wide tool admission and active-invocation counting. `src/tools/invoke.ts` is the shared Shell-aware invocation boundary and enters that gate before Shell resolution or tool-call recording. `create_shell` and `skill`, which are not Shell-aware invocations, enter the same gate directly. Shutdown therefore has one tool-work boundary without making observability responsible for lifecycle correctness.

`src/runtime/drain-gate.ts` provides the narrow close-admission-and-drain primitive shared by HTTP and tool lifecycle boundaries. `src/host/paths.ts` owns shared host-path resolution. `FileMutationCoordinator` provides process-local serialization for structured file mutations without claiming filesystem locking. `ProcessSupervisor` owns registered tool child processes; application shutdown gives active tools three seconds to finish naturally, then the supervisor sends process-group `SIGTERM`, waits one second, and escalates survivors to `SIGKILL`. `LSPServerManager` owns the reusable LSP-client pool and its idle lifecycle. LSP server selection prepares one launch specification from the detected workspace, server-specific environment, LSP supplemental paths, and application command policy; the client starts the already-resolved executable from that same specification. These resources are application-owned and shared across MCP sessions rather than process-global or session-local.

## Command Policy (`src/command-path.ts`, `bin/`)

`applyCommandPath` pins user command overrides first and repository command wrappers second. `resolveExecutable` resolves a command against the exact cwd and effective environment used for execution, including platform-specific executable rules. The repository wrappers currently bound `rg`, `grep`, `find`, and `fd` unless `--unsafe` is supplied.

## Observability (`src/observability/`)

`ToolCallRecorder` owns the recorded invocation lifecycle. `ToolLogStore` owns gzip payload persistence, lightweight index access, and bounded payload retention. `ActivityTracker` owns bounded live state and subscribers. `ActivityQuery` composes UI read models from activity, Shell, and retained-log facts.

Complete call payloads remain gzip-compressed and the lightweight index gains Shell/workspace identity for new records. Startup tail-reads only a bounded recent index window rather than scanning installation-lifetime history. Older entries without Shell/workspace identity remain valid logs but are not decompressed solely for activity reconstruction.

The activity projection groups calls by Shell root `cwd` while preserving `shell_id` as execution-context identity. Running calls are process-local; only completed records are persisted. Logging and activity failures remain best-effort and do not replace original tool semantics.

## Shared Browser Contracts (`src/contracts/`)

`src/contracts/` owns browser/server DTO shapes for the current Web API. These types describe JSON/SSE transport data only; they do not expose Express, React, SQLite, `ActivityTracker`, `ShellStore`, or other implementation objects. Runtime validation remains concentrated at genuinely untrusted inputs rather than re-validating responses produced by the same release.

## Web Console HTTP and UI (`src/http/`, `web/`)

The Web Console SPA is served from `/console/*` on the existing application listener. Browser JSON/SSE APIs are served from `/api/*`. Both namespaces share one HTTP Basic Auth boundary enabled by `WEB_PASSWORD`. When that Web surface is enabled, `GET /` is an unauthenticated, non-cacheable `302` convenience redirect to `/console/`; when disabled, the root remains unmounted. `/mcp` remains on its existing OAuth/local-mode authority boundary; Web credentials are not accepted there.

`web/src/app/` owns application composition and routing; `web/src/features/` owns feature behavior; route modules compose feature pages; `web/src/lib/` contains narrow browser infrastructure. Components stay feature-local until demonstrated cross-feature reuse.

The Activity model owns the ten-minute ACTIVE/EARLIER presentation rule and stable ordering independently of React. TanStack Query owns paged REST-like reads; completed SSE events invalidate affected Shell/workspace queries. The backend exposes facts and bounded history rather than server-side activity ranks.

Production serves Vite's content-hashed assets from `dist/web/` and the compiled server from `dist/server/`. SPA fallback is limited to `/console`; missing assets, API paths, MCP paths, and OAuth paths never fall through to `index.html`.

## Dependency Direction

```text
main -> config + http/app
http/app -> auth + mcp + shell-store + skills + observability + activity-http
mcp -> tools + shell-store + skills + tool-call-recorder + host coordination
shell -> shell-store + skills
tools -> shell-store + skills + tool-call-recorder + host coordination
tool-call-recorder -> tool-log-store + activity-tracker
activity-http -> activity-query + activity-tracker
activity-query -> shell-store + tool-log-store + activity-tracker
basic/lsp/read-image -> command-path
web -> browser contracts + /api HTTP/SSE only
```

Authorization may annotate request context for logging, but tool implementations do not depend on OAuth protocol services.
