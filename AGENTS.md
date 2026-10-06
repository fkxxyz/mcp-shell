# Project Overview

## Purpose

This repository contains a small, single-process local-or-remote MCP server with an optional read-only Web Console. It combines MCP Streamable HTTP, mode-dependent OAuth, durable host-tool state, observability, and browser inspection in one Node application.

The MCP server exposes application-owned file and shell tools, a structured patch tool, and six LSP tools. Authorized callers can read and modify host files and execute arbitrary shell commands as the server process user. Treat access tokens as full host-user access.

## Architecture

- `mcp-shell.ts` is a compatibility entry point that delegates to `src/main.ts`.
- `src/main.ts` is the composition root and process lifecycle entry point.
- `src/config.ts` loads and validates runtime configuration.
- `src/http/app.ts` assembles the Express application and owns application-level cleanup.
- `src/auth/` contains OAuth protocol logic, token state persistence, bearer middleware, and HTTP routes.
- `src/mcp/` contains MCP server construction, Streamable HTTP session management, and MCP routes.
- `src/observability/` owns the unified tool-call lifecycle, gzip payload logging, lightweight `index.jsonl` metadata, bounded live activity projection, and activity read models.
- `src/contracts/` owns browser/server DTO shapes for the Web API without exposing backend implementation objects.
- `src/tools/` contains modular MCP registrations and tool implementations. `basic.ts` registers application-owned `read`, `write`, `edit`, and `bash` implementations under `src/tools/basic/`; `apply-patch.ts` and `lsp.ts` provide structured patching and language-server operations.
- `src/host/` contains narrow cross-tool host mechanisms for path resolution, structured file-mutation coordination, and supervised child-process lifecycle.
- `web/` is the React + TypeScript Web Console built by Vite. TanStack Router owns routes, TanStack Query owns request-derived server state, and the Activity feature keeps SSE/live ordering logic feature-local.
- Express handles HTTP routes and form/JSON parsing.
- `@modelcontextprotocol/sdk` implements the MCP server and Streamable HTTP transport.
- OAuth authorization codes, access tokens, and refresh tokens are held in memory and persisted to `~/.mcp-shell/state.json` using atomic rename. The config and state directory/files are created with restrictive permissions.
- MCP transports are kept in a process-local map keyed by MCP session ID. Restarting the process ends active sessions; persisted OAuth tokens can remain valid.

## Request Flow

1. A client reads the OAuth protected-resource and authorization-server metadata from the `/.well-known/` endpoints.
2. The client visits `GET /authorize`; the server validates the client, redirect URI, resource, and PKCE parameters, then displays a password form.
3. `POST /authorize` checks the single configured owner password and redirects back with a short-lived authorization code.
4. `POST /token` exchanges the code and PKCE verifier for a one-hour bearer access token and a refresh token. Refresh tokens rotate on use.
5. The client sends authenticated MCP requests to `/mcp`. The bearer token is checked before the request reaches the MCP transport.
6. MCP requests expose `read`, `write`, `edit`, `bash`, `apply_patch`, and six LSP tools.

## HTTP Endpoints

- `GET /.well-known/oauth-protected-resource`: protected resource metadata.
- `GET /.well-known/oauth-authorization-server`: authorization server metadata.
- `GET /authorize`, `POST /authorize`: authorization UI and authorization-code issuance.
- `POST /token`: authorization-code or refresh-token exchange.
- `POST /mcp`, `GET /mcp`, `DELETE /mcp`: authenticated MCP Streamable HTTP session operations.
- `GET /`: redirects to `/console/` when `WEB_PASSWORD` enables the Web surface; otherwise unmounted.
- `/console/*`: optional Basic-authenticated Web Console SPA when `WEB_PASSWORD` is configured.
- `/api/*`: optional Basic-authenticated, read-only browser JSON/SSE API enabled by the same `WEB_PASSWORD`.

## Configuration

Configuration file: `~/.mcp-shell/env`. On first start, the app creates a template and exits; replace placeholder secrets before restarting. Existing process environment variables override values from this file.

Required settings:

- `PUBLIC_BASE_URL`: externally reachable HTTPS base URL, without a trailing slash.
- `OAUTH_CLIENT_ID`: the single accepted OAuth client ID.
- `OAUTH_CLIENT_SECRET`: client secret used at the token endpoint.
- `ADMIN_PASSWORD`: password required for each authorization.

