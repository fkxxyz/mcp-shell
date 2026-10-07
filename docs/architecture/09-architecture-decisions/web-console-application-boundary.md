---
summary: "Records the Web Console as a first-class same-origin SPA with explicit UI, authentication, build, and future-mutation boundaries."
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

# Web Console Application Boundary

## Decision State

Accepted and implemented architecture decision.

The later **Observability API Boundary** decision supersedes this ADR's former browser-owned API decisions. This ADR is authoritative **only** for the Web Console SPA, its Basic-authenticated `/console/*` surface, frontend stack, and single-process build/deployment model. The versioned API, its authentication, and its compatibility contract belong exclusively to the Observability API Boundary decision.

## Context

The original browser surface was a small static Activity dashboard implemented with HTML, CSS, and browser JavaScript under `/activity/*`. That was appropriate while the browser had one narrow read-only interaction model.

The browser is now expected to grow into a durable operator application rather than remain one dashboard. Continuing to make Activity own the browser namespace, authentication name, static-resource tree, and all future navigation would make the first feature accidentally define the whole product boundary.

At the same time, mcp-shell remains a personal-host, single-process system. A separate frontend service, server-side rendering stack, generalized API platform, or browser mutation authority is not justified by this change.

## Decision

Introduce a first-class **Web Console** with these boundaries:

- `/console/*` is the browser SPA namespace.
- The Web Console consumes the Observability API governed by the **Observability API Boundary** decision; it does not own a separate browser API.
- `WEB_PASSWORD` enables `/console/*`; when absent, the browser application is not mounted.
- When the Web surface is enabled, `GET /` is a non-cacheable `302` convenience redirect to `/console/`; it is not part of the authenticated Web authority and remains absent when the Web surface is disabled.
- The fixed Web Basic username remains `activity`; `WEB_PASSWORD` defines the browser authority. API credential acceptance belongs to the Observability API Boundary decision.
- Web credentials are never accepted by `/mcp`, and MCP bearer credentials are not exposed to browser code.
- The current Web authority is read-only observation. It can query Shell/log facts and subscribe to Activity events but cannot execute tools, mutate configuration, delete logs, or manage Shell lifecycle.

Activity is the first Web Console feature, not the Web Console identity. API path/version, external-consumer compatibility, and read-only API authentication are governed by the Observability API Boundary ADR.

## Frontend Stack

The Web Console is a client-rendered SPA using:

- React + TypeScript for UI composition;
- Vite for development and production asset builds;
- TanStack Router for typed, addressable navigation;
- TanStack Query for request/caching/pagination state;
- native `EventSource` for the one-way live Activity feed; and
- CSS Modules plus CSS custom properties for local styles and shared design tokens.

The Activity ordering model remains framework-independent TypeScript. React observes that model rather than reimplementing ACTIVE/EARLIER lifecycle rules in component-local state.

TanStack Query owns request-derived server state. SSE events update the live Activity projection; completed Shell-scoped events invalidate affected history queries instead of manually reproducing backend history updates inside Query caches.

User state that should survive refresh, browser back/forward, or copied links belongs in routes/search parameters rather than hidden component state. Shell and tool-call details therefore have addressable routes.

## Why SPA, Not a Full-Stack React Framework

The browser has no SEO requirement and all authoritative data already belongs to the existing Express process. SSR, React Server Components, a second application server, GraphQL, and framework-owned server functions would duplicate an existing backend boundary without solving a current problem.

The production process remains Express. Vite is a build/development tool and is not a production runtime dependency.

## Build and Deployment

Development uses two loopback processes behind one developer command:

- the TypeScript server; and
- Vite, which proxies `/api/*` to the server.

The server configuration remains the single authority for its development port. The developer command starts the server first and derives Vite's proxy origin from the actual listen address reported by that process; Vite does not maintain a second default port value. Browser code always uses same-origin relative URLs. Development proxying is tooling, not an application topology.

Production build creates:

- `dist/server/`: compiled Node server code and repository command wrappers; and
- `dist/web/`: the Vite SPA with content-hashed assets.

Production starts `node dist/server/mcp-shell.js`. Express serves `dist/web` under `/console`. The frontend is not independently deployed.

When `WEB_PASSWORD` is configured in production, a missing Web build is a startup error rather than a partially working deployment.

SPA fallback applies only inside `/console`. Missing `/console/assets/*` files remain 404; API, MCP, and OAuth paths never fall through to `index.html`.

The application root is only a browser-discovery entry point. It redirects to `/console/` rather than hosting the SPA itself, preserving the explicit Web namespace and avoiding deployment-specific redirect rules in reverse proxies.

The HTML shell is `Cache-Control: no-store`. Content-hashed Vite assets may be cached as immutable for one year. API cache policy belongs to the Observability API Boundary.

## Security Consequences

The existing restrictive same-origin CSP remains required. Browser-visible tool-controlled text is rendered as text, not interpreted markup.

HTTP Basic remains intentionally simple. Public Web Console access requires HTTPS; brute-force/rate controls remain an ingress responsibility.

A future feature that introduces any Web mutation is a mandatory architecture reassessment point. Before the first unsafe method is added, define the browser mutation model, including same-origin/CSRF protection, destructive confirmation where appropriate, audit semantics, idempotency needs, and whether the existing single Web credential still represents an acceptable authority.

## Alternatives Rejected

### Keep growing the Vanilla Activity dashboard

Rejected because the future browser is an application with durable routing, multiple features, server-state caching, and reusable interaction patterns. Deferring the boundary change would turn a small migration into a later rewrite.

### Separate frontend deployment

Rejected because it adds deployment/version coordination while the browser and API are intentionally one release and one origin.

### Next.js, TanStack Start, or another SSR/full-stack framework

Rejected because mcp-shell already has the authoritative Node/Express backend and does not need SSR.

### Redux/Zustand as an application-wide store

Rejected until client-owned state actually requires it. URL state, TanStack Query server state, and the narrow Activity live model cover current needs.

## Reassessment

Reassess this decision if:

- the Web Console gains mutation authority;
- frontend/backend release lifecycles become independent;
- SSR provides a demonstrated user benefit;
- SSE is no longer sufficient for required bidirectional/live semantics; or
- client-owned state grows beyond route state plus localized feature models.
