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
- Optional live activity dashboard grouped by workspace
- Guardrails for broad filesystem searches

## Security

`mcp-shell` is intentionally powerful.

An authorized client can read and modify files and execute commands with the permissions of the user running the server. In practice, access to this MCP endpoint should be treated similarly to remote shell access.

In `local` mode, the server binds only to `127.0.0.1`; treat any tunnel forwarding that endpoint as part of the trusted boundary. In `remote` mode, use HTTPS ingress, protect the OAuth credentials, and expose it only to clients you trust.

## Requirements

- Node.js
- npm
- A reachable HTTPS endpoint when used remotely
- Language servers installed locally if LSP tools are needed

## Install

```bash
npm install
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
ACTIVITY_PASSWORD=
```

In remote mode, `PUBLIC_BASE_URL` must be the externally reachable HTTPS origin without a trailing slash.

If a trusted ingress or tunnel presents a different canonical OAuth resource identifier for the same mcp-shell, set `OAUTH_RESOURCE_ALIASES` to a comma-separated list of exact HTTPS identifiers:

```env
OAUTH_RESOURCE_ALIASES=https://tunnel.example.com/v1/mcp/example
```

Aliases are equivalent names for the same protected MCP resource, not separate authorization domains. Only explicitly configured aliases are accepted, and the same resource policy is enforced during authorization, code exchange, refresh, and bearer validation. Alias entries must be HTTPS URLs without credentials or fragments.

The simplest tunnel deployment can still use `MODE=local` with no built-in OAuth. Use remote mode plus resource aliases when the tunneled endpoint must retain mcp-shell OAuth, such as when the same instance also serves other authenticated network clients.

## Run

```bash
npx tsx mcp-shell.ts
```

In local mode, the MCP endpoint is:

```text
http://127.0.0.1:<PORT>/mcp
```

In remote mode, the MCP endpoint is `<PUBLIC_BASE_URL>/mcp` and the server listens on `0.0.0.0`. `PORT` defaults to `3000` in both modes.

For long-running remote deployment, run it under a service manager such as systemd and place a reverse proxy such as Traefik or nginx in front of it for HTTPS.

### Activity dashboard

Set `ACTIVITY_PASSWORD` to enable the read-only activity UI:

```text
<base-url>/activity/
```

Use HTTP Basic Auth username `activity` and the configured password. The activity credential is separate from MCP OAuth and is never accepted by `/mcp`. Remote use requires HTTPS. The dashboard groups tool activity by Shell root directory, shows live calls through SSE, and loads full tool input/output only when a call is opened.

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
~/.mcp-shell/tool-logs/
~/.mcp-shell/bin/
```

`~/.mcp-shell/bin/` is the user command-override layer and is placed ahead of the repository's own `bin/` directory in `PATH`.

## Search guardrails

The bundled wrappers for `rg`, `grep`, `find`, and `fd` impose a short search timeout to prevent accidental expensive filesystem-wide scans.

If a broad search is genuinely required, pass:

```text
--unsafe
```

The wrapper consumes this flag and runs the underlying command without the search budget.

## Development

Run tests:

```bash
npm test
```

Run TypeScript checks:

```bash
npm run typecheck
```

## Project layout

```text
mcp-shell.ts       entry point
src/auth/          OAuth and token handling
src/http/          HTTP application
src/mcp/           MCP server and session handling
src/shell*.ts      durable Shell state and bootstrap
src/skills.ts      global skill discovery and loading
src/tools/         MCP tool implementations
src/observability/ tool-call logging and live activity
web/               static activity dashboard
bin/               command wrappers
test/              automated tests
```

## License

ISC
