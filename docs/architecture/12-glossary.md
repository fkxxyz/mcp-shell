---
summary: "Defines canonical mcp-shell terminology and distinctions used throughout the Architecture Description."
viewpoint: overview
stakeholders:
  - architect
  - developer
  - operator
concerns:
  - architecture-coherence
  - maintainability
activities:
  - orient
  - change
facets:
  domain:
    - whole-system
---

# Glossary

| Term | Meaning |
|---|---|
| mcp-shell | The TypeScript process in this repository that exposes host capabilities through MCP. |
| MCP client | A client capable of MCP initialization, session handling, and tool invocation. |
| Remote mode | Profile that binds all interfaces and requires built-in OAuth bearer authentication before `/mcp`. |
| Local mode | Profile that binds loopback only and serves `/mcp` without built-in OAuth. |
| Tunnel profile | Deployment arrangement in which a trusted tunnel client forwards remote MCP traffic to local- or remote-mode mcp-shell; not a separate mcp-shell mode. |
| Host authority | Filesystem, process, command, and other OS permissions inherited from the user running mcp-shell. |
| MCP session | A Streamable HTTP transport session identified by `mcp-session-id` and held in process memory. |
| Shell | A durable execution-state handle identified by integer `shell_id`. Its current state includes `cwd`; it survives MCP session and process lifetime and is not project identity. |
| OAuth state | Authorization codes, access tokens, and refresh tokens managed by the built-in remote-mode authorization service. |
| Tool log | Best-effort persisted record of a registered tool invocation, its input, output/error, timing, and available session/actor context. |
| Observability API | Versioned read-only JSON/SSE interface under `/api/v1/*`, intended for scripts, monitors, agents, and the bundled Web Console. |
| Observability authority | Read-only API authority. Remote access uses `OBSERVABILITY_TOKEN` Bearer and/or configured Web Basic credentials; it is distinct from MCP host-tool authority. |
| Web Console | Optional same-origin React application under `/console/*`, enabled by `WEB_PASSWORD` and consuming the Observability API. |
| Web authority | HTTP Basic-authenticated browser authority. It is read-only, is accepted by the Observability API, and never grants MCP host-tool authority. |
| Command wrapper | Repository executable placed early in PATH to alter default command behavior, such as bounding broad searches. |
| Guardrail | A mechanism intended to reduce accidental misuse or cost without being relied on as a hostile-caller security boundary. |
| Implementation convergence | The work of changing code and tests so they match an already accepted architecture decision. |
