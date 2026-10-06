---
summary: "Records residual host-authority risks and current architecture debt."
viewpoint: assurance
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
  - diagnose
  - operate
  - assess
  - decide
facets:
  domain:
    - whole-system
    - access-and-transport
    - host-tools
    - observability
---

# Current Architecture Risks and Technical Debt

## Authorized Host Compromise Is Inherent

An authorized MCP caller can execute shell commands and modify host files as the server user. OAuth, loopback binding, tunnel identity, annotations, wrappers, and logs reduce accidental or unauthorized use; they do not make an authorized malicious command safe.

Control: keep the trust boundary explicit and grant access only to clients and model workflows the operator accepts as having host-user authority.

## OAuth State Is Single-Process Local State

`state.json` is not a distributed coordination mechanism. Multiple instances can diverge or race independently.

Control: keep one-process deployment as an explicit constraint. Reassess before horizontal scaling.

## Tool Logs Contain Sensitive Payloads

Inputs and outputs may contain source code, file contents, command output, credentials accidentally printed by tools, or other local data.

Control: store logs under owner-controlled local paths with restrictive permissions and bounded payload retention; treat log access as sensitive.

## Tool-Log Metadata Has No Retirement Lifecycle

- **Root cause:** `index.jsonl` is append-only while payload retention independently deletes old `calls/*.json.gz` files; metadata has no rotation, archival, compaction, or retirement policy.
- **Primary cost dimension:** operability and long-term storage/diagnosis cost.
- **Current cost:** metadata grows for the lifetime of the installation, and old `file` fields increasingly refer to payloads that retention has already removed. Consumers must distinguish durable metadata from non-durable payload references.
- **Evidence:** on 2026-10-06, inspection found 27,674 index entries, 10,000 retained payloads, and 17,674 index references whose payloads had already been pruned.
- **Cost mechanism:** every tool call permanently adds metadata while no normal lifecycle removes or archives old metadata, so storage and scan cost grow with total historical call count rather than configured retention.
- **Reachable better state:** define an explicit metadata lifecycle, such as bounded/rotated segments with optional compressed archival, while preserving whatever historical fields operators actually need.
- **Governing constraint:** every persisted tool-log representation must have an explicit retention or archival policy; references to optional payloads must have semantics that remain clear after payload retirement.
- **Scope discovery:** inspect `index.jsonl` writers, readers, operational guidance, configuration, and any future log-analysis tooling before choosing the lifecycle.
- **Repair direction:** decide the required metadata history window and access pattern first, then implement rotation/compaction or archival around that contract rather than coupling metadata blindly to payload count.
- **Exit criteria:** metadata growth is bounded or intentionally archived, old payload references have explicit semantics, and operators can state how metadata is created, retained, archived, and retired.
- **Priority:** medium; growth is already observable, but the correct retention semantics require an explicit product/operational decision.

## Payload-Retention Selection Cost Scales With Configured History

- **Root cause:** steady-state overflow handling finds the oldest retained payload with work proportional to the configured retained-payload count.
- **Primary cost dimension:** runtime efficiency.
- **Current cost:** at the default 10,000-call limit the in-memory work is small, but increasing `TOOL_LOG_MAX_CALLS` to obtain materially longer history also increases per-overflow CPU work linearly.
- **Evidence:** the observed workload retained roughly 10,000 payloads for only about 25 hours, creating a credible reason for operators to raise the configured limit substantially.
- **Cost mechanism:** retention history size and hot-path selection cost are coupled even though the user-facing requirement is only to evict the oldest payload.
- **Reachable better state:** use an ordered runtime structure only if measurement shows the linear scan becoming material, reducing oldest-selection/update cost without reintroducing filesystem scans.
- **Governing constraint:** normal retention enforcement should remain independent of filesystem directory size, and increasing legitimate history depth should not create disproportionate hot-path cost.
- **Scope discovery:** benchmark retention enforcement across realistic call rates and configured limits before changing the data structure; include concurrent completion behavior and restart rebuild cost.
- **Repair direction:** establish a performance threshold, then replace linear oldest selection with an ordered structure if that threshold is crossed.
- **Exit criteria:** either measurements show the current approach remains immaterial across supported retention sizes, or the selected structure keeps steady-state retention cost acceptably bounded.
- **Priority:** low-to-medium; credible scaling pressure exists, but current measurements do not yet justify extra data-structure complexity.

## Tool-Log Configuration Has More Than One Interpretation Boundary

- **Root cause:** server configuration knows about tool-log settings while the logging subsystem also reads and validates the corresponding environment variables directly.
- **Primary cost dimension:** maintainability and test isolation.
- **Current cost:** configuration semantics and logger lifecycle are partially implicit; tests mutate process-global environment state, and future configuration changes must keep multiple interpretation points aligned.
- **Evidence:** the retention work required deriving logger identity from `TOOL_LOG_DIR` and `TOOL_LOG_MAX_CALLS` inside the logging module while those settings are also represented in server configuration/template handling.
- **Cost mechanism:** one conceptual configuration rule has multiple maintained interpretation points instead of one resolved authority passed to consumers.
- **Reachable better state:** resolve and validate tool-log configuration once at the application configuration boundary and inject the resolved values into an owned logging/retention instance.
- **Governing constraint:** environment parsing and defaulting for one setting should have one authority; downstream components consume resolved configuration rather than reinterpret its source.
- **Scope discovery:** inspect configuration loading, application composition, logger construction/lifetime, tests, and deployment templates before moving ownership.
- **Repair direction:** perform this as a dedicated configuration-boundary refactor rather than coupling it to retention behavior changes.
- **Exit criteria:** tool-log settings are parsed/defaulted in one place, logging receives resolved configuration explicitly, and tests no longer require process-global environment mutation for logger behavior.
- **Priority:** low; the current system works, but the duplicated authority raises future change and testing cost.

## Search Wrappers Can Be Bypassed Deliberately

User overrides are higher precedence than repository wrappers and `--unsafe` disables the search budget.

Control: document wrappers as guardrails rather than security enforcement. Their purpose is to prevent accidental expensive scans, not to constrain an authorized shell caller.

## MCP Session State Is Ephemeral

Process restart ends all MCP sessions while durable Shell state and OAuth access tokens may survive in persisted state.

Control: clients must reinitialize MCP sessions after reconnect. Do not infer MCP session continuity from Shell or token continuity.

## Shell History Grows Monotonically

Shell IDs are never reused and there is intentionally no list or close operation, so `shells.db` grows with created Shells.

Control: keep each Shell row compact and use indexed point lookup by ID so runtime cost does not scale with total history. Reassess retention only if persistent disk growth becomes material.
