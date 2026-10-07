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

## External Observability API Compatibility Lacks an Independent Contract Baseline

- **Root cause:** `/api/v1/*` is a supported interface for independently released clients, but its declared shapes and expectations are maintained mainly as shared server/Web TypeScript DTOs, evolving black-box HTTP tests, and prose. No independently held version-1 baseline is compared with proposed changes.
- **Primary cost dimension:** external integration reliability and compatibility-review effort.
- **Current cost:** a maintainer can update server, bundled Web client, DTOs, and tests together and pass `npm run verify` while accidentally removing or redefining a field, error, SSE event, or cursor rule that an external client still relies on. Compatibility review consequently depends on remembering the prior deployed interface.
- **Evidence:** the Observability API migration introduced `/api/v1`, shared DTOs in `src/contracts/observability.ts`, contract-oriented tests in `test/observability-api.test.ts`, and explicit v1 compatibility guidance, but no executable comparison to a frozen previous-version contract.
- **Cost mechanism:** a changing implementation and its simultaneously changing tests cannot independently prove preservation of an older public contract; versioning alone does not bound drift.
- **Reachable better state:** retain a small, machine-checkable v1 contract baseline for routes, significant response/event schemas, nullability, errors, and cursor semantics, with CI checking compatibility against the prior supported contract. Choose the lightest workable format (schema, selected golden contract snapshots, or OpenAPI); SDK generation and a generic API platform are not prerequisites.
- **Governing constraint:** a routine internal refactor cannot silently break an independently released v1 client while existing v1 support is claimed.
- **Scope discovery:** include all `/api/v1` routes, JSON/SSE DTOs, response headers, authentication and error matrices, pagination, existing integration tests, Web consumption, and published API guidance; identify which assertions already have distinct proof ownership before adding a baseline.
- **Repair direction:** inventory the stable public contract and capture it once at the narrowest sufficient boundary, then compare future revisions to that baseline instead of duplicating every integration test as an additional fixture.
- **Exit criteria:** a representative breaking change to a supported v1 field, nullability rule, error, endpoint, or SSE shape fails a compatibility check even when implementation and bundled client are modified in lockstep; additive changes still pass.
- **Priority:** medium; independently released consumers are now an explicit product goal, so silent breakage can create recurring integration failures, but no existing external compatibility incident has been reported.

## Read-Only Observability Credentials Expose More Than Minimal Monitoring Needs

- **Root cause:** remote `OBSERVABILITY_TOKEN` and configured Web Basic authority share one undifferentiated read scope across current activity, Shell inventory, retained call history, and full payload detail.
- **Primary cost dimension:** sensitive-data exposure and operator credential-management risk.
- **Current cost:** a monitor requiring only `active` for one Shell receives credentials sufficient to retrieve potentially sensitive retained tool inputs, outputs, file paths, and errors. Read-only is still powerful observation authority; sharing such credentials broadens blast radius if a lightweight monitor leaks them.
- **Evidence:** the initial v1 surface contains both `GET /api/v1/shells/:shell_id/activity` and `GET /api/v1/tool-calls/:call_id` under the same read credential. The existing sensitive-log risk concerns the payload itself; this debt concerns avoidably broad **distribution of authority** to consumers needing fewer resources.
- **Cost mechanism:** endpoint-specific information sensitivity is not represented at the auth boundary, so the easiest way to integrate status-only consumers is to overgrant full observability.
- **Reachable better state:** when distinct monitoring consumers become real, support a narrow status/activity-only credential or equivalent scoped read authority while preserving the Console's full read behavior; select the smallest credential model justified by actual callers.
- **Governing constraint:** monitoring integrations must not require access to complete retained tool payloads unless their stated task needs those payloads.
- **Scope discovery:** classify endpoints by data sensitivity, inspect current token and Basic credential semantics, ingress trust assumptions, actual consumers, token provisioning/rotation, Web read needs, and tests that prove read credentials never authorize `/mcp`.
- **Repair direction:** first establish real consumers and sensitivity requirements. Do not prebuild multi-user RBAC, OAuth scopes, or a credential database based only on hypothetical integrations.
- **Exit criteria:** supported status-only consumers can authenticate without full retained-payload read authority; the access matrix and negative security tests enforce that distinction.
- **Priority:** medium when distributing tokens to separate monitoring systems; currently an acknowledged least-privilege gap, not evidence of a security incident.

