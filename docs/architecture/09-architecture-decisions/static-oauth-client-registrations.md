---
summary: "Records the static per-client OAuth registration model used by remote mcp-shell deployments."
viewpoint: decision
stakeholders:
  - architect
  - developer
  - operator
concerns:
  - architecture-coherence
  - correctness
  - maintainability
  - operability
  - rationale
  - security
activities:
  - orient
  - change
  - assess
  - decide
  - operate
facets:
  domain:
    - access-and-transport
---

# Static OAuth Client Registrations

## Decision State

Accepted and implemented architecture decision.

## Context

Remote mcp-shell grants callers the process user's full host authority. The earlier OAuth configuration accepted one client ID and secret, which forced unrelated MCP clients to share one registration and prevented per-client grant revocation. A general identity platform or user-account system is outside the intended single-owner deployment model.

OAuth clients also differ in credential handling. Hosted confidential clients can protect a secret; native/public clients cannot. Treating a public client ID as a secret would not authenticate the application.

## Decision

- Store a versioned, statically managed client list in `~/.mcp-shell/oauth-clients.yaml`, separate from the general server `env` file.
- Validate the complete YAML schema, unique client IDs, redirect rules, credential type, and owner-only file permissions before starting the listener.
- Bind authorization codes, access tokens, and refresh tokens to the registering client ID. Token exchange and refresh require the same client registration that owns the grant.
- Require PKCE S256 for both public and confidential clients. Public clients use token authentication method `none`; confidential clients use their configured client secret.
- Scope redirect rules to each registration. Exact URI matching is the default; explicit path prefixes are allowed only when a client requires them.
- Load registrations once at startup. Removing a registration and restarting prunes its pending codes and tokens. There is no management UI, hot reload, or dynamic client registration.
- Keep one owner password and one `full` tool-authority scope shared by all clients. Client registrations are not user accounts and do not grant separate tool permissions.
- Keep a deprecated single-client environment fallback only when the YAML file is absent. The fallback remains available until the operator creates the YAML file; it is not enforced as a one-start migration. Use the old client ID to migrate legacy unversioned token state; reject ambiguous migration rather than guessing.

## Alternatives Rejected

### One Shared Client Registration

Rejected because separately configured MCP clients would share credentials and could not be revoked independently.

### Dynamic Client Registration

Deferred because it requires a runtime registration protocol, persistence and lifecycle policy beyond the current low-frequency personal-host configuration need. Static registration does not support clients that require dynamic registration or cannot use a preconfigured client ID.

### Web-Based Client Management

Rejected for the initial implementation because it would add a privileged mutation surface, separate administrator-session and CSRF requirements, and runtime persistence without improving ordinary configuration safety.

### Per-Client Tool Permissions or User Accounts

Rejected because the current security principal is one host owner. Every registered caller remains equivalent to a remote shell user after owner approval.

## Consequences

- Operators maintain a separate `0600` YAML file and restart the service after registration changes. Until migration, the legacy environment fallback remains an alternate configuration path and logs a warning.
- Public client IDs identify a registration for grant binding and revocation, but do not prove the connecting software's identity. PKCE and owner approval remain required.
- Client secrets are loaded from the YAML file rather than copied into the process environment.
- OAuth state has a versioned schema. Legacy access/refresh tokens can be assigned only when the previous single-client ID is known.
- Discovery metadata advertises only token endpoint authentication methods represented by active registrations.
- Tests cover cross-client code/refresh isolation, public-client PKCE, removal-based revocation, config validation, file permissions, and legacy state migration.

## Reassessment

Reassess if target MCP clients require dynamic registration, if client-specific tool authority is needed, if the service becomes multi-user, or if static configuration changes become frequent enough to justify a separately secured management interface.