Redirect configuration:

- `OAUTH_REDIRECT_URI`: optional exact callback URI.
- `OAUTH_REDIRECT_URI_ALLOWLIST`: comma-separated callback rules. Bare entries and `exact:` entries match exactly; `prefix:` entries match by string prefix. Configure only trusted callback destinations.

OAuth resource identity:

- `PUBLIC_BASE_URL` is the primary protected-resource identifier.
- `OAUTH_RESOURCE_ALIASES` is an optional comma-separated list of exact HTTPS identifiers that name the same protected MCP resource, for example when a trusted ingress or tunnel presents another canonical resource URL. Aliases are equivalent names, not independent authorization domains, and are enforced through authorization, token exchange/refresh, and bearer validation.

Optional settings: `PORT` (defaults to `3000`), `OAUTH_RESOURCE_ALIASES`, `TOOL_LOG_DIR` (defaults to `~/.mcp-shell/tool-logs`), `TOOL_LOG_MAX_CALLS` (defaults to `10000`), and `WEB_PASSWORD`. Tool payload retention is count-based: once the payload count exceeds the configured maximum, the oldest complete call payloads are removed while `index.jsonl` remains append-only. `WEB_PASSWORD` enables both `/console/*` and `/api/*`; the fixed Basic Auth username is `activity`. The Web authority is currently read-only and is distinct from MCP authority. The server listens on `0.0.0.0` in remote mode and reports `${PUBLIC_BASE_URL}/mcp` as its MCP URL. A reverse proxy or equivalent public HTTPS ingress is expected when deployed remotely.

Command lookup uses a pinned PATH prefix. `~/.mcp-shell/bin` is always the first entry and is the user override layer; this repository's `bin/` directory is always second and is the repository default/guardrail layer. The remaining PATH follows afterward. The prefix is normalized again at child-process spawn boundaries so host-tool, LSP, or other environment rewriting cannot move those two entries behind another directory. User overrides intentionally take precedence over repository wrappers, so this mechanism is a customization and guardrail layer, not a security boundary against an authorized caller.

The repository command layer wraps `rg`, `find`, `fd`, and `grep` with a 200ms wall-clock search budget. Searches that exceed the budget are terminated and report `MCP_SEARCH_TIMEOUT`; output produced before termination remains visible. If a broad search is only needed because the required location or context is unknown, report that the available information is insufficient instead of forcing a filesystem-wide search. If a broad or slow search is genuinely required, rerun with the wrapper-only `--unsafe` argument anywhere in the arguments; the wrapper removes it before invoking the real command.

## Development

Install development dependencies with `npm install --include=dev`; this keeps the repository bootstrap independent of an inherited `NODE_ENV=production`. For development, run the server watcher and Vite together with:

```sh
npm run dev
```

`npm run dev` derives the Vite `/api/*` proxy target from the actual server listen address, so server `PORT` configuration remains the single development-port authority. Production uses compiled output from `npm run build`; direct execution uses `npm start`, while user-level systemd deployment uses the repository-owned template through `npm run service:install` and validates effective supervisor policy with `npm run service:check`. `npm run verify` is the canonical pre-commit/deployment verification gate and includes type checks, tests, Web dependency-boundary enforcement, production build, architecture validation, and whitespace validation. Project usage is documented in `README.md`.

## Current Boundaries

- One configured OAuth client and one owner password; no user accounts or login sessions.
- OAuth behavior is a deliberately minimal implementation, not a general-purpose identity provider.
- Authorization grants the advertised `full` scope. Registered tools include arbitrary shell execution and file operations as the server process user; Shell roots are relative-path bases rather than filesystem sandboxes, and absolute paths remain accepted.
- LSP tools require compatible language servers and project LSP configuration. Rename applies returned workspace edits directly.
- Token state is shared through a local JSON file, not a database or distributed store. Multiple server instances are not coordinated.
- The Web Console and backend are one repository, one release, one origin, and one production deployment unit; there is no independent frontend service or SSR layer.
- The browser API is read-only. The first Web mutation requires an explicit security reassessment rather than inheriting the current Basic-auth boundary automatically.
- User-level systemd lifecycle policy has a repository-owned install/check path, but production build artifacts are still updated in place rather than switched atomically as a release unit.
