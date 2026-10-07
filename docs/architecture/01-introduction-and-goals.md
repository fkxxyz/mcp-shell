---
summary: "Defines mcp-shell purpose, architecture drivers, quality priorities, scope, and non-goals."
viewpoint: overview
stakeholders:
  - architect
  - developer
  - operator
concerns:
  - architecture-coherence
  - security
  - operability
  - maintainability
activities:
  - orient
  - change
  - assess
facets:
  domain:
    - whole-system
---

# Introduction and Goals

## Purpose

`mcp-shell` gives a trusted MCP client controlled access to capabilities of the machine running the server: shell execution, file operations, structured patching, image inspection, and language-server operations.

The architectural security boundary is therefore not “an ordinary web API.” A successful authorization can exercise authority close to an interactive shell running as the server process user.

## Architecture Drivers

1. **Direct host utility.** MCP tools must act on the actual development host, its filesystem, commands, language servers, and project checkout.
2. **Explicit trust boundary.** Remote access must be authenticated; local access must not accidentally become network-wide unauthenticated access.
3. **Small deployment footprint.** The system is a single TypeScript process with local files for configuration, authorization state, and tool logs.
4. **Standard MCP transport.** Clients interact through MCP Streamable HTTP; session and tool behavior remain independent from how the endpoint becomes reachable.
5. **Inspectable host actions.** Tool calls are recorded without making logging failure block tool execution.
6. **Low-friction personal use.** Local connection mode lets a user avoid a public IP address or self-managed server when using mcp-shell from the same computer or through a trusted outbound tunnel.
7. **Evolvable operator interface.** An optional same-origin Web Console can grow beyond Activity without coupling browser structure to MCP, storage, or tool internals.

## Quality Priorities

In descending architectural importance:

1. host security and explicit authority;
2. correctness of MCP and authorization state transitions;
3. operability on a personal development machine;
4. maintainability of the small single-process design;
5. bounded guardrails for accidentally expensive host operations.

## Scope

In scope:

- one mcp-shell process on one host;
- MCP Streamable HTTP sessions;
- host-side tools registered in that process;
- remote OAuth-protected access;
- local loopback-only access;
- optional outbound tunneling from the local host to a trusted MCP client environment;
- local persisted OAuth state and observability history;
- a first-class versioned, read-only Observability API for scripts, monitors, agents, and the bundled UI; and
- an optional Basic-authenticated Web Console that consumes that API.

## Non-goals

- multi-tenant identity management;
- a general-purpose OAuth provider;
- distributed MCP session coordination;
- containment of an already-authorized shell caller as if it were untrusted code;
- browser mutation of host state without a separately reviewed authority model;
- cloud hosting as a requirement for personal use.

## Connection Modes

The repository implements both connection profiles defined by the architecture decision in chapter 09. `remote` retains the OAuth-protected all-interface deployment, while `local` binds only to loopback and serves `/mcp` without the built-in OAuth flow.
