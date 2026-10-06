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
- **Current cost:** metadata grows for the lifetime of the installation, and old `file` fields increasingly refer to payloads that retention has already removed. Consumers must distinguish durable metadata from non-durable payload references. Input previews are intentionally excluded from this permanent metadata, so Activity summaries restored after restart can lose their function-style arguments even while a retained payload still contains the complete input.
- **Evidence:** on 2026-10-06, inspection found 27,674 index entries, 10,000 retained payloads, and 17,674 index references whose payloads had already been pruned.
- **Cost mechanism:** every tool call permanently adds metadata while no normal lifecycle removes or archives old metadata, so storage and scan cost grow with total historical call count rather than configured retention.
- **Reachable better state:** define an explicit metadata lifecycle, such as bounded/rotated segments with optional compressed archival, while preserving whatever historical fields operators actually need. Once input-derived summary data has retention aligned with the intended Activity history window, bounded previews can persist across restart without outliving their source-data policy.
- **Governing constraint:** every persisted tool-log representation must have an explicit retention or archival policy; references to optional payloads must have semantics that remain clear after payload retirement.
- **Scope discovery:** inspect `index.jsonl` writers, readers, operational guidance, configuration, and any future log-analysis tooling before choosing the lifecycle.
- **Repair direction:** decide the required metadata history window and access pattern first, then implement rotation/compaction or archival around that contract rather than coupling metadata blindly to payload count.
- **Exit criteria:** metadata growth is bounded or intentionally archived, old payload references have explicit semantics, operators can state how metadata is created, retained, archived, and retired, and Activity summary fields that need restart continuity have a retention policy compatible with the payload data they summarize.
- **Priority:** medium; growth is already observable, but the correct retention semantics require an explicit product/operational decision.

## Activity Lifecycle Projections Are Coupled to Call-Retention Windows

- **Root cause:** lifecycle facts that need time- or state-based completeness are derived from call collections bounded for different recency/history purposes. Activity snapshot `recent_shells` is reconstructed from the globally bounded completed-call window plus current running calls, while the browser's per-Shell live overlay is reconstructed from the per-workspace bounded `recent_calls` window.
- **Primary cost dimension:** observability correctness and scaling.
- **Current cost:** under unusually high call volume, a Shell whose last lifecycle event is still inside the ten-minute ACTIVE window can disappear from the supporting projection if its call is evicted from global in-memory history, causing the browser to undercount active Shells. Separately, a Shell detail page can omit some currently running calls after initial snapshot/reconnect when one workspace has more concurrent/recent calls than the bounded `recent_calls` projection retains. Snapshot size also scales according to retention structures whose bounds were chosen for other semantics. No current production evidence shows these divergences are material.
- **Evidence:** the Activity wall needs distinct active-Shell counts without one Shell-inventory request per workspace, so `recent_shells` is derived from ActivityTracker's bounded completed/running state. Shell detail now composes completed HTTP history with a live per-Shell projection derived from the Activity snapshot's bounded workspace `recent_calls`; this provides low-cost realtime UX but exposes the same semantic coupling from another consumer.
- **Cost mechanism:** recency/history retention policies are serving lifecycle-presence and live-completeness semantics. When call-rate pressure retires facts faster than elapsed-time or running-state pressure should, the derived lifecycle projection can become incomplete even though the underlying lifecycle is still active.
- **Reachable better state:** if measurements show material divergence or snapshot cost, keep lifecycle-complete state bounded by its own semantics: retain current running calls until finish, and retain per-Shell activity until it leaves the active window, while keeping bounded recent completed calls and durable history as separate authorities.
- **Governing constraint:** lifecycle facts advertised as current or active must not lose completeness because an unrelated recent-history or global-retention window fills first; each supporting projection should be bounded by the semantics it serves.
- **Scope discovery:** include ActivityTracker retention and startup bootstrap, per-workspace recent-call bounds, SSE snapshot serialization, ActivityStore Shell projections, Shell detail live/history composition, active-Shell expiry, restart/reconnect semantics, global-history configuration, and UI consumers before changing projection ownership.
- **Repair direction:** first measure peak concurrent/rate-driven calls per workspace, distinct Shells per active window, snapshot size, and any observed omissions. Do not add new lifecycle maps merely because the coupling exists. If material, split running-call and active-Shell lifecycle projections at the existing ActivityTracker control point instead of adding browser reconciliation rules.
- **Exit criteria:** either measurements demonstrate that existing bounds safely dominate supported lifecycle workloads with acceptable snapshot size, or running-call/live-Shell completeness and active-Shell presence are independently bounded by lifecycle semantics and remain correct under recent/global history eviction.
- **Priority:** low; two consumers now expose the same structural coupling, increasing confidence in the root cause, but material user impact is still unmeasured and eager repair would add state and expiry complexity.

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

