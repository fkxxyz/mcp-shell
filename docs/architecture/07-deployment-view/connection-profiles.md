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

## Local Files and Permissions

The process uses `~/.mcp-shell/` for configuration, token state, user command overrides, and default tool logs. Configuration/state/log directories and sensitive state files are created with restrictive owner permissions where the implementation manages them.

`MCP_WORKDIR` defines the default workspace for host tools in every connection profile. It defaults to the current user's home directory and is resolved independently from the process launch directory. This keeps relative `bash`, file, patch, image, and LSP operations stable across direct launches, service managers, and tunnels.

## Lifecycle

One process owns all MCP sessions. Restart terminates sessions. Remote OAuth token state survives through `state.json`; local mode does not initialize or require OAuth state for MCP access.
