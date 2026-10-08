# mcp-shell

A local-or-remote MCP server that gives ChatGPT and other MCP clients controlled access to a host machine's shell, files, patching, image inspection, and LSP capabilities.

It can serve a same-machine client over loopback without built-in OAuth, or a remote client through the existing OAuth-protected HTTPS deployment.

## What it provides

- File operations: `read`, `write`, `edit`
- Shell execution: `bash`
- Structured patching: `apply_patch`
- Image inspection: `read_image`
- Global skill discovery and lazy loading: `create_shell` + `skill`
- LSP support:
  - go to definition
  - find references
  - symbols
  - diagnostics
  - prepare rename
  - rename
- Local loopback mode without built-in OAuth
- Remote OAuth-style authorization with PKCE
- Streamable HTTP MCP transport
- Persistent Shell execution contexts
- Persistent token state
- Tool-call logging
- Client name and optional logical-session attribution on tool-call activity/history
- Versioned read-only Observability API for scripts, monitors, agents, and the bundled UI
- Optional read-only Web Console with live Activity grouped by workspace
- Guardrails for broad filesystem searches

## Core tool behavior

The Shell root is the base for relative paths, not a filesystem sandbox; absolute paths remain available to authorized callers.

`read` streams text with a 2,000-line / 50 KiB return budget and uses `offset`/`limit` for continuation. `edit` performs unique exact-text replacement after newline normalization only and preserves BOM plus CRLF/LF style. `bash` runs Bash in the Shell working directory, reapplies the configured command-path policy, combines stdout/stderr as observed, and returns at most the most recent 2,000 lines / 50 KiB. Redirect large command output to a file when complete output is required.

## Security

`mcp-shell` is intentionally powerful.

An authorized client can read and modify files and execute commands with the permissions of the user running the server. In practice, access to this MCP endpoint should be treated similarly to remote shell access.

In `local` mode, the server binds only to `127.0.0.1`; treat any tunnel forwarding that endpoint as part of the trusted boundary. In `remote` mode, use HTTPS ingress, protect the OAuth credentials, and expose it only to clients you trust. Treat `WEB_PASSWORD` and `OBSERVABILITY_TOKEN` as sensitive read credentials: the Observability API can expose retained tool inputs, outputs, paths, and errors even though it cannot execute tools.

## Requirements

- Node.js version satisfying the `engines.node` range in `package.json`
- npm
- A reachable HTTPS endpoint when used remotely
- Language servers installed locally if LSP tools are needed

## Install

```bash
npm install --include=dev
```

## Configure

Runtime configuration lives at:

```text
~/.mcp-shell/env
```

On first startup, the server creates a template configuration and exits.

Choose a connection mode:

```env
MODE=local
```

`local` mode needs no OAuth or public URL configuration and listens only on `127.0.0.1`.

For remote access, use:

```env
MODE=remote
PUBLIC_BASE_URL=https://mcp-shell.example.com
OAUTH_CLIENT_ID=your-client-id
OAUTH_CLIENT_SECRET=your-client-secret
ADMIN_PASSWORD=your-password
```

If `MODE` is omitted, it defaults to `remote` for compatibility with existing configurations.

Optional values include:

```env
PORT=3000
OAUTH_REDIRECT_URI=
OAUTH_REDIRECT_URI_ALLOWLIST=
OAUTH_RESOURCE_ALIASES=
TOOL_LOG_DIR=
TOOL_LOG_MAX_CALLS=10000
WEB_PASSWORD=
OBSERVABILITY_TOKEN=
```

`TOOL_LOG_MAX_CALLS` bounds complete retained tool-call history. Each retained call keeps compact indexed metadata plus its compressed full payload; when the count is exceeded, the oldest complete calls retire by invocation start order. Latest completed Shell activity and client-session/Shell usage relationships are retained independently so activity status survives call-history eviction and restart. They share `history.db`; deleting that database or `TOOL_LOG_DIR` also deletes this activity state.

