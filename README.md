# mcp-shell

A remote MCP server that gives ChatGPT and other MCP clients controlled access to a host machine's shell, files, patching, image inspection, and LSP capabilities.

It is intended to make a trusted development machine directly usable by an MCP client over HTTPS.

## What it provides

- File operations: `read`, `write`, `edit`
- Shell execution: `bash`
- Structured patching: `apply_patch`
- Image inspection: `read_image`
- LSP support:
  - go to definition
  - find references
  - symbols
  - diagnostics
  - prepare rename
  - rename
- OAuth-style authorization with PKCE
- Streamable HTTP MCP transport
- Persistent token state
- Tool-call logging
- Guardrails for broad filesystem searches

## Security

`mcp-shell` is intentionally powerful.

An authorized client can read and modify files and execute commands with the permissions of the user running the server. In practice, access to this MCP endpoint should be treated similarly to remote shell access.

Use it only behind HTTPS, protect the OAuth credentials, and expose it only to clients you trust.

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

Required values:

```env
PUBLIC_BASE_URL=https://mcp-shell.example.com
OAUTH_CLIENT_ID=your-client-id
OAUTH_CLIENT_SECRET=your-client-secret
ADMIN_PASSWORD=your-password
```

Optional values include:

```env
PORT=3000
OAUTH_REDIRECT_URI=
OAUTH_REDIRECT_URI_ALLOWLIST=
TOOL_LOG_DIR=
TOOL_LOG_MAX_CALLS=10000
```

`PUBLIC_BASE_URL` must be the externally reachable HTTPS origin without a trailing slash.

## Run

```bash
npx tsx mcp-shell.ts
```

The MCP endpoint is exposed at:

```text
<PUBLIC_BASE_URL>/mcp
```

The server listens on `0.0.0.0` using `PORT`, which defaults to `3000`.

In a long-running deployment, run it under a service manager such as systemd and place a reverse proxy such as Traefik or nginx in front of it for HTTPS.

## Connect

An MCP client first discovers the OAuth metadata, completes authorization, and then connects to:

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

The current authorization model is intentionally simple: one configured OAuth client and one owner password.

## Local state

`mcp-shell` keeps its runtime state under:

```text
~/.mcp-shell/
```

Important files and directories include:

```text
~/.mcp-shell/env
~/.mcp-shell/state.json
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
src/tools/         MCP tool implementations
src/tool-logs.ts   tool-call logging
bin/               command wrappers
test/              automated tests
```

## License

ISC
