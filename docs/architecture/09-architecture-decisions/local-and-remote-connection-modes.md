---
summary: "Records the decision to support explicit local and remote connection modes while keeping one MCP runtime."
viewpoint: decision
stakeholders:
  - architect
  - developer
  - operator
concerns:
  - architecture-coherence
  - security
  - operability
  - maintainability
  - rationale
activities:
  - orient
  - change
  - assess
  - decide
facets:
  domain:
    - whole-system
    - access-and-transport
---

# Local and Remote Connection Modes

## Decision State

Accepted and implemented architecture decision.

## Context

The original deployment assumes a publicly reachable HTTPS endpoint, a reverse proxy or tunnel, OAuth client configuration, and a listener on `0.0.0.0`. That is appropriate for direct remote access but unnecessarily raises the entry cost for a person who wants to use the tools on their own computer and has no public IP address or server.

The MCP runtime itself does not require public exposure or OAuth. Those are connection concerns around the same `/mcp` transport.

## Decision

Introduce exactly two mcp-shell modes:

### `local`

- bind only to `127.0.0.1`;
- serve `/mcp` without the built-in OAuth flow on that path;
- do not require `PUBLIC_BASE_URL`, OAuth client credentials, or administrator password for MCP startup;
- support a same-machine MCP client directly;
- support a trusted outbound tunnel client that can reach loopback.

### `remote`

- bind to `0.0.0.0`;
- keep the existing OAuth discovery, authorization, token, bearer-validation, and `/mcp` behavior;
- require remote OAuth/public-base-url configuration;
- continue to expect HTTPS ingress when reachable over untrusted networks.

`MODE` is the configuration selector. Binding and authentication are consequences of the selected mode, not independently combinable policy knobs.

## Why Two Modes Instead of Independent Flags

The unsafe state to exclude is:

```text
0.0.0.0 + no authentication
```

If `BIND_HOST` and `AUTH_MODE` are independently configurable, the architecture makes that state representable and relies on defensive validation. A single mode captures the intended deployment invariants directly and keeps the configuration surface smaller.

## Why Tunnel Is Not a Third Mode

A trusted outbound tunnel changes reachability, not mcp-shell semantics. Treating it as another server mode would couple mcp-shell to one tunnel provider and duplicate authentication concepts.

The common personal-host path tunnels `local` mode so the tunnel client can connect to `127.0.0.1:<PORT>/mcp` while preserving the loopback boundary. If one mcp-shell instance must also serve other network clients behind its own OAuth boundary, the tunnel may target `remote` mode instead. In that case the built-in OAuth flow remains authoritative.

An intermediary may present a canonical OAuth resource identifier different from `PUBLIC_BASE_URL`. Remote mode therefore supports explicit `OAUTH_RESOURCE_ALIASES` as equivalent identifiers for the same protected resource. This is configuration of the existing OAuth boundary, not a new mode or tunnel-provider integration.

## Alternatives Rejected

### Require a server or public IP for all users

Rejected because public infrastructure is not intrinsic to host-local MCP execution and creates unnecessary operational cost for personal use.

### Always keep OAuth enabled, including loopback

Rejected as the default local design because it adds configuration and callback complexity without materially strengthening the same-machine loopback boundary for the intended personal-host use case.

### Expose unauthenticated MCP on all interfaces and rely on the firewall

Rejected because it makes a dangerous host-level authority reachable beyond the process's intended trust boundary.

### Add `AUTH_MODE`, `BIND_HOST`, and tunnel-specific server modes immediately

Rejected because they broaden configuration beyond the observed need and permit incoherent combinations.

## Consequences

- `AppConfig` must represent mode-dependent configuration rather than require remote settings unconditionally.
- `src/http/app.ts` must compose OAuth only for remote mode.
- `src/main.ts` must choose loopback or all-interface binding from mode.
- Existing MCP session and tool modules should not change.
- Remote OAuth may accept explicitly configured equivalent resource identifiers without weakening resource binding.
- Tests must prove the local loopback/no-auth invariant and remote backward compatibility.
- Documentation and README must stop presenting public HTTPS as a universal requirement once implementation converges.

## Reassessment

Reassess if local clients require stronger per-user isolation, if mcp-shell becomes multi-user/multi-tenant, if equivalent resource aliases are insufficient because callers need ingress-specific audience isolation, or if additional deployment profiles cannot be expressed without weakening the mode invariants.
