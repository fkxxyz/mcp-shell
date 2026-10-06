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

## Architectural Knowledge Has a Broad Manual Synchronization Radius

- **Root cause:** long-lived architecture rules are intentionally projected into several Views and operator/developer documents, but semantic authority versus audience-specific projection is not explicit enough. The same rule can therefore be restated as if several documents independently own it.
- **Primary cost dimension:** maintainability and maintained-knowledge coherence.
- **Current cost:** conceptual boundary changes require broad coordinated prose edits and create omission risk. Connection/resource-alias work previously touched many architecture Views plus README and AGENTS. The 2026-10-06 Web Console migration repeated the pattern across goals, context, strategy, decomposition, runtime, deployment, access control, observability, glossary, README, AGENTS, and a new ADR.
- **Evidence:** two unrelated architecture changes—connection/resource identity and the Web Console boundary—both produced large documentation synchronization sets even though each had a small number of governing rules.
- **Cost mechanism:** documents with distinct audiences also repeat normative current-state facts. Synchronization therefore relies on maintainer recall and broad search rather than a clear authority/projection relationship, so change radius grows faster than the number of actual decisions.
- **Reachable better state:** keep distinct Views where they provide local value, but make authority boundaries explicit: ADRs own decisions/rationale, cross-cutting concepts own enduring invariants, deployment/runtime Views own consequences in their dimensions, and README/AGENTS summarize or link rather than silently becoming competing semantic authorities.
- **Governing constraint:** each long-lived architecture rule has one identifiable semantic authority; other maintained documents may project consequences for their audience without redefining the rule.
- **Scope discovery:** for representative architecture changes, identify the governing ADR/concept first, then inspect derived Views, README/operator guidance, AGENTS guidance, glossary, quality scenarios, and other current-state projections that mention the rule.
- **Repair direction:** do not collapse documentation or generate prose mechanically. Incrementally replace duplicated normative wording with explicit ownership/cross-references when documents are next touched, and improve architecture navigation where it reduces search burden.
- **Exit criteria:** representative architecture changes can identify one semantic authority before editing, derived documents have clear projection roles, and changes no longer require reconciling multiple apparently authoritative definitions of the same rule.
- **Priority:** low; the synchronization cost is now demonstrated across multiple domains, but broad documentation restructuring would currently cost more than incremental convergence.

## Production Releases Lack an Atomic Artifact Switch

- **Root cause:** server and browser outputs form one logical release, but the current build writes `dist/web` and `dist/server` in place before the running service is restarted; there is no release-directory/staging boundary that makes the complete artifact set the unit of replacement.
- **Primary cost dimension:** operability and release reliability.
- **Current cost:** a failed or interrupted build can leave only part of the next release in `dist/`, and building while an existing service is live can temporarily expose browser assets that do not correspond to the running server. Recovery depends on rebuilding or manually restoring a known-good checkout/artifact set.
- **Evidence:** the Web Console architecture now intentionally defines frontend and backend as one release/deployment unit, while the repository build still performs separate in-place Vite and TypeScript output steps.
- **Cost mechanism:** release identity exists conceptually but not physically; mutable build destinations expose intermediate states and provide no natural rollback pointer.
- **Reachable better state:** build and verify a complete release in a staging/versioned directory, then atomically switch the service-visible release pointer (or equivalent deployment root) before restart, retaining at least the previous known-good release for bounded rollback.
- **Governing constraint:** production must observe either the complete previous release or the complete next release, never a partially constructed artifact set.
- **Scope discovery:** include npm build scripts, `dist` layout, systemd `ExecStart`/working directory, command-wrapper paths, Web static-root resolution, deployment/restart procedure, and rollback guidance before selecting the mechanism.
- **Repair direction:** design the smallest release-directory or atomic symlink/rename workflow that preserves the single-process deployment; do not introduce a separate frontend deployment system.
- **Exit criteria:** interrupted/failed builds cannot alter the currently served release, successful deployment switches all server/Web artifacts as one unit, and rollback to the immediately previous release is explicit and bounded.
- **Priority:** medium; failure probability is lower than day-to-day development costs, but the mismatch is now structural and affects every future production deployment.

## Pi Tool Dependency Chain Contains Known Production Vulnerabilities

- **Root cause:** the direct host-tool dependency `@earendil-works/pi-coding-agent@0.84.1` currently brings transitive versions with known security advisories, while the audit-recommended complete remediation crosses a breaking major-version boundary of the direct dependency.
- **Primary cost dimension:** security and upgrade risk.
- **Current cost:** `npm audit --omit=dev` reports three production vulnerabilities (one moderate, two high). The installed Pi dependency brings `brace-expansion@5.0.9` and `undici@8.9.0`; blindly applying the full audit fix would upgrade the Pi package to `1.0.4`, potentially changing host-tool behavior and adapters.
- **Evidence:** dependency inspection on 2026-10-06 showed `@earendil-works/pi-coding-agent@0.84.1 -> minimatch@10.2.5 -> brace-expansion@5.0.9` and `-> undici@8.9.0`. npm reports complete remediation via a breaking Pi upgrade.
- **Cost mechanism:** security exposure and remediation risk are coupled to a third-party package that supplies core file/shell tool behavior, so deferring assessment leaves uncertainty while forcing an upgrade without qualification risks semantic regressions in high-authority tools.
- **Reachable better state:** determine whether vulnerable paths are reachable in mcp-shell's actual Pi usage, identify whether safe transitive overrides or a non-breaking Pi release eliminate them, and otherwise perform a deliberate Pi major upgrade with focused tool-contract regression coverage.
- **Governing constraint:** known production dependency vulnerabilities on reachable paths must have either a supported remediation or an explicit, evidence-based risk disposition; host-tool core dependencies must not be force-upgraded without semantic validation.
- **Scope discovery:** inspect npm advisory paths, actual imported Pi capabilities, network/WebSocket use, glob/minimatch inputs, available patched transitive versions, Pi release notes/API changes, and existing basic-tool contract tests.
- **Repair direction:** perform reachability and upgrade assessment first. Prefer supported non-breaking remediation when possible; otherwise isolate the major upgrade as its own change and verify read/write/edit/bash semantics before adoption.
- **Exit criteria:** affected advisory paths are either removed/patched or documented as unreachable with evidence, `npm audit --omit=dev` no longer reports unaccepted reachable production vulnerabilities, and any Pi upgrade preserves the intended host-tool contracts.
- **Priority:** medium; severity is material, but actual reachability and safest remediation are not yet established.

## Shell History Grows Monotonically

Shell IDs are never reused and there is intentionally no list or close operation, so `shells.db` grows with created Shells.

Control: keep each Shell row compact and use indexed point lookup by ID so runtime cost does not scale with total history. Reassess retention only if persistent disk growth becomes material.
