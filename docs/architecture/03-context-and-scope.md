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
| Operator | Configures and starts mcp-shell, decides which clients are trusted, and may inspect host-tool activity through the Web Console. |
| HTTPS ingress / reverse proxy | Optional remote-profile infrastructure that terminates or forwards public HTTPS traffic. |
| Trusted outbound tunnel | Optional infrastructure that originates from the host and forwards MCP traffic to a local- or remote-mode endpoint without requiring inbound reachability. |
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

No public listener on the host is required in this common local-mode profile. Tunnel identity and workspace permissions belong to the tunnel provider; mcp-shell still owns host-tool behavior and the loopback-only invariant.

When the same mcp-shell must retain application-layer OAuth for other network clients, the tunnel may instead target a remote-mode endpoint. That keeps mcp-shell bearer enforcement in the request path; it does not create a third connection mode.

## Authority Boundary

An MCP session is not a sandbox. Once a trusted caller can invoke `bash`, `write`, `edit`, `apply_patch`, or rename operations, the effective authority is the process user's authority on the host.

### Web Console

```text
operator browser
   |
   | HTTPS / HTTP Basic
   v
/console/* + /api/*
   |
   v
read-only observability authority
```

The Web Console is a separate authority from MCP. Its credential permits only the mounted browser/API read surface; it is never accepted by `/mcp`. The current Web API exposes observation only. Introducing browser-originated mutation requires a separate security reassessment rather than inheriting the read-only Basic-auth boundary by default.
