---
summary: "Defines mcp-shell architecture-document navigation vocabulary, metadata, and governance."
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
---

# Architecture Index

This directory defines controlled vocabulary for deterministic navigation of the current mcp-shell Architecture Description. It is not a second description of the system.

Use:

```bash
bun archdoc.ts choices
bun archdoc.ts views --concern <concern> --activity <activity> --facet domain=<domain> [--viewpoint <viewpoint>]
bun archdoc.ts check
```

Every Markdown file under `docs/architecture/` is a governed View. Architecture facts belong in chapters 01–12; this index owns only navigation vocabulary and relationships.