## Observability Storage Degradation Lacks an Explicit API and Recovery Contract

- **Root cause:** the process-local Activity projection can keep serving live state during history-store failure, but durable latest-Shell-event continuity and historical call reads still share `ObservabilityStore` initialization/persistence. The external API does not expose one explicit model of which observability capabilities remain available or how they recover.
- **Primary cost dimension:** diagnosis and monitoring reliability.
- **Current cost:** a failed `history.db` initialization or later write can leave current running/recent activity available while retained history and post-restart Shell active continuity are unavailable or stale. API consumers may see inconsistent availability or generic failures without being able to distinguish live success from degraded durability.
- **Evidence:** the Observability API work added `shell_activity` to the same SQLite metadata transaction as complete calls, preserved best-effort recorder semantics, and continued to initialize the store once per process with restart as retry boundary. It did not add a structured degraded-state API or external recovery/health contract.
- **Cost mechanism:** partial service health is implicit across runtime memory and durable storage; monitors lack a stable way to detect and report incomplete durability, and operators must infer the failure from logs or endpoint-specific symptoms.
- **Reachable better state:** document which read models work without durable storage and expose the minimum useful explicit degradation signal plus recovery procedure. Separate persistence failure domains only if measurements or incidents show that isolation would materially reduce impact.
- **Governing constraint:** read clients can distinguish authoritative currently available activity from missing/stale durable history and can diagnose loss of restart continuity without assuming a successful HTTP response implies complete observability health.
- **Scope discovery:** include startup migration, SQLite failure/recovery, `ToolCallRecorder` best-effort persistence, `ActivityTracker` bootstrap, query fallback, HTTP errors, direct Shell status, SSE/polling, restart behavior, logs, and operator recovery steps.
- **Repair direction:** define failure modes and test one degraded startup/write path before selecting minimal health/status semantics. Do not create a second SQLite database or generic service-health framework merely because two semantic lifetimes share storage.
- **Exit criteria:** an intentionally failed observability-store initialization or write yields a documented and testable external degradation signal, live/recent behavior remains appropriately isolated, and restart/recovery expectations are explicit.
- **Priority:** low until external monitors depend on high-confidence history/continuity; the failure domain is credible, but no material production incident or availability target has yet justified a storage split.

## Shell Detail Live-Call Overlay Is Bounded by Workspace Recent Calls

