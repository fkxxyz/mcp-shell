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

## Million-Scale Payload Retention Exceeds the Current Retention Model

- **Root cause:** payload retention is still organized as one filesystem directory plus an in-memory filename set whose oldest-entry selection cost grows with retained payload count, while the supported configuration now permits million-call retention in actual operation.
- **Primary cost dimension:** runtime efficiency and operability.
- **Current cost:** the current deployment is configured with `TOOL_LOG_MAX_CALLS=1000000`. At that scale, restart must enumerate a very large payload directory, the process retains a very large filename set, and each overflow eviction performs work proportional to retained history to identify the oldest payload. The single-directory layout also inherits filesystem costs at very high file counts.
- **Evidence:** on 2026-10-06 the active operator configuration was verified at one million retained payloads. Earlier observed usage filled roughly 10,000 payloads in about 25 hours, so this scale increase reflects a real history requirement rather than a speculative setting.
- **Cost mechanism:** user-visible history depth, startup filesystem enumeration, steady-state oldest selection, memory used for retention bookkeeping, and single-directory file count all scale together even though only ordered oldest-first eviction is required.
- **Reachable better state:** retain the existing durable payload semantics while introducing a retention representation whose steady-state oldest selection is O(1) or O(log N), and evaluate directory sharding or another bounded filesystem layout using measured startup and filesystem behavior at supported retention sizes.
- **Governing constraint:** increasing legitimate payload history must not cause disproportionate per-call work or uncontrolled filesystem-directory scaling; steady-state retention must remain independent of rescanning the payload directory.
- **Scope discovery:** measure startup enumeration, retention-memory footprint, oldest-selection cost, concurrent out-of-order completion, and filesystem behavior across realistic retained counts up to the configured operational scale before choosing the replacement.
- **Repair direction:** treat selection structure and filesystem layout as one retention-model problem rather than patching individual slow paths. Preserve oldest-by-start-order semantics and the existing failure-isolation guarantees.
- **Exit criteria:** supported retention sizes have bounded steady-state eviction cost, acceptable restart cost and memory use, and a filesystem layout whose behavior has been validated at the declared scale.
- **Priority:** high; the deployment has already crossed from the original 10,000-call operating scale to one million retained payloads.

## Search Wrappers Can Be Bypassed Deliberately

User overrides are higher precedence than repository wrappers and `--unsafe` disables the search budget.

Control: document wrappers as guardrails rather than security enforcement. Their purpose is to prevent accidental expensive scans, not to constrain an authorized shell caller.

## Skill Traversal Scope Is Operator-Controlled

Skill discovery follows directory symlinks reachable from `~/.agents/skills`, including targets outside that root. A misconfigured link can therefore make one `create_shell` or `skill` call traverse a very large finite directory tree even though realpath cycle detection prevents infinite recursion.

Control: treat the reachable skill tree as operator-managed configuration and keep symlink targets scoped to intentional skill trees. No traversal budget, depth limit, watcher, or cache is introduced without evidence that normal skill trees make scan cost material.

## Skill Discovery Reads Complete Skill Bodies

