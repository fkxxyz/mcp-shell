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

The activity browser is a separate authority surface on the same listener. `/activity/*` uses HTTP Basic authentication with an activity-specific password and grants read-only access to observability data. Activity credentials are not accepted by `/mcp`, and the browser does not receive an MCP bearer token.

Application-local brute-force tracking is not part of this boundary. Public-edge rate limiting or abuse controls belong to the upstream ingress. HTTPS remains mandatory for public activity access because HTTP Basic credentials otherwise cross the network in replayable form.

## Local Rule

The local no-OAuth profile is safe only under a stronger placement invariant: the server binds exclusively to `127.0.0.1`. Connection mode encodes this pair atomically rather than exposing independent “bind anywhere” and “disable auth” switches that can form an unsafe combination.

## Tunnel Rule

A tunnel does not widen mcp-shell's local listener. It carries MCP traffic through an authenticated provider-controlled path to the loopback service. The tunnel service's identity model does not change the authority of mcp-shell tools once a request reaches the local endpoint.

## Tool Annotations

MCP `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` describe tool behavior to clients. They are not enforcement controls against an authorized request.

## Command Wrappers

Pinned wrappers are resource/ergonomic guardrails. Because user overrides intentionally take precedence and authorized callers can invoke shell commands directly, command wrappers must not be treated as a security sandbox.

## Skill Instruction Trust

`~/.agents/skills` is an instruction source, not a filesystem confinement boundary. Skill discovery deliberately follows symlinks, including targets outside that directory, so any reachable valid `SKILL.md` is trusted as agent guidance. Operators must control the skill tree and its symlink targets accordingly. Cycle detection and physical-file deduplication protect traversal correctness, not instruction trust.

## Secrets and Logs

OAuth client secret, administrator password, access tokens, refresh tokens, activity password, and tool logs can expose significant authority or sensitive host content. They belong in owner-controlled local storage and must not be committed to the repository.

The activity password is independent from the MCP OAuth client secret and owner authorization password. Activity responses are not cacheable, cross-origin API access is not enabled, and untrusted tool content is rendered as text rather than executable markup.