- **Root cause:** the Shell detail live overlay is projected from each workspace's bounded `recent_calls` list rather than a complete per-Shell running-call inventory delivered to the browser.
- **Primary cost dimension:** live-detail completeness under extreme workspace fan-out.
- **Current cost:** after initial snapshot or reconnect, a Shell detail page can omit some concurrently running calls when one workspace has more current/recent calls than the bounded workspace call projection retains. Completed history remains authoritative once calls finish, and Shell **active presence** is no longer affected: `ActivityTracker` now keeps per-Shell running/active-window presence independently, while `ObservabilityStore.shell_activity` survives call-history retention and restart.
- **Evidence:** the active-presence half of the former lifecycle-window debt was removed by the first-class Observability API work and is covered by retention, restart, running-call, and exact-expiry tests. The remaining browser overlay deliberately reuses bounded call rows.
- **Cost mechanism:** one bounded structure still serves card display and Shell live-call overlay. Under unusual concurrent fan-out, row visibility can be incomplete even though presence/count semantics remain correct.
- **Reachable better state:** if observed workloads make the omission material, expose or retain a lifecycle-complete bounded-by-running-state per-Shell call projection without coupling it to completed recent-call retention.
- **Governing constraint:** API/Shell active status and active-Shell counts must remain lifecycle-complete; a bounded presentation overlay may omit rows only where its contract explicitly does not claim complete enumeration.
- **Exit criteria:** either measurements show the overlay bound dominates supported concurrent workloads, or Shell live-call enumeration gets its own lifecycle-complete projection.
- **Priority:** low; current correctness-critical presence semantics are independent, and no production evidence shows the residual row-visibility limit is material.

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
- **Current cost:** conceptual boundary changes require broad coordinated prose edits and create omission risk. Connection/resource-alias work previously touched many architecture Views plus README and AGENTS. The 2026-10-06 Web Console migration repeated the pattern across goals, context, strategy, decomposition, runtime, deployment, access control, observability, glossary, README, AGENTS, and a new ADR. The 2026-10-07 durable Tool History change repeated the same synchronization pattern across decomposition, two runtime Views, deployment, two cross-cutting concepts, quality scenarios, debt records, README, AGENTS, and a new ADR even though its governing rules were concentrated in one storage/authority decision.
- **Evidence:** unrelated architecture changes—connection/resource identity, the Web Console boundary, and durable Tool History—have each produced large documentation synchronization sets even though each had a small number of governing rules. A later four-line `GET /` convenience redirect for the Web Console still required coordinated current-state edits in the Web Console ADR, system decomposition, README, and AGENTS guidance. The 2026-10-06 Activity input-preview change likewise required coordinated updates to the observability concept, Web Console runtime View, and this debt record to keep preview lifecycle and presentation ownership coherent. During the Tool History migration, the same storage/retention authority had to be reconciled manually across architecture, operator, and agent guidance before old `ToolLogStore/index.jsonl` claims disappeared.
- **Additional evidence (2026-10-07):** promoting Observability API to a first-class surface required synchronized edits across README, AGENTS, goals, context, strategy, decomposition, runtime/deployment/access/observability Views, glossary, quality scenarios, and two related ADRs. Explicitly assigning the old Web Console ADR to UI concerns and the new Observability API ADR to transport/auth/compatibility reduced conflicting authority, but broad manual projection maintenance remains.
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
- **Evidence:** the shutdown repair had to add process-group liveness tracking to `ProcessSupervisor` and separately remove process-signal ownership from the LSP manager. The later LSP readiness repair then had to add protocol-correct `shutdown` request/response handling plus a natural-exit grace inside the LSP client/connection path while still retaining its separate TERM/KILL fallback. A regression test was required specifically for a TERM-ignoring descendant that survives after its group leader exits.
- **Cost mechanism:** protocol lifecycle and OS process-tree lifecycle are now ordered more clearly in the LSP path, but the OS process-tree mechanics remain separately implemented. Each runtime can still independently evolve spawn/TERM/KILL/descendant semantics, creating divergence and repeated edge-case work without gaining product capability.
- **Reachable better state:** keep LSP protocol/session semantics in the LSP layer but converge shared spawn/process-tree termination behavior behind the narrowest host-process primitive that can support both short-lived tools and long-lived protocol children. Explicitly define platform guarantees where Unix process groups and Windows process trees cannot offer identical semantics.
- **Governing constraint:** every application-owned child tree has one explicit owner and one bounded termination policy; protocol-specific cleanup may precede that policy but must not create a competing OS-process lifecycle authority.
- **Scope discovery:** include `ProcessSupervisor`, Bash, image normalization, LSP spawning/stopping, process groups, Windows `taskkill`, client abort/timeout behavior, application shutdown escalation, service-manager cgroup cleanup, and related tests.
- **Repair direction:** first extract or extend only the shared process-tree mechanics demonstrated by current implementations. Do not force LSP protocol state into a generic supervisor or introduce a cross-platform abstraction that claims guarantees the host OS cannot provide.
- **Exit criteria:** all application-owned child trees use one declared process-tree termination mechanism or explicitly documented platform-specific adapter, TERM/KILL/tree semantics have canonical tests, and adding a new child-process-backed tool does not require inventing another shutdown policy.
- **Priority:** medium; LSP protocol cleanup is now correct and bounded, but duplicated OS lifecycle authority remains and platform divergence can recreate the same class of defect.

