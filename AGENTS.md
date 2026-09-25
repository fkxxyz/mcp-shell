# Project Overview

## Purpose

This repository contains a small, single-process remote MCP server intended as a ChatGPT connection demo. It combines OAuth-style authorization endpoints and an MCP Streamable HTTP endpoint in one TypeScript application.

The MCP server exposes Pi-compatible file and shell tools, a structured patch tool, and six LSP tools. Authorized callers can read and modify host files and execute arbitrary shell commands as the server process user. Treat access tokens as full host-user access.

## Architecture

- `mcp-server.ts` is a compatibility entry point that delegates to `src/main.ts`.
- `src/main.ts` is the composition root and process lifecycle entry point.
- `src/config.ts` loads and validates runtime configuration.
- `src/http/app.ts` assembles the Express application and owns application-level cleanup.
- `src/auth/` contains OAuth protocol logic, token state persistence, bearer middleware, and HTTP routes.
- `src/mcp/` contains MCP server construction, Streamable HTTP session management, and MCP routes.
- `src/tool-logs.ts` records complete tool inputs and outputs as one gzip payload per call under `~/.mcp-shell/tool-logs/`, with lightweight metadata in `index.jsonl`.
- `src/tools/` contains modular MCP registrations. `basic.ts` adapts Pi's built-in `read`, `write`, `edit`, and `bash` tools; `apply-patch.ts` and `lsp.ts` adapt Pi code-extension implementations.
- `@earendil-works/pi-coding-agent` supplies the built-in Pi tool implementations. MCP input schemas are declared locally with Zod.
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

Optional settings: `PORT` (defaults to `3000`), `TOOL_LOG_DIR` (defaults to `~/.mcp-shell/tool-logs`), and `TOOL_LOG_MAX_CALLS` (defaults to `10000`). Tool payload retention is count-based: once the payload count exceeds the configured maximum, the oldest complete call payloads are removed while `index.jsonl` remains append-only. The server listens on `0.0.0.0` and reports `${PUBLIC_BASE_URL}/mcp` as its MCP URL. A reverse proxy or equivalent public HTTPS ingress is expected when deployed remotely.

## Development

Install dependencies with `npm install`, then run the TypeScript entry point with:

```sh
npx tsx mcp-server.ts
```

There is no configured `start`, `build`, or automated test script in `package.json`; its `test` script intentionally exits with an error. No README or TypeScript project configuration is present at the time this document was written.

## Current Boundaries

- One configured OAuth client and one owner password; no user accounts or login sessions.
- OAuth behavior is a deliberately minimal implementation, not a general-purpose identity provider.
- Authorization grants the advertised `full` scope. Registered tools include arbitrary shell execution and file operations as the server process user; absolute paths are accepted by the Pi tools.
- LSP tools require compatible language servers and project LSP configuration. Rename applies returned workspace edits directly.
- Token state is shared through a local JSON file, not a database or distributed store. Multiple server instances are not coordinated.
- There is no configured automated test suite or documented deployment automation.