## Structured Mutations Are Not Failure- or Crash-Atomic

- **Root cause:** structured mutation paths write directly to their target filesystem state without a general staging/commit boundary; multi-file paths additionally apply filesystem operations sequentially without rollback.
- **Primary cost dimension:** correctness and recovery.
- **Current cost:** `apply_patch` and LSP rename can report failure after earlier files in the same logical operation were already modified. Direct target writes can also be interrupted by process crash or the service manager's final hard stop, so even a mutation deliberately allowed to finish during graceful shutdown is not guaranteed to survive an eventual `SIGKILL` as an all-or-nothing update. Callers may need manual inspection or recovery.
- **Evidence:** `apply_patch` plans all requested changes but applies writes, moves, and deletes one-by-one; LSP workspace edits likewise process file edits/create/rename/delete operations sequentially. The shutdown contract intentionally protects admitted mutation critical sections from application-level cancellation, but systemd still retains a finite final hard-stop deadline.
- **Cost mechanism:** validation reduces pre-apply errors, and `FileMutationCoordinator` prevents competing in-process structured mutations during the critical section, but neither mechanism provides a crash-safe commit point or can undo filesystem work that committed before a later failure/interruption.
- **Reachable better state:** define an explicit failure/crash-atomicity contract for structured mutations, then implement the smallest staging/commit/rollback mechanism that satisfies it for supported write, create, delete, and move semantics. The design may deliberately document bounded non-atomic cases where host-filesystem guarantees make full rollback unsafe or impossible.
- **Governing constraint:** a structured mutation must either complete according to its declared commit semantics or return/leave enough explicit state for deterministic recovery; a generic failure or hard interruption must not create an undocumented partial-commit state.
- **Scope discovery:** include `write`, `edit`, `apply_patch`, LSP workspace edits and rename, shared mutation coordination, file creation/deletion/move semantics, symlinks, permissions, cross-filesystem moves, graceful shutdown versus hard-stop behavior, tool results, logs, and contract tests before selecting a transaction model.
- **Repair direction:** design the failure model first. Do not bolt temporary backups or rename-based pseudo-transactions onto individual tools without proving their behavior across the full mutation scope.
- **Exit criteria:** supported structured mutation paths have one explicit commit/failure/crash contract, tests cover interruption and failure after partial progress, tool results unambiguously describe residual state, and any staging/rollback mechanism is validated for the filesystem operations it claims to cover.
- **Priority:** medium; partial application and hard-interruption states are real correctness/recovery risks, but repair crosses several filesystem semantics and is not appropriate as incidental shutdown cleanup.

## MCP Session State Is Ephemeral

Process restart ends all MCP sessions while durable Shell state and OAuth access tokens may survive in persisted state.

Control: clients must reinitialize MCP sessions after reconnect. Do not infer MCP session continuity from Shell or token continuity.

## Architectural Knowledge Has a Broad Manual Synchronization Radius

