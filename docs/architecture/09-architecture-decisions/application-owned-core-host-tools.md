---
summary: "Records application ownership of core host-tool semantics and lifecycle instead of depending on a full external coding-agent runtime."
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
    - host-tools
    - whole-system
---

# Application-Owned Core Host Tools

## Decision State

Accepted and implemented architecture decision.

## Context

mcp-shell exposes four foundational host operations: read, write, edit, and bash. They previously adapted tool factories exported by @earendil-works/pi-coding-agent.

That dependency supplied much more than those four operations: agent, model, TUI, HTTP, glob, image, package, and interactive-runtime capabilities entered the production dependency graph even though mcp-shell did not use them. This widened the supply-chain and upgrade surface, and production advisories in unrelated transitive capabilities could force qualification of a breaking coding-agent upgrade just to retain basic filesystem and process behavior.

The external implementation also carried behaviors that were not part of mcp-shell's stated contract, such as fuzzy edit matching, image-aware read branches, Pi session environment projection, interactive rendering, and complete-output spill files for large shell output. Treating those behaviors as compatibility requirements would make an implementation detail the semantic authority for mcp-shell.

## Decision

mcp-shell owns the public semantics and lifecycle of read, write, edit, and bash.

The compatibility target is the mcp-shell tool contract, not parity with a coding-agent implementation. Core behavior uses Node standard-library filesystem and child-process primitives. A small direct diff dependency is accepted for edit diagnostics rather than maintaining a general-purpose diff algorithm locally.

### Path and authority semantics

Shell cwd is the base for relative paths, not a filesystem sandbox. Absolute paths remain valid. Tilde paths resolve against the server process user's home directory. Normal OS symlink semantics apply.

This preserves the existing host-authority model: an authorized caller can act with the filesystem and command authority of the mcp-shell process user.

### Read

read is text-only; image inputs belong to read_image.

Reads stream from disk and bound returned text to 2,000 lines or 50 KiB, whichever limit is reached first. offset and limit are positive integer line controls. Oversized single lines are not buffered without bound; callers are directed to byte-oriented shell tools when a line itself exceeds the read budget.

### Write

write creates parent directories when needed and overwrites the target using ordinary filesystem write semantics. Success byte counts use UTF-8 encoded bytes rather than JavaScript character count.

### Edit

edit applies one or more replacements against the same original file content.

Matching is exact after newline normalization only:

- CRLF and CR input are normalized to LF for matching;
- BOM is excluded from matching and restored on write;
- the file's CRLF-versus-LF style is preserved on write;
- oldText must be non-empty and occur exactly once;
- replacements must not overlap;
- no Unicode, quote, dash, whitespace, or other fuzzy normalization is performed.

All replacements are validated before the file is written.

### Bash

bash executes in the resolved Shell cwd with the configured command-path policy reapplied to the process environment.

stdout and stderr are combined in the order their chunks are observed by the Node process; no strict cross-descriptor ordering is promised. Returned output is bounded to the most recent 2,000 lines or 50 KiB. mcp-shell does not automatically persist complete truncated output; callers that require complete large output should redirect it to a file explicitly.

Timeout, request abort, and application shutdown terminate the managed command process group. On supported Unix hosts the executable is /bin/bash; the tool fails explicitly when the required Bash executable is unavailable rather than silently changing shell semantics.

## Shared host control points

Two application-owned mechanisms cover rules that cross tool boundaries.

FileMutationCoordinator serializes mcp-shell's structured mutations of the same path. write, edit, apply_patch, and LSP rename share it; unrelated paths remain concurrent. Multi-path operations acquire a deterministic path set so opposing path orders cannot deadlock. Existing targets are keyed by real path; nonexistent targets canonicalize through their nearest existing ancestor so directory-symlink aliases converge when practical.

This is process-local coordination, not filesystem locking or containment. bash, another process, another mcp-shell instance, or any external editor can modify the same files independently.

ProcessSupervisor tracks child processes whose lifetime is owned by tool execution. bash process groups and ImageMagick children used by read_image register with it. Individual abort/timeout paths terminate their own children; application shutdown terminates any remaining registered children before runtime close completes.

## Rejected alternatives

### Keep the full coding-agent dependency

Rejected because the dependency and upgrade surface is much larger than the four capabilities mcp-shell consumes.

### Deep-import coding-agent internal tool modules

Rejected because the package does not publish those modules as stable public subpath exports and internal imports would retain upstream release coupling without owning the contract.

### Vendor the upstream tool sources

Rejected because it would inherit large amounts of agent/TUI compatibility behavior and create an implicit upstream fork.

### Maintain both Pi-backed and local implementations

Rejected because a migration switch would double the semantic and test matrix without a long-term product requirement for two implementations.

### Implement a filesystem sandbox

Rejected because Shell roots define relative-path context, not authorization confinement. Adding containment here would change the product authority model rather than merely replace an implementation.

## Consequences

- Core host-tool behavior is controlled and tested inside this repository.
- Production dependency and advisory surface shrinks substantially.
- Upgrading unrelated coding-agent functionality can no longer change basic host-tool semantics.
- Previously implicit fuzzy edit matching is intentionally removed.
- Large Bash output is intentionally bounded rather than persisted automatically.
- Process lifecycle and structured mutation coordination become explicit application responsibilities.
- apply_patch keeps its existing patch language and matching policy; mutation coordination is shared with the other structured mutation paths.
- edit and apply_patch use the same maintained diff library rather than separate diff engines.

## Reassessment Triggers

Reassess this decision if mcp-shell introduces remote host backends, interactive or PTY Shell sessions, cross-process mutation coordination, or another host-tool implementation whose semantics must intentionally remain interchangeable with the local one.
