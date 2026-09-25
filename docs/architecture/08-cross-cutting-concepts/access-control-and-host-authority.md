---
summary: "Defines shared rules for authentication, network exposure, tool authority, and security interpretation."
viewpoint: static
stakeholders:
  - architect
  - developer
  - operator
concerns:
  - security
  - correctness
activities:
  - orient
  - change
  - operate
  - assess
facets:
  domain:
    - access-and-transport
    - host-tools
---

# Access Control and Host Authority

## Core Security Model

The meaningful protected asset is the process user's host authority, not merely MCP metadata. Any mechanism that admits a caller to destructive tools must therefore be evaluated similarly to remote shell access.

## Remote Rule

A network-reachable mcp-shell endpoint requires authentication before MCP requests reach session handling. The current implementation uses bearer tokens issued by its built-in OAuth flow.

## Local Rule

The local no-OAuth profile is safe only under a stronger placement invariant: the server binds exclusively to `127.0.0.1`. Connection mode encodes this pair atomically rather than exposing independent “bind anywhere” and “disable auth” switches that can form an unsafe combination.

## Tunnel Rule

A tunnel does not widen mcp-shell's local listener. It carries MCP traffic through an authenticated provider-controlled path to the loopback service. The tunnel service's identity model does not change the authority of mcp-shell tools once a request reaches the local endpoint.

## Tool Annotations

MCP `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` describe tool behavior to clients. They are not enforcement controls against an authorized request.

## Command Wrappers

Pinned wrappers are resource/ergonomic guardrails. Because user overrides intentionally take precedence and authorized callers can invoke shell commands directly, command wrappers must not be treated as a security sandbox.

## Secrets and Logs

OAuth client secret, administrator password, access tokens, refresh tokens, and tool logs can expose significant authority or sensitive host content. They belong in owner-controlled local storage and must not be committed to the repository.
