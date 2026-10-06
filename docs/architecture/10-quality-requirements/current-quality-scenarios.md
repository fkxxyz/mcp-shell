---
summary: "Defines observable security, correctness, operability, and maintainability scenarios for mcp-shell."
viewpoint: assurance
stakeholders:
  - architect
  - developer
  - operator
concerns:
  - security
  - correctness
  - operability
  - maintainability
activities:
  - orient
  - change
  - operate
  - assess
facets:
  domain:
    - whole-system
---

# Current Quality Scenarios

| Concern | Scenario | Required outcome |
|---|---|---|
| Security | An unauthenticated peer calls remote `/mcp`. | The request is rejected before MCP session handling. |
| Security | Local mode is selected. | The process listens only on loopback and does not expose a no-auth MCP listener on non-loopback interfaces. |
| Correctness | A sessionless non-initialize MCP POST arrives. | The request is rejected rather than creating an implicit session. |
| Correctness | An authorization code is replayed. | The replay is rejected after the code has been consumed. |
| Correctness | A refresh token is used successfully. | A new token pair is issued and the used refresh token cannot be used again. |
| Correctness | Two Shells are created for the same directory. | They receive distinct increasing IDs and retain independent identities. |
| Correctness | A Shell-aware tool receives an unknown `shell_id`. | The call is rejected rather than falling back to another working directory. |
| Correctness | `create_shell` finds a root `AGENTS.md`. | Its contents are appended to the returned bootstrap instructions; a missing file is accepted. |
| Correctness | Nested or symlinked `SKILL.md` files are reachable from `~/.agents/skills`. | Discovery follows them recursively, terminates cycles, and lists valid skills by frontmatter name and description without injecting skill bodies. |
| Correctness | Multiple valid skills declare the same `name`. | Deterministic sorted depth-first traversal makes the last valid discovery the winner, emits a diagnostic for the replacement, and does not let an invalid later file replace a valid earlier skill. |
| Correctness | A skill is malformed, unreadable, or missing required metadata. | That skill is diagnosed and skipped without preventing discovery of other skills or Shell creation. |
| Correctness | `skill` is called after its `SKILL.md` changes. | The current filesystem is rescanned and the latest valid contents are returned using exact case-sensitive name matching. |
| Operability | mcp-shell restarts after a Shell was created. | The existing `shell_id` still resolves to the persisted Shell root without loading the complete Shell history. |
| Operability | The process receives SIGINT or SIGTERM. | HTTP admission stops, active MCP transports are closed, and authorization state is persisted. |
| Operability | A repository-wrapped broad search exceeds its normal budget. | It is terminated near the configured wall-clock budget and explains how to narrow or explicitly bypass the guardrail. |
| Operability | A user has no public IP or server but has a supported local MCP client or trusted outbound tunnel. | No public mcp-shell listener or self-managed server is required. |
| Maintainability | Connection mode changes. | Changes remain localized to configuration, HTTP composition, listener selection, and tests; MCP session/tool implementations remain unchanged unless their own contracts change. |
| Maintainability | Skill discovery is used by both `create_shell` and `skill`. | One application-owned `SkillCatalog` is injected into both paths; tests can inject an isolated catalog rather than reading the operator's real skill tree. |
| Observability | Tool-log persistence fails after a successful host action. | The persistence error is visible on stderr while the tool result retains the host action's actual outcome. |

## Verification

Use automated tests for configuration, authorization state, HTTP routes, MCP session behavior, durable Shell behavior, recursive/symlinked skill discovery and lazy loading, command-path rules, search wrappers, and tool logging. Deployment-mode verification must include listener-address inspection, not only route-level tests.
