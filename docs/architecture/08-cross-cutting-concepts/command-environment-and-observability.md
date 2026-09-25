---
summary: "Defines shared command-environment precedence, search guardrails, and tool-call logging behavior."
viewpoint: static
stakeholders:
  - architect
  - developer
  - operator
concerns:
  - operability
  - security
  - maintainability
activities:
  - orient
  - change
  - diagnose
  - operate
  - assess
facets:
  domain:
    - host-tools
    - observability
---

# Command Environment and Observability

## Environment Assembly

An optional shell environment file may be sourced at startup to import user PATH and related variables. Values from the mcp-shell server env file are then applied as authoritative server configuration.

The final command path is normalized to:

```text
~/.mcp-shell/bin
<repository>/bin
<remaining inherited PATH>
```

The same policy is re-applied when supported child processes are spawned so intervening environment rewriting cannot silently move the two pinned layers behind another directory.

## Search Guardrails

Repository wrappers for `rg`, `grep`, `find`, and `fd` use a 200 ms wall-clock budget. If exceeded, they preserve output already produced, terminate the underlying command, and emit a structured timeout explanation. `--unsafe` deliberately bypasses that budget after the wrapper removes the flag.

The user override directory is first by design. Therefore these wrappers improve default behavior but are not an enforcement boundary.

## Tool-Call Logging

Each recorded call receives a generated ID, sequence number, start/end timestamps, duration, tool name, input, outcome, and either output or serialized error. Session and actor context are attached when available.

Complete call records are gzip-compressed under the configured log directory. `index.jsonl` retains lightweight metadata. Payload retention is count-bounded by `TOOL_LOG_MAX_CALLS`; index history is append-only in the current implementation.

Logging is best-effort with respect to tool semantics: persistence errors are reported to stderr but do not replace a successful tool result.