- **Root cause:** long-lived architecture rules are intentionally projected into several Views and operator/developer documents, but semantic authority versus audience-specific projection is not explicit enough. The same rule can therefore be restated as if several documents independently own it.
- **Primary cost dimension:** maintainability and maintained-knowledge coherence.
- **Current cost:** conceptual boundary changes require broad coordinated prose edits and create omission risk. Connection/resource-alias work previously touched many architecture Views plus README and AGENTS. The 2026-10-06 Web Console migration repeated the pattern across goals, context, strategy, decomposition, runtime, deployment, access control, observability, glossary, README, AGENTS, and a new ADR.
- **Evidence:** two unrelated architecture changes—connection/resource identity and the Web Console boundary—both produced large documentation synchronization sets even though each had a small number of governing rules. A later four-line `GET /` convenience redirect for the Web Console still required coordinated current-state edits in the Web Console ADR, system decomposition, README, and AGENTS guidance. The 2026-10-06 Activity input-preview change likewise required coordinated updates to the observability concept, Web Console runtime View, and this debt record to keep preview lifecycle and presentation ownership coherent.
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

## Host Process-Tree Lifecycle Is Split Across Tool Runtimes

- **Root cause:** application-owned external processes do not share one complete process-tree lifecycle primitive. Bash/image subprocesses use `ProcessSupervisor`, while LSP clients own a separate process wrapper and protocol-aware stop path; platform-specific tree termination semantics therefore remain distributed.
- **Primary cost dimension:** reliability and maintainability.
- **Current cost:** changes to TERM/KILL escalation, descendant cleanup, platform behavior, or process ownership require reasoning across more than one implementation. Unix process groups can be converged even after their leader exits, but Windows tree-wide graceful termination has different capabilities and the LSP path can evolve independently from generic host-process policy.
- **Evidence:** the shutdown repair had to add process-group liveness tracking to `ProcessSupervisor` and separately remove process-signal ownership from the LSP manager. A regression test was required specifically for a TERM-ignoring descendant that survives after its group leader exits.
- **Cost mechanism:** protocol lifecycle and OS process-tree lifecycle are partially entangled. Each runtime can independently reimplement spawn/stop/escalation details, creating divergence and repeated edge-case work without gaining product capability.
- **Reachable better state:** keep LSP protocol/session semantics in the LSP layer but converge shared spawn/process-tree termination behavior behind the narrowest host-process primitive that can support both short-lived tools and long-lived protocol children. Explicitly define platform guarantees where Unix process groups and Windows process trees cannot offer identical semantics.
- **Governing constraint:** every application-owned child tree has one explicit owner and one bounded termination policy; protocol-specific cleanup may precede that policy but must not create a competing OS-process lifecycle authority.
- **Scope discovery:** include `ProcessSupervisor`, Bash, image normalization, LSP spawning/stopping, process groups, Windows `taskkill`, client abort/timeout behavior, application shutdown escalation, service-manager cgroup cleanup, and related tests.
- **Repair direction:** first extract or extend only the shared process-tree mechanics demonstrated by current implementations. Do not force LSP protocol state into a generic supervisor or introduce a cross-platform abstraction that claims guarantees the host OS cannot provide.
- **Exit criteria:** all application-owned child trees use one declared process-tree termination mechanism or explicitly documented platform-specific adapter, TERM/KILL/tree semantics have canonical tests, and adding a new child-process-backed tool does not require inventing another shutdown policy.
- **Priority:** medium; Unix shutdown is now covered, but duplicated lifecycle authority remains and platform divergence can recreate the same class of defect.

## LSP Readiness Uses Fixed-Time Waiting

