---
summary: "Defines architecture concerns available to people running mcp-shell on a host machine."
viewpoint: index
stakeholders:
  - architect
concerns:
  - architecture-coherence
  - maintainability
activities:
  - orient
  - change
  - assess
facets:
  domain:
    - whole-system
available_concerns:
  - architecture-coherence
  - correctness
  - security
  - operability
  - maintainability
  - rationale
---

# Operator

## Meaning

An operator configures and runs an mcp-shell instance and owns the host-level consequences of granting access.

## Boundary

This Stakeholder is a reader role only. It does not grant MCP authorization or host permissions.
