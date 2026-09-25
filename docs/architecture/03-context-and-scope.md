---
summary: "Defines the mcp-shell black-box boundary, external actors, interfaces, and trust transitions."
viewpoint: overview
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
  - assess
facets:
  domain:
    - whole-system
    - access-and-transport
---

# Context and Scope

## System Boundary

`mcp-shell` is the process that accepts MCP requests and turns them into actions on the host machine. Reverse proxies, public tunnel providers, OpenAI-managed tunnel infrastructure, ChatGPT, Codex, shells, language servers, and the host operating system are external to this process.

## External Actors and Systems

| Actor / system | Relationship |
|---|---|
| MCP client | Discovers or connects to mcp-shell and invokes registered tools. |
| Operator | Configures and starts mcp-shell and decides which clients are trusted. |
| HTTPS ingress / reverse proxy | Optional remote-profile infrastructure that terminates or forwards public HTTPS traffic. |
| Trusted outbound tunnel | Optional local-profile infrastructure that originates from the host and forwards MCP traffic without requiring inbound reachability. |
| Host filesystem and commands | Resources acted on by file, patch, shell, image, and language tooling. |
| Language servers | Optional host processes required by LSP tools. |

## Trust Boundaries

### Remote profile

```text
MCP client
   |
   | HTTPS / OAuth
   v
public ingress
   |
   v
mcp-shell /mcp
   |
   v
host authority
```

Crossing the bearer-authentication boundary changes the caller from an unauthenticated network peer into a principal able to invoke host-powerful MCP tools.

### Local profile

```text
local MCP client
   |
   | loopback only
   v
127.0.0.1:mcp-shell
   |
   v
host authority
```

The loopback binding is the network exposure control when OAuth is disabled.

### Tunnel use

```text
remote MCP client environment
   |
trusted tunnel service
   ^
   | outbound HTTPS initiated by host
[tunnel client] -> 127.0.0.1:mcp-shell
```

No public listener on the host is required. Tunnel identity and workspace permissions belong to the tunnel provider; mcp-shell still owns host-tool behavior and the loopback-only invariant.

## Authority Boundary

An MCP session is not a sandbox. Once a trusted caller can invoke `bash`, `write`, `edit`, `apply_patch`, or rename operations, the effective authority is the process user's authority on the host.