- **Root cause:** several LSP state transitions use elapsed wall-clock time as a proxy for an observable protocol or process condition rather than waiting on the narrowest available completion/readiness signal.
- **Primary cost dimension:** user latency and correctness.
- **Current cost:** fast language servers pay unconditional delay before useful work proceeds, while slow or overloaded servers can still exceed the guessed delay and expose race-dependent behavior. Repeated per-file waits can multiply this cost for directory-oriented diagnostics.
- **Evidence:** the current LSP runtime includes fixed waits after process start, after protocol initialization, after the first `textDocument/didOpen`, and before diagnostics are consumed. These waits are distinct from bounded request/shutdown deadlines because successful progress does not end them early.
- **Cost mechanism:** elapsed time is treated as state evidence. The implementation therefore must choose between excess latency and an insufficient readiness margin, and changing hardware/server behavior can invalidate the chosen constants without changing the actual protocol contract.
- **Reachable better state:** identify the concrete condition each delay is approximating and use protocol responses, notifications, process state, or another explicit convergence signal where available. Where an LSP server offers no reliable completion signal, retain only a bounded compatibility wait tied to a documented condition and deadline rather than an unconditional sleep on every path.
- **Governing constraint:** normal LSP progress waits on observable state, not a fixed delay, whenever the relevant state is observable; compatibility timing fallbacks are explicit, bounded, and isolated.
- **Scope discovery:** inspect process startup, initialization, document open/change/save synchronization, diagnostics acquisition and aggregation, request timeouts, initialization timeouts, and server-specific compatibility behavior. Distinguish readiness sleeps from intentional retry, timeout, or shutdown bounds.
- **Repair direction:** replace one state transition at a time only after establishing what completion condition is actually required. Do not merely reduce timeout constants or introduce polling loops that preserve the same uncertainty under another form.
- **Exit criteria:** representative LSP operations do not incur unconditional readiness sleeps when an observable completion condition exists, slow-server behavior remains bounded and deterministic, and tests cover both immediate and delayed convergence without relying on wall-clock padding.
- **Priority:** medium; the mechanism directly affects interactive latency and can produce timing-sensitive correctness failures, but protocol/server differences require careful scope discovery before changing behavior.

## LSP Command Resolution Has Split Authority

- **Root cause:** LSP server availability checking and actual process execution do not consume one canonical command-resolution policy. Availability lookup searches the inherited process PATH plus LSP/Pi-specific additional directories, while process startup subsequently applies the mcp-shell `CommandPathPolicy` that pins user and repository command directories.
- **Primary cost dimension:** correctness and diagnosis effort.
- **Current cost:** preflight can reject a server that the authoritative execution environment would resolve, or select/describe availability under a different search order from the command that would actually be spawned. Operators then see an installation/configuration error even though mcp-shell's configured command environment may be capable of executing the server.
- **Evidence:** `isServerInstalled` derives candidates from `process.env.PATH` and LSP-specific additional bases, while `LSPClientTransport.start` builds a spawn environment and then calls `applyCommandPath` before `spawnProcess`. The two paths therefore maintain overlapping command-search semantics with different inputs and precedence.
- **Cost mechanism:** one executable identity has two maintained authorities: a discovery approximation and the execution environment. Changes to command-path policy or LSP-specific search paths can update one without the other and create false negatives or difficult-to-reproduce environment differences.
- **Reachable better state:** make availability/preflight resolution and process execution consume the same canonical command-search environment or resolver, while keeping LSP-specific supplemental directories as explicit inputs rather than a competing authority.
- **Governing constraint:** for a given LSP command and workspace, the preflight decision is derived from the same effective command-resolution policy that execution will use.
- **Scope discovery:** include `CommandPathPolicy`, `applyCommandPath`, LSP supplemental PATH construction, executable probing on Unix/Windows, absolute command paths, per-server environment overrides, user/repository bin precedence, and spawned-process behavior.
- **Repair direction:** converge the existing resolution inputs around one narrow command-environment/resolution mechanism. Do not duplicate the pinned PATH calculation inside availability checking or introduce a general command-service abstraction without evidence that another consumer needs it.
- **Exit criteria:** tests prove that commands available through each supported effective PATH layer are accepted by preflight and resolve identically at spawn time, including precedence and platform-specific executable suffix handling.
- **Priority:** medium; the mismatch is a real authority defect with user-visible false-negative potential, but the current frequency of affected LSP installations is not measured.

## LSP Runtime Still Has Mixed Responsibility

