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

## Search Wrappers Can Be Bypassed Deliberately

User overrides are higher precedence than repository wrappers and `--unsafe` disables the search budget.

Control: document wrappers as guardrails rather than security enforcement. Their purpose is to prevent accidental expensive scans, not to constrain an authorized shell caller.

## MCP Session State Is Ephemeral

Process restart ends all MCP sessions while durable Shell state and OAuth access tokens may survive in persisted state.

Control: clients must reinitialize MCP sessions after reconnect. Do not infer MCP session continuity from Shell or token continuity.

## Shell History Grows Monotonically

Shell IDs are never reused and there is intentionally no list or close operation, so `shells.db` grows with created Shells.

Control: keep each Shell row compact and use indexed point lookup by ID so runtime cost does not scale with total history. Reassess retention only if persistent disk growth becomes material.
