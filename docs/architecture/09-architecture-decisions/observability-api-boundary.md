---
summary: "Defines the versioned read-only Observability API as a first-class product interface independent of the Web Console."
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
    - observability
---

# Observability API Boundary

## Decision State

Accepted and implemented architecture decision.

This decision supersedes the Web Console Application Boundary decision only where that older decision treated the API as a browser-owned, unversioned surface enabled exclusively by `WEB_PASSWORD`. The Web Console remains a first-class same-origin SPA and keeps its existing build/deployment boundary.

## Context

mcp-shell observability is no longer consumed only by its bundled Web Console. Operators need stable programmatic access from scripts, monitors, agents, and other clients without granting MCP host-tool authority or requiring the browser application to be enabled.

The earlier browser-only API boundary intentionally avoided versioning because frontend and backend shipped together. External programmatic consumers invalidate that premise: their release lifecycle and compatibility expectations are independent of the mcp-shell/Web Console release.

Current activity also cannot be a browser-only interpretation. A caller asking whether a Shell is active needs one authoritative answer rather than reproducing the activity window in every consumer.

## Decision

mcp-shell exposes a first-class, read-only Observability API under `/api/v1/*`.

The Web Console is one consumer of that API. It does not own a separate browser API and does not reimplement backend activity policy.

The initial v1 resources are:

    GET /api/v1/activity
    GET /api/v1/activity/stream
    GET /api/v1/shells?cwd=...
    GET /api/v1/shells/:shell_id/activity
    GET /api/v1/shells/:shell_id/session-activity
    GET /api/v1/shells/:shell_id/calls
    GET /api/v1/tool-calls/:call_id

`GET /api/v1/activity` supplies a pollable current snapshot. `GET /api/v1/activity/stream` supplies the same current model followed by lifecycle events over SSE. Shell activity is directly queryable and includes server-derived `active`, `active_until`, running-call count, last-event time, server time, and the active-window duration.

`GET /api/v1/shells/:shell_id/session-activity` accepts only a Shell ID and returns `shell_id`, `active`, `active_until`, and `server_time`. It aggregates directly associated client sessions' member Shells, using `(clientInfo.name, client_session_id)` as session identity. Shared Shells support many-to-many usage without recursively merging sessions. The existing Shell activity endpoint retains its own-Shell meaning. No member lists or client-supplied timing rules are required for a boolean activity check.

The API remains observation-only. It does not execute tools, mutate configuration, close Shells, delete logs, or inherit MCP authority.

## Activity Authority

The backend owns the active policy:

- a Shell/workspace with a running call is active regardless of elapsed time;
- otherwise it remains active until five minutes after its latest lifecycle event; and
- the exact deadline is inactive.

`activity-policy.ts` is the semantic authority. API responses expose `active_until` and `server_time` so clients can refresh presentation locally without knowing or duplicating the five-minute rule. **`active` and `active_until` are authoritative results; `active_window_ms` is informational policy metadata, not an instruction for clients to recompute activity.**

Running state is process-local. The latest completed Shell lifecycle event is persisted independently of count-retained complete call history, so `TOOL_LOG_MAX_CALLS`, recent-call UI bounds, restart, and history eviction do not redefine whether a Shell is active.

Client-session usage relationships have the same independent retention guarantee. `ActivityService` derives point activity from authoritative running-call IDs plus durable Shell times; activity state writes precede and are independent of full payload persistence. Payload setup/write failures preserve activity availability when the database remains usable. Activity state failures return `503 activity_unavailable`, with new SSE connections receiving the JSON error before stream headers and existing streams closing when unavailable state is detected. A running member yields a null aggregate deadline; otherwise the maximum member deadline applies. A known Shell with no recorded relationship yields false with a null deadline.

## Authentication and Exposure

The API reuses the application listener but has read-only credentials distinct from MCP host authority.

In remote mode:

- `OBSERVABILITY_TOKEN` enables Bearer access to `/api/v1/*`;
- configured `WEB_PASSWORD` Basic credentials are also accepted by `/api/v1/*` so the same-origin Web Console can consume the public contract;
- the API is not mounted when neither read credential is configured; and
- neither read credential is accepted by `/mcp`.

In local mode the API is mounted without an additional credential. Local mode already binds exclusively to `127.0.0.1` and exposes the more-powerful unauthenticated `/mcp` surface, so adding a weaker read-only credential on the same loopback listener would not create a meaningful security boundary.

Remote exposure assumes HTTPS at the ingress. The API remains same-origin by default and does not enable cross-origin access. JSON and SSE API responses use `Cache-Control: no-store`; they must not be cached as browser assets.

## Compatibility

`v1` is a compatibility contract for independently evolving consumers.

Compatible changes may add endpoints or additive response fields whose absence older consumers already tolerate. Removing or renaming fields, changing field types or identifier semantics, changing endpoint meaning, or requiring clients to reinterpret existing opaque cursors requires a new API version or an explicit compatibility migration.

Pagination cursors remain opaque. Timestamps use ISO-8601 UTC strings. Errors retain the JSON envelope:

    {
      "error": {
        "code": "...",
        "message": "..."
      }
    }

Black-box HTTP tests protect route, authentication, status-code, error-code, nullability, and core response-shape contracts rather than relying only on shared TypeScript types.

## Build and Deployment

No new process, listener, service, package, or frontend deployment is introduced.

Production still builds `dist/server/` and `dist/web/`, then runs the single compiled Node/Express process. The Observability API belongs to the server artifact and works headlessly when the Web Console is disabled. A Web build is required only when `WEB_PASSWORD` enables `/console/*`.

Development Vite may continue proxying the `/api` path prefix; application clients use the versioned `/api/v1/*` resources.

## Alternatives Rejected

### Extend the old unversioned browser API

Rejected because it would make external consumers depend on an interface whose original compatibility assumptions no longer hold.

### Give monitors MCP OAuth tokens

Rejected because MCP authorization grants host-tool authority far beyond read-only observability.

### Maintain separate internal Web and external monitoring APIs

Rejected because duplicate read models would drift. The Web Console should exercise the same contract external consumers use.

### Introduce a general API platform

Rejected. GraphQL, generated SDKs, API gateways, RBAC, separate API processes, and external databases do not solve a current requirement.

### Make the active window configurable now

Rejected until multiple windows are demonstrated as an operator requirement. One backend policy and explicit deadline fields keep the contract simple without baking client-side timing rules into consumers.

## Reassessment

Reassess this decision if:

- the API gains mutation authority;
- multiple users or credential scopes are required;
- cross-origin consumers must be supported directly;
- compatibility pressure justifies formal schema/code generation;
- one listener can no longer satisfy deployment isolation requirements; or
- SSE no longer satisfies required live-delivery semantics.
