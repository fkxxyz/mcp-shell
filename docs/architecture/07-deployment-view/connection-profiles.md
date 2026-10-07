---
summary: "Defines the remote, loopback-local, and outbound-tunnel deployment profiles."
viewpoint: static
stakeholders:
  - architect
  - developer
  - operator
concerns:
  - architecture-coherence
  - security
  - operability
activities:
  - orient
  - change
  - operate
  - assess
facets:
  domain:
    - whole-system
    - access-and-transport
---

# Connection Profiles

## Remote

```text
Internet MCP client
      |
    HTTPS
      v
reverse proxy / ingress
      |
      v
0.0.0.0:<PORT> mcp-shell
      |
  OAuth-protected /mcp
      v
host tools
```

Remote mode binds to `0.0.0.0`, requires `PUBLIC_BASE_URL` and OAuth secrets, publishes OAuth discovery routes, and protects `/mcp` with bearer authentication.

The same listener may also serve the optional Web Console at `/console/*` and the independent read-only Observability API at `/api/v1/*`. `WEB_PASSWORD` enables the Console and its Basic credential is accepted by the API; `OBSERVABILITY_TOKEN` can enable Bearer API access without enabling the Console. The remote API is absent when neither read credential exists. Neither credential is accepted by `/mcp`. Public remote use assumes HTTPS at the ingress.

## Local

```text
local MCP client
      |
      v
127.0.0.1:<PORT> mcp-shell
      |
 unauthenticated /mcp
      v
host tools
```

The local profile supports clients on the same personal computer without public infrastructure. Its invariant is **loopback binding plus no OAuth**. It does not expose the no-auth endpoint on all interfaces.

The read-only `/api/v1/*` Observability API is also mounted without an additional credential in local mode. This follows the same loopback trust boundary already required for the more-powerful unauthenticated `/mcp` endpoint. The Web Console remains independently opt-in through `WEB_PASSWORD`.

## Local Through Trusted Outbound Tunnel

```text
ChatGPT / remote MCP client environment
      |
trusted tunnel service
      ^
      | outbound HTTPS
local tunnel client
      |
      v
127.0.0.1:<PORT>/mcp
      |
      v
mcp-shell host tools
```

The tunnel client runs on the same host or within the same trusted network boundary and initiates outbound connectivity. The host needs no public IP address, inbound firewall opening, reverse proxy, or TLS certificate for mcp-shell itself.

This is not a separate mcp-shell mode. It reuses `local` mode; tunnel identity and permission checks are owned by the tunnel provider.

## Remote Through Trusted Outbound Tunnel

```text
remote MCP client environment
      |
trusted tunnel service
      ^
      | outbound HTTPS
tunnel client
      |
      v
remote-mode mcp-shell
      |
 OAuth-protected /mcp
      v
host tools
```

Use this profile when the same mcp-shell must keep its own OAuth boundary, for example because other private-network clients also reach the remote-mode listener. The tunnel remains transport placement; it does not replace mcp-shell bearer authentication.

If the tunnel or another trusted intermediary presents a canonical OAuth resource identifier different from `PUBLIC_BASE_URL`, configure that exact HTTPS identifier in `OAUTH_RESOURCE_ALIASES`. The primary URL and aliases are equivalent identifiers for the same protected MCP resource. Unconfigured resource identifiers remain invalid throughout authorization, token refresh, and bearer validation.

## Local Files and Permissions

The process uses `~/.mcp-shell/` for configuration, token state, durable Shell state, user command overrides, and default tool history. Configuration/state/history directories and sensitive state files are created with restrictive owner permissions where the implementation manages them.

`~/.mcp-shell/shells.db` stores Shell IDs and their roots. Agents create Shells explicitly with absolute roots; subsequent relative operations are resolved from the selected Shell rather than the process launch directory.

`~/.mcp-shell/tool-logs/history.db` stores compact retained-history metadata and `~/.mcp-shell/tool-logs/payloads/` stores date-sharded gzip records. Tool-call payloads and activity metadata can contain host paths, commands, file content, outputs, and errors. They are therefore treated as sensitive owner data even though the activity HTTP surface is read-only.

## Lifecycle

One process owns all MCP sessions. Restart terminates MCP sessions, while durable Shell state survives through `shells.db`. Remote OAuth token state survives through `state.json`; local mode does not initialize or require OAuth state for MCP access.

For user-level systemd deployment, `deploy/systemd/mcp-shell.service.in` is the repository authority for service-manager policy. `npm run service:install` renders the current Node executable and `dist/server/mcp-shell.js` into the user unit under `XDG_CONFIG_HOME/systemd/user` or `~/.config/systemd/user`, then performs `systemctl --user daemon-reload`. It never builds, enables, starts, or restarts the service. Replacing an existing unmanaged unit requires the explicit `--replace-existing` option.

The unit does not set `WorkingDirectory`: production Web assets and repository command wrappers are located relative to compiled modules, while tool working directories come from durable Shell state. The unit also has no `network.target` ordering dependency because listener binding does not require external network readiness.

`KillMode=mixed` lets the initial `SIGTERM` reach the main process without immediately terminating tool descendants, preserving the application-owned three-second completion window. `TimeoutStopSec=15s` provides the final whole-cgroup failure bound. Installation validates the rendered unit with `systemd-analyze verify` before replacement. `npm run service:check` validates the installed executable paths and effective shutdown-critical systemd properties without treating recommended restart timing as a correctness invariant. The detailed shutdown ordering and readiness semantics live in `../08-cross-cutting-concepts/process-lifecycle.md`.

Production deployment builds before service installation or restart: Vite emits `dist/web/`, TypeScript emits `dist/server/`, and the service starts the compiled `dist/server/mcp-shell.js` from the checkout that ran `service:install`. That checkout is therefore the current deployment root and must not be moved or removed without reinstalling the service. The Web Console is not independently deployed or versioned from the backend. Building still updates `dist/` in place; atomic release switching remains a separate unresolved deployment concern.