## Directory LSP Diagnostics Serialize Per-File Convergence

- **Root cause:** directory diagnostics reuse one LSP client but process selected files sequentially, and each file waits for its own pull response or push-diagnostics convergence before the next file is synchronized.
- **Primary cost dimension:** user latency.
- **Current cost:** directory checks can accumulate per-file latency across as many as the configured scan cap. Push-only servers are especially exposed because opening one file and waiting for its publication can delay opening the next; even pull-capable servers cannot overlap independent document requests. The exact magnitude varies by language server and workspace size.
- **Evidence:** directory aggregation currently awaits `client.diagnostics(file)` inside a sequential file loop. During the readiness repair, a real cold TypeScript-language-server smoke required seconds for the first push-diagnostics publication, showing that per-file convergence latency can be material even though the single-file path is now event-driven rather than sleep-driven.
- **Cost mechanism:** one shared server can potentially make progress on multiple documents, but the caller withholds later document synchronization until earlier diagnostic convergence completes. Total latency therefore trends toward the sum of per-file waits rather than the server's achievable overlapped throughput.
- **Reachable better state:** first measure representative pull and push servers, then introduce only the minimum bounded overlap that materially improves directory latency—for example synchronizing a small batch before collecting results or using bounded concurrent pulls—while preserving deterministic result/error aggregation and avoiding unbounded request fan-out.
- **Governing constraint:** directory diagnostics remain bounded in file count and concurrency, but independent per-file work is not unnecessarily serialized when the language server can safely overlap it.
- **Scope discovery:** include directory file collection/caps, `aggregateDiagnosticsForDirectory`, document synchronization, pull versus push diagnostics, publication waiters, abort behavior, language-server request concurrency, error aggregation, and representative real-server latency measurements.
- **Repair direction:** measure before changing scheduling. Do not replace the current serial loop with unbounded `Promise.all`; choose a small bounded strategy only if measurements show material benefit and server behavior remains stable.
- **Exit criteria:** representative directory diagnostics have before/after latency evidence, concurrency remains explicitly bounded, abort/error behavior stays deterministic, and both push-only and pull-capable server paths retain correctness.
- **Priority:** low pending measurement; the serialization mechanism is definite, but lifetime user cost and the safest degree of overlap are server-dependent.

## Windows Command Resolution Lacks Executable Verification

- **Root cause:** mcp-shell maintains Windows-specific executable-resolution semantics, but the canonical repository verification path has no checked-in Windows execution environment. The platform-specific proof therefore exists only as a conditional test and is skipped on non-Windows development hosts.
- **Primary cost dimension:** correctness and release confidence.
- **Current cost:** a regression in `PATHEXT`, Windows PATH-key handling, or the interaction between resolved executables and Windows process launch can pass the normal Linux verification gate and remain latent until a Windows user exercises the path.
- **Evidence:** `resolveExecutable` has a Windows-specific `PATHEXT` contract test, but `npm run verify` skips it on the current Linux host, and the repository has no checked-in CI workflow that supplies a Windows runner.
- **Cost mechanism:** the project carries a platform-specific behavioral contract without an execution environment that continuously proves it. The test asset can therefore remain green-by-absence rather than detecting platform drift.
- **Reachable better state:** either execute the Windows-specific command-resolution contract on a real Windows runner as part of required verification, or explicitly narrow the supported platform contract and retire Windows-specific behavior that the project does not intend to maintain.
- **Governing constraint:** every platform-specific command-resolution behavior claimed by the project is continuously verified on the platform whose filesystem and process semantics it depends on.
- **Scope discovery:** include `src/command-path.ts`, Windows PATH/PATHEXT handling, LSP process launch with `shell: true`, platform-conditional command-resolution tests, repository verification/CI configuration, and any maintained documentation that claims Windows support.
- **Repair direction:** prefer a minimal real-Windows verification job over emulating `process.platform` inside Linux tests. If Windows is not a supported deployment target, make that support decision explicit before deleting compatibility code or tests.
- **Exit criteria:** the Windows-specific command-resolution tests execute successfully on a real Windows environment in the required verification path, or the supported-platform contract is explicitly narrowed and the obsolete Windows-specific implementation/proofs are retired.
- **Priority:** low; the core split-authority defect is fixed and Linux behavior is covered, while the residual risk is limited to an unproven platform path whose product-support importance has not yet been established.