- **Root cause:** metadata discovery and full `SKILL.md` body loading share one scan representation, so a candidate is read completely before the caller's actual content need is known.
- **Primary cost dimension:** runtime I/O and latency.
- **Current cost:** every `create_shell` and `skill` catalog scan reads complete reachable `SKILL.md` contents even though `create_shell` only needs `name` and `description`, while `skill` ultimately returns one winning body. The byte amplification is structurally clear, but no production latency measurement currently shows it is material.
- **Evidence:** the current Skill Catalog scan builds records containing full instructions for every valid discovered candidate before summary projection or exact-name selection.
- **Cost mechanism:** scan work scales with aggregate skill-body bytes across the reachable tree on every uncached operation rather than primarily with metadata plus the one body actually requested.
- **Reachable better state:** preserve the same recursive, symlink, validation, and deterministic last-wins semantics while separating lightweight candidate metadata/source discovery from full body loading; only the selected winning skill needs its complete body for `skill`.
- **Governing constraint:** skill summary discovery should not require retaining or reading unrelated complete instruction bodies when their size becomes a material cost, and optimization must not change discovery or conflict semantics.
- **Scope discovery:** include frontmatter parsing, candidate/source representation, `discover`, `load`, duplicate resolution, symlinked-file directory semantics, diagnostics, and their contract tests before changing I/O behavior.
- **Repair direction:** measure representative skill-tree sizes and call latency first. If full-body I/O is material, split metadata discovery from body loading with the smallest parser/read strategy that preserves the existing contracts rather than adding caching or watchers.
- **Exit criteria:** either evidence establishes that complete-body scan cost is immaterial across the supported operating range, or discovery no longer reads unrelated complete bodies and `skill` loads the full body only for the resolved winner while all current semantics remain covered.
- **Priority:** low; the scaling mechanism is credible and avoidable, but current materiality is unmeasured and an eager optimization would add parser/I/O complexity.

## MCP Session State Is Ephemeral

Process restart ends all MCP sessions while durable Shell state and OAuth access tokens may survive in persisted state.

Control: clients must reinitialize MCP sessions after reconnect. Do not infer MCP session continuity from Shell or token continuity.

## Connection Semantics Have a Broad Documentation Synchronization Radius

- **Root cause:** connection-mode, tunnel, and OAuth resource semantics are intentionally projected into several architecture views and operator-facing documents, but the boundary between authoritative definition and derived explanation is not explicit enough to prevent the same rule from being restated independently.
- **Primary cost dimension:** maintainability and maintained-knowledge coherence.
- **Current cost:** a single conceptual change to tunnel placement and OAuth resource aliases required coordinated edits across architecture constraints, context, solution strategy, building blocks, deployment, access control, the connection-mode decision record, quality scenarios, glossary, README, and agent guidance. Each edit is individually reasonable, but future changes can leave contradictory current-state claims if one projection is missed.
- **Evidence:** the 2026-10-06 resource-alias change changed one governing connection/authentication rule and required synchronized updates across multiple architecture Views plus README and AGENTS guidance.
- **Cost mechanism:** several documents can read as independent authorities for whether tunnels imply local mode, when remote OAuth remains active, and what resource aliases mean; synchronization relies primarily on maintainer recall rather than a clearly documented authority/projection relationship.
- **Reachable better state:** keep the distinct Views, but make authority boundaries explicit: the connection-mode ADR owns the mode decision and rationale, access-control owns security invariants, deployment owns topology, and other maintained documents summarize or reference those authorities without redefining the rule.
- **Governing constraint:** each long-lived connection/authentication rule has one clear semantic authority; other Views may project consequences for their audience but should not become competing definitions.
- **Scope discovery:** when connection or authentication semantics change, inspect the decision record, access-control concept, deployment view, architecture index/navigation, README/operator guidance, AGENTS guidance, glossary, constraints, quality scenarios, and any other current-state View that describes the same rule.
- **Repair direction:** do not collapse the architecture documentation or introduce generated prose. Incrementally reduce duplicated normative wording when these documents are next touched, and add explicit cross-references where they lower synchronization burden without harming local readability.
- **Exit criteria:** representative connection-policy changes can identify the authoritative rule first, derived Views have clear projection roles, and changing one rule no longer requires reconciling multiple apparently authoritative definitions.
- **Priority:** low; the synchronization cost is now observable, but the current Views serve distinct audiences and a broad documentation rewrite would cost more than the present burden.

## Shell History Grows Monotonically

Shell IDs are never reused and there is intentionally no list or close operation, so `shells.db` grows with created Shells.

Control: keep each Shell row compact and use indexed point lookup by ID so runtime cost does not scale with total history. Reassess retention only if persistent disk growth becomes material.
