---
summary: "Defines the responsibility-domain navigation facet for mcp-shell architecture Views."
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
values:
  whole-system: System-wide architecture crossing several responsibility areas.
  access-and-transport: HTTP exposure, OAuth, connection modes, and client-to-server trust boundaries.
  mcp-runtime: MCP protocol handling, sessions, server construction, and tool dispatch.
  host-tools: Shell, file, patch, image, LSP, command lookup, and host-side execution authority.
  observability: Tool-call logging, retained runtime evidence, and diagnostics surfaces.
---

# Domain Facet

`domain` identifies the responsibility area to which a View applies. A View may list several values when its content genuinely crosses those boundaries.