Tool-call history, live Activity, and the read-only API include `client_name` (the client-declared MCP `initialize.clientInfo.name`) and `client_session_id` (an optional, best-effort logical session hint). The OpenAI adapter prefers `params._meta["openai/session"]` and falls back to the `x-openai-session` header when metadata is absent or invalid, preserving the `openai:` namespace and existing stored IDs. Other clients still report their standard name, with `client_session_id: null` when no recognized hint exists. Neither field proves user identity or authorizes host access. Session hints are stored verbatim and may be sensitive; protect them using the existing tool-log and Observability API access controls. The existing `session` retains its MCP transport-session meaning. See [Activity Observability — Identity Rules](docs/architecture/08-cross-cutting-concepts/activity-observability.md#identity-rules) for authoritative extraction, ambiguity, and compatibility semantics.

In remote mode, `PUBLIC_BASE_URL` must be the externally reachable HTTPS origin without a trailing slash.

If a trusted ingress or tunnel presents a different canonical OAuth resource identifier for the same mcp-shell, set `OAUTH_RESOURCE_ALIASES` to a comma-separated list of exact HTTPS identifiers:

```env
OAUTH_RESOURCE_ALIASES=https://tunnel.example.com/v1/mcp/example
```

Aliases are equivalent names for the same protected MCP resource, not separate authorization domains. Only explicitly configured aliases are accepted, and the same resource policy is enforced during authorization, code exchange, refresh, and bearer validation. Alias entries must be HTTPS URLs without credentials or fragments.

The simplest tunnel deployment can still use `MODE=local` with no built-in OAuth. Use remote mode plus resource aliases when the tunneled endpoint must retain mcp-shell OAuth, such as when the same instance also serves other authenticated network clients.

## Build and run

```bash
npm run build
npm start
```

Production runs compiled Node output from `dist/server/` and serves the Vite build from `dist/web/`. It does not transpile TypeScript or run Vite at service startup.

In local mode, the MCP endpoint is:

```text
http://127.0.0.1:<PORT>/mcp
```

In remote mode, the MCP endpoint is `<PUBLIC_BASE_URL>/mcp` and the server listens on `0.0.0.0`. `PORT` defaults to `3000` in both modes.

For a long-running user-level systemd deployment, build first and install the repository-owned service definition:

```bash
npm run build
npm run service:install
systemctl --user enable --now mcp-shell.service
npm run service:check
```

`service:install` renders the current Node executable and this checkout's `dist/server/mcp-shell.js` into the user unit, reloads systemd, and deliberately does not enable, start, or restart the service. If an older manually maintained `mcp-shell.service` already exists, review it and migrate explicitly with `npm run service:install -- --replace-existing`. The checkout used for installation remains the deployment root; reinstall the service before moving or deleting it.

`service:install` validates the rendered unit with `systemd-analyze verify` before replacing the installed file. `service:check` verifies the installed executable paths and effective shutdown-critical settings, including the `KillMode=mixed` / 15-second outer stop boundary required for the application's three-second active-tool completion opportunity. Restart policy remains a template default rather than a live correctness invariant. `Type=simple` does not claim listener readiness when `systemctl start` or `restart` returns.

For remote mode, place an HTTPS reverse proxy or equivalent trusted ingress in front of the service.

### Observability API and Web Console

The read-only Observability API is versioned under `/api/v1/*` and is usable independently of the Web Console. In local mode it is available on the loopback-only listener without an additional credential. In remote mode, set `OBSERVABILITY_TOKEN` for headless Bearer access:

```bash
curl -H "Authorization: Bearer $OBSERVABILITY_TOKEN" \
  https://your-host.example.com/api/v1/shells/42/activity
```

The direct Shell activity response includes `active`, `running_call_count`, `last_event_at`, `active_until`, `server_time`, and `active_window_ms`. Activity is true while a call is running or until five minutes after the latest lifecycle event; that policy is owned by the server. Use `active` and `active_until` as authoritative results; `active_window_ms` is informational and must not be used to reimplement the policy in clients.

To ask whether any session associated with a Shell is active, supply only its Shell ID:

```bash
curl -H "Authorization: Bearer $OBSERVABILITY_TOKEN" \
  https://your-host.example.com/api/v1/shells/42/session-activity
```

The response contains only `shell_id`, `active`, `active_until`, and `server_time`. A session is identified by the pair `(clientInfo.name, client_session_id)`; this installation treats the declared client name as the unique client identity. One session can use multiple Shells, and one Shell can be used by multiple sessions. The result is active when any Shell used by any directly associated session is active. For example, if one session uses Shells 42 and 43, a running call on 43 makes this query for 42 active even when 42 itself is inactive. Shared Shells do not recursively merge sessions or change another Shell's own activity.

Relationships are recorded before valid Shell tool execution, including tools that fail, and after successful `create_shell` completion. Calls without a resolved Shell do not affect session activity. Usage relationships remain after the activity window expires. A running related call gives `active_until: null`; otherwise the deadline is the maximum related Shell deadline. A known Shell with no recorded session relationship returns `active: false` and `active_until: null`. Invalid IDs return `400 invalid_request`; unknown Shells return `404 shell_not_found`.

Activity state is saved independently of full call payloads. Payload setup or write failure does not prevent activity queries. Activity database/read/write failure returns `503 activity_unavailable` for activity queries and remains degraded until process restart; original host-tool results are preserved. Schema v4 automatically backfills relationships from retained historical calls carrying both client identity fields before history retention runs. Previously evicted or unidentified relationships cannot be reconstructed from that history.

Useful endpoints include:

```text
GET /api/v1/activity
GET /api/v1/activity/stream
GET /api/v1/shells?cwd=...
GET /api/v1/shells/:shell_id/activity
GET /api/v1/shells/:shell_id/session-activity
GET /api/v1/shells/:shell_id/calls
GET /api/v1/tool-calls/:call_id
```

Set `WEB_PASSWORD` to enable the read-only Web Console:

```text
<base-url>/console/
```

When enabled, opening `<base-url>/` redirects to `/console/`. When `WEB_PASSWORD` is unset, the root and Web Console remain unavailable; the Observability API can still run headlessly.

Use HTTP Basic Auth username `activity` and the configured password. That Basic credential is also accepted by the remote read-only `/api/v1/*` surface so the same-origin Console can consume the public API. `OBSERVABILITY_TOKEN` enables API access without enabling the Console. Neither read credential is accepted by `/mcp`. Remote use requires HTTPS.

The current Web Console is read-only. Activity groups tool calls by Shell root directory, streams live lifecycle events over SSE, and exposes addressable Workspace, Shell, and tool-call detail routes. Full tool input/output is fetched only when a retained call is opened.

`WEB_PASSWORD` replaces the former `ACTIVITY_PASSWORD`; the old variable is not read.

## Connect

In local mode, connect directly to `http://127.0.0.1:<PORT>/mcp`; the built-in OAuth routes are not installed.

In remote mode, an MCP client first discovers the OAuth metadata, completes authorization, and then connects to:

```text
https://your-host.example.com/mcp
```

Relevant endpoints:

```text
/.well-known/oauth-protected-resource
/.well-known/oauth-authorization-server
/authorize
/token
/mcp
```

The remote authorization model is intentionally simple: one configured OAuth client and one owner password.

### Create a Shell

Before normal host operations, call `create_shell` with the absolute directory for the current agent session. It returns a persistent integer `shell_id` and concise bootstrap instructions. Available skills discovered under `~/.agents/skills` are listed by `name` and `description` only. If `~/.agents/AGENTS.md` exists, those global instructions are included before a root project `AGENTS.md`, so the more specific project guidance has precedence.

Pass that `shell_id` on subsequent operations and prefer paths relative to the Shell root. Creating another Shell for the same directory is valid and produces a distinct execution context.

### Load a Skill

Skills are `SKILL.md` files anywhere under `~/.agents/skills`. Discovery is recursive, follows symbolic links, and requires non-empty YAML frontmatter `name` and `description` fields. Invalid skills are skipped without preventing Shell creation.

Call `skill` with an exact skill name from the `create_shell` list. The tool rescans the current skill tree, then returns the complete `SKILL.md` plus the resolved skill directory for relative resources. Skill names are case-sensitive. When multiple valid skills use the same name, deterministic depth-first discovery applies and the last discovered skill wins.

## Local state

`mcp-shell` keeps its runtime state under:

```text
~/.mcp-shell/
```

Important files and directories include:

```text
~/.mcp-shell/env
~/.mcp-shell/state.json
~/.mcp-shell/shells.db
~/.mcp-shell/tool-logs/history.db
~/.mcp-shell/tool-logs/payloads/
~/.mcp-shell/bin/
```

Tool history metadata is indexed in `history.db`; complete inputs, outputs, and errors remain gzip-compressed under date-sharded `payloads/` directories. **`history.db` also contains durable latest Shell activity:** deleting the database or the entire `tool-logs/` directory removes activity continuity across restarts, not just tool history. Normal `TOOL_LOG_MAX_CALLS` eviction preserves that activity state. Existing legacy tool-log payloads are imported automatically on first startup after upgrading. Malformed legacy payloads are moved to `~/.mcp-shell/tool-logs/legacy-rejected/` and diagnosed instead of being retried on every restart.

`~/.mcp-shell/bin/` is the user command-override layer and is placed ahead of the repository's own `bin/` directory in `PATH`.

## Search guardrails

The bundled wrappers for `rg`, `grep`, `find`, and `fd` impose a short search timeout to prevent accidental expensive filesystem-wide scans.

If a broad search is genuinely required, pass:

```text
--unsafe
```

The wrapper consumes this flag and runs the underlying command without the search budget.

## Development

Start the TypeScript server watcher and Vite together:

```bash
npm run dev
```

`npm run dev` starts the server first, reads the actual listen address it reports, then starts Vite with that origin as the `/api/*` proxy target. `PORT` therefore has one authority: the mcp-shell server configuration. Browser code itself always uses the same relative API URLs in development and production.

`npm run dev:web` is intentionally a lower-level command. When used directly, set `MCP_SHELL_DEV_API_ORIGIN` explicitly; normal development should use `npm run dev`.

Run tests:

```bash
npm test
```

Run TypeScript checks:

```bash
npm run typecheck
```

Build both production targets:

```bash
npm run build
```

Run the complete repository verification gate before committing or deploying:

```bash
npm run verify
```

This runs server/Web type checks, server/Web tests, the Web dependency-boundary check, the production build, architecture-document validation, and whitespace validation.

## Project layout

```text
mcp-shell.ts       entry point
src/api/           versioned Observability API and read-only authentication
src/contracts/     shared API transport types
src/auth/          OAuth and token handling
src/http/          HTTP application
src/mcp/           MCP server and session handling
src/shell*.ts      durable Shell state and bootstrap
src/skills.ts      global skill discovery and loading
src/tools/         MCP tool implementations
src/observability/ tool-call logging and live activity
web/src/app/        React application composition and routing
web/src/features/   feature-owned browser behavior and UI
web/src/routes/     addressable Web Console pages
bin/               command wrappers
deploy/systemd/     repository-owned user-service lifecycle policy
scripts/            development and deployment helper commands
test/              automated tests
dist/              generated production build output
```

## License

ISC