- **Root cause:** the LSP implementation combines configuration discovery, JSON-RPC/client transport, process ownership, idle lifecycle, workspace-edit application, formatting, and MCP registration in one large module.
- **Primary cost dimension:** maintainability and context locality.
- **Current cost:** representative lifecycle, configuration, workspace-edit, or MCP-presentation changes still require loading a large amount of unrelated LSP logic. The module also retains Pi-era configuration and naming compatibility whose status as product contract versus historical residue is not yet explicit, while focused proof boundaries exist for lifecycle ownership but not yet for several other responsibilities that a future split would need to preserve.
- **Evidence:** `src/tools/lsp.ts` remains a multi-thousand-line directly maintained module spanning configuration lookup, process and JSON-RPC transport, protocol client behavior, reusable-client management, workspace edits, result formatting, and MCP registration. The application-ownership migration removed its static singleton/closing state and added contract tests proving per-runtime isolation and cross-session sharing, but intentionally did not reorganize the remaining responsibilities or create broad behavior-parity tests merely to enable a refactor.
- **Cost mechanism:** unrelated change axes still share one implementation unit, increasing context load and making safe deletion or refactoring harder even though runtime lifetime is now explicit.
- **Reachable better state:** split only along demonstrated responsibility/change boundaries such as process/client lifecycle, server/config discovery, workspace-edit application, and MCP presentation/registration; separately decide whether Pi-era configuration compatibility is an intentional mcp-shell contract before renaming or removing it.
- **Governing constraint:** LSP resources remain application-owned and shared across MCP sessions, while a representative change should require loading only the responsibility it affects rather than the full LSP implementation.
- **Scope discovery:** include client/process lifecycle, server configuration/discovery, workspace-root logic, diagnostics aggregation, workspace edits, MCP registration, current proof ownership for each responsibility, and existing Pi-compatible configuration behavior before splitting or deleting compatibility paths.
- **Repair direction:** split along observed change seams only when each extraction reduces context burden. Do not perform a line-count-driven rewrite, alter LSP behavior while reorganizing it, or silently remove compatibility configuration.
- **Exit criteria:** representative lifecycle/config/workspace-edit/MCP-presentation changes have bounded module context with unchanged tool contracts, and Pi-era compatibility paths are either explicitly owned as supported behavior or migrated deliberately.
- **Priority:** medium; application ownership is now corrected, but the module still carries demonstrated context and responsibility concentration.

## Standalone Shutdown Has No Self-Owned Hard Deadline

- **Root cause:** application shutdown has graceful admission/drain/escalation phases but delegates the final non-convergence bound entirely to an external service manager.
- **Primary cost dimension:** operability and recovery.
- **Current cost:** the recommended systemd deployment eventually kills a stuck process, but direct `npm start`/manual execution has no equivalent final deadline. A permanently stuck admitted request, in-process operation, or third-party promise can therefore prevent process exit indefinitely outside the supervised deployment.
- **Evidence:** the shutdown design intentionally relies on `TimeoutStopSec` as the final whole-cgroup bound after the application's normal three-second tool grace and process escalation. No application-level final deadline covers the unsupported-but-common direct-run path.
- **Cost mechanism:** graceful shutdown assumes every in-process await eventually settles. When that assumption fails, only deployments with a correctly configured external supervisor recover automatically.
- **Reachable better state:** add one simple process-level maximum shutdown duration that emits a diagnostic and terminates non-converged standalone execution, while preserving systemd as the outer production cgroup authority. Avoid introducing phase-manager machinery unless future evidence requires it.
- **Governing constraint:** every supported way of running mcp-shell has a finite shutdown bound; production supervision may enforce a stricter outer bound, but direct execution must not wait forever.
- **Scope discovery:** include `src/main.ts`, HTTP close/drain behavior, invocation draining, LSP/process shutdown, durable-state flush ordering, CLI/manual execution, tests, and interaction with systemd's outer timeout.
- **Repair direction:** implement one final deadline at the composition root with minimal policy. Do not make individual resources invent their own unrelated hard deadlines.
- **Exit criteria:** an intentionally non-settling shutdown resource cannot keep a directly launched process alive indefinitely, the failure is diagnosed, normal graceful shutdown behavior remains unchanged, and systemd retains final production cgroup control.
- **Priority:** low; supervised production already has a hard bound, so the residual cost is limited to direct/incorrectly supervised execution.

## Shell History Grows Monotonically

Shell IDs are never reused and there is intentionally no list or close operation, so `shells.db` grows with created Shells.

Control: keep each Shell row compact and use indexed point lookup by ID so runtime cost does not scale with total history. Reassess retention only if persistent disk growth becomes material.