## LSP Runtime Still Has Mixed Responsibility

- **Root cause:** the remaining LSP tool module still combines configuration discovery, launch preparation, reusable-client management, workspace-edit application, formatting, and MCP registration. Stdio/JSON-RPC connection handling and protocol-client state now have dedicated `src/lsp/connection.ts` and `src/lsp/client.ts` boundaries, but the remaining responsibilities still share one large adapter module.
- **Primary cost dimension:** maintainability and context locality.
- **Current cost:** representative configuration, launch-resolution, reusable-client lifecycle, workspace-edit, or MCP-presentation changes still require loading a large amount of unrelated LSP logic. `LSPServerManager` remains physically located in the tool adapter despite being application-owned, and Pi-era configuration/naming compatibility still lacks an explicit product-contract decision.
- **Evidence:** the readiness repair extracted stdio/JSON-RPC lifecycle into `src/lsp/connection.ts` and protocol initialization/capabilities/document synchronization/diagnostics into `src/lsp/client.ts`, proving those as real change boundaries. `src/tools/lsp.ts` is still roughly 1,600 lines and continues to contain config discovery, launch preparation, `LSPServerManager`, workspace-edit application, formatting, and MCP registration. Existing tests separately prove application-scoped manager ownership, launch resolution, and protocol-client readiness semantics.
- **Cost mechanism:** several unrelated remaining change axes still share one implementation unit, increasing context load and making safe deletion or refactoring harder even though connection/protocol-client runtime semantics are now isolated.
- **Reachable better state:** preserve the demonstrated connection/client boundaries and split remaining responsibilities only when change pressure proves another seam, most plausibly reusable-client management, server/config discovery plus launch preparation, workspace-edit application, or MCP presentation/registration. Separately decide whether Pi-era configuration compatibility is an intentional mcp-shell contract before renaming or removing it.
- **Governing constraint:** LSP resources remain application-owned and shared across MCP sessions, while a representative change should require loading only the responsibility it affects rather than the full LSP implementation.
- **Scope discovery:** include reusable-client lifecycle, server configuration/discovery, launch-spec preparation and executable resolution, workspace-root logic, directory-diagnostic aggregation, workspace edits, MCP registration, current proof ownership for each responsibility, and existing Pi-compatible configuration behavior before splitting or deleting compatibility paths. Treat `src/lsp/connection.ts` and `src/lsp/client.ts` as established boundaries unless new evidence shows they are misplaced.
- **Repair direction:** split along observed change seams only when each extraction reduces context burden. Do not migrate `LSPServerManager` or other remaining code merely for directory symmetry, perform a line-count-driven rewrite, alter tool behavior while reorganizing it, or silently remove compatibility configuration.
- **Exit criteria:** representative lifecycle/config/workspace-edit/MCP-presentation changes have bounded module context with unchanged tool contracts, and Pi-era compatibility paths are either explicitly owned as supported behavior or migrated deliberately.
- **Priority:** medium; protocol-client context is now isolated, but the remaining adapter still carries demonstrated responsibility concentration and a misplaced application-owned manager.

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
