# Architecture Documentation System

## 1. Purpose and Authority

This handbook defines a generic, deterministic, agent-first navigation and governance system for an arc42-based architecture documentation corpus.

It explains:

- the mandatory arc42 document structure;
- the architecture View model;
- controlled vocabulary and relationship ownership;
- View metadata;
- deterministic document navigation;
- structural governance;
- the stable contract of the `archdoc` helper;
- migration from an existing architecture corpus;
- limits, deferred extensions, and principles for future evolution.

This handbook does not describe any particular software system. Project architecture, project terminology, corpus status, migration progress, and implementation convergence belong in that project's governed Architecture Views or project-specific records.

This file lives at the repository root deliberately. It is a handbook for the documentation system, not an Architecture View. Do not move it under `docs/architecture/` unless it is intentionally converted into a governed View with complete metadata.

### Authority boundary

Use these sources according to their purpose:

1. `docs/architecture/00-architecture-index/` defines the corpus-controlled vocabulary, metadata relationships, and project-specific navigation values.
2. `archdoc.ts` and `bun archdoc.ts --help` define current executable CLI behavior.
3. This handbook defines the stable documentation-system model, arc42 structure, design rationale, governance principles, and migration method.
4. Governed Architecture Views define the architecture of the documented system.

If these sources disagree, expose the mismatch explicitly. Do not silently treat explanatory prose, executable behavior, project architecture, or migration state as interchangeable authority.

## 2. Truth-State Conventions

Architecture-documentation work must distinguish:

- **Accepted model:** concepts and rules selected for the documentation system.
- **Current implementation:** behavior currently implemented by the helper.
- **Current corpus state:** the structural and semantic condition of one project's Architecture Views.
- **Known mismatch:** accepted intent and persisted documentation or executable behavior disagree.
- **Working hypothesis:** a possible restructuring direction not yet applied.
- **Deferred decision:** a question intentionally left unresolved until evidence justifies a choice.

Do not present a hypothesis as current architecture. Do not present file presence as implementation, deployment, validation, or migration completion. Do not present structural validity as semantic freshness.

Project-specific counts, migration progress, invalid-file lists, semantic review status, and convergence evidence must not be maintained in this generic handbook.

## 3. Mandatory arc42 Structure

This system requires an arc42-based Architecture Description under `docs/architecture/`.

The top-level structure is mandatory:

```text
<repository-root>/
├── ARCHITECTURE-DOCUMENTATION-SYSTEM.md
├── archdoc.ts
└── docs/
    └── architecture/
        ├── 00-architecture-index/
        ├── 01-introduction-and-goals.md
        ├── 02-architecture-constraints.md
        ├── 03-context-and-scope.md
        ├── 04-solution-strategy.md
        ├── 05-building-block-view/
        ├── 06-runtime-view/
        ├── 07-deployment-view/
        ├── 08-cross-cutting-concepts/
        ├── 09-architecture-decisions/
        ├── 10-quality-requirements/
        ├── 11-risks-and-technical-debt/
        └── 12-glossary.md
```

### 3.1 Chapter mapping

| Number | Path | Responsibility |
|---:|---|---|
| 00 | `00-architecture-index/` | Documentation-system extension: controlled vocabulary, metadata relationships, navigation, and structural governance. |
| 01 | `01-introduction-and-goals.md` | System purpose, architecture drivers, quality priorities, stakeholders, scope, and non-goals. |
| 02 | `02-architecture-constraints.md` | Hard, governed, organizational, technical, security, deployment, and current operating constraints. |
| 03 | `03-context-and-scope.md` | Black-box system boundary, external actors and systems, interfaces, trust boundaries, and authority changes. |
| 04 | `04-solution-strategy.md` | System-wide strategies connecting goals and constraints to detailed architecture. |
| 05 | `05-building-block-view/` | Static decomposition, responsibilities, ownership, interfaces, and dependency direction. |
| 06 | `06-runtime-view/` | Architecturally significant interactions, state changes, concurrency, failure, and recovery. |
| 07 | `07-deployment-view/` | Deployment nodes, artifacts, networks, configuration, lifecycle, persistence, and resources. |
| 08 | `08-cross-cutting-concepts/` | Shared architecture rules used across multiple building blocks or scenarios. |
| 09 | `09-architecture-decisions/` | Significant decisions, alternatives, rationale, consequences, and reassessment conditions. |
| 10 | `10-quality-requirements/` | Prioritized, observable, and verifiable quality scenarios. |
| 11 | `11-risks-and-technical-debt/` | Residual risks, persistent architecture debt, relationships, controls, and reassessment triggers. |
| 12 | `12-glossary.md` | Concise canonical project terminology and frequently confused distinctions. |

### 3.2 File and directory invariant

- Chapters 01–04 and 12 are chapter documents.
- Chapters 05–11 are chapter directories containing one or more reader-oriented Views.
- `00-architecture-index/` is a required extension to arc42, not a replacement for it.
- Every Markdown file under `docs/architecture/` is a governed Architecture View.
- Every governed View requires complete valid metadata and must be reachable through navigation.
- Chapter numbering provides structural identity and architecture-topic ownership. It is not a required reading order.
- View metadata and `archdoc` determine task-specific reading sets within and across chapters.
- Chapter directories do not require manually maintained README navigation files.
- If a chapter README exists, it is itself a governed View and must contribute unique architecture or navigation meaning. A README must not exist merely to duplicate a generated file list.
- The repository-root handbook and helper are outside the governed Architecture View corpus.

The helper generalizes metadata, navigation, and governance. It does not make the arc42 top-level structure optional.

## 4. Problem and Intended Outcome

Architecture corpora often grow around chapter order rather than reader work. Common failure modes include:

- readers cannot determine which documents apply to a concrete task;
- architecture facts, rationale, quality scenarios, risks, debt, and navigation documents appear equivalent;
- one semantic fact is repeated across static, dynamic, cross-cutting, decision, quality, and risk documents;
- orphan documents are not detected mechanically;
- manually maintained file indexes drift;
- agents spend excessive calls and context rediscovering the corpus;
- generic lifecycle labels normalize stale documents instead of removing or correcting them;
- structural validity is mistaken for proof that prose matches the running system.

The intended outcome is:

> For every supported reader situation, a deterministic helper returns the Architecture Views needed for that situation, while structural governance rejects every governed Markdown document that is invalid, undefined, or unreachable.

The goal is not an arbitrary minimum file count. The goal is a small, purposeful reading set for each supported query without loss of unique current architecture information.

## 5. Design Philosophy

### 5.1 Reader-oriented within arc42

arc42 defines topic ownership and top-level structure. Views within that structure exist to answer real reader questions.

Existing file boundaries are not protected for their own sake:

- split when readers need one part without another;
- merge when parts are always read together or repeat one authority;
- shorten when implementation detail obscures architecture;
- delete when a View contributes no unique current information or navigation value.

### 5.2 Practicality over standards ceremony

ISO/IEC/IEEE 42010 and arc42 provide useful concepts and structure. This system does not pursue ceremonial or complete formal conformance. Concepts are retained where they improve responsibility, interpretation, navigation, construction, or governance.

The system must remain understandable and maintainable by an individual or small team.

### 5.3 One semantic fact, one canonical home

A semantic fact has one authoritative View. Other Views link to it and describe only their own perspective.

Do not repeat complete ownership, public-contract, runtime-order, recovery, quality, or risk semantics in several Views. Cross-view repetition creates drift and ambiguous authority.

### 5.4 Self-description over a central View registry

Every View declares its navigation properties in YAML front matter. The helper scans the corpus and generates reverse relationships.

Do not maintain a separate hand-written registry of all Views. Adding or moving a View must not require synchronized inventory edits.

Definition documents maintain only the forward relationships they semantically own. Reverse relationships are generated.

### 5.5 Controlled vocabulary over free-form tags

Stakeholders, Concerns, Activities, Viewpoints, Facets, and Facet values are declared by governed definition documents. Views may reference only defined values.

This prevents spelling drift, accidental aliases, uncontrolled tags, and ambiguous query behavior.

### 5.6 Deterministic navigation only

The helper uses explicit metadata and exact relationships:

- no LLM calls;
- no embeddings;
- no semantic parsing;
- no natural-language query interpretation;
- no probabilistic ranking;
- no implicit best-guess reading path.

The same corpus and query produce the same ordered result.

### 5.7 Agent-first call economy

Normal navigation should require no more than two helper calls:

1. `choices` exposes the valid definitions, relationships, and reachable query space;
2. `views` returns every matching View path and summary for one complete query.

Avoid incremental option-discovery protocols that force agents to make one call per dimension.

### 5.8 Minimal vocabulary

Do not add Stakeholders, Concerns, Activities, Viewpoints, Facets, relationships, or metadata fields because they seem theoretically useful.

Add a dimension only when observed navigation results are too broad or ambiguous and the dimension is stable, orthogonal, deterministic, selectable by readers, and worth its corpus-wide maintenance cost.

### 5.9 No generic archive or document-status lifecycle

The governed Architecture Description represents current architecture. It has no generic `draft`, `current`, `deprecated`, `superseded`, or `archived` View lifecycle.

Git preserves file history. If a View no longer belongs to the current Architecture Description, update it, replace it, merge it, split it, or delete it.

Architecture Decision Records may preserve historical decisions according to ADR semantics. That does not create a generic archive state for all Views.

### 5.10 Structural validity is not semantic freshness

The helper can validate metadata, references, relationships, and reachability. It cannot determine whether prose matches requirements, code, tests, databases, deployment, or operational evidence.

Semantic freshness remains architecture work. Stale prose must be corrected or removed, not hidden behind a status field.

## 6. ISO 42010 Interpretation

The system is inspired by ISO/IEC/IEEE 42010, especially its distinction between architecture and Architecture Description and its concepts of Stakeholder, Concern, Viewpoint, and View.

It does not claim full ISO 42010 conformance.

### 6.1 Architecture and Architecture Description

A system has architecture whether or not it is documented. Markdown files express an Architecture Description. File presence does not prove that described architecture is implemented, deployed, validated, current, or accepted for a particular baseline.

### 6.2 Every architecture Markdown document is a View

Every `docs/architecture/**/*.md` file is treated as one governed View, including:

- overview chapters;
- static building-block descriptions;
- runtime scenarios;
- deployment descriptions;
- cross-cutting concepts;
- ADRs;
- quality scenarios;
- risk and debt records;
- glossary content;
- architecture-index definitions.

This deliberate simplification creates one closed-world governance object and makes orphan detection mechanical. Unusual document kinds use a suitable Viewpoint rather than escaping governance.

### 6.3 Viewpoint remains a core concept

A Viewpoint is an observation angle and a set of conventions for constructing, interpreting, and analyzing Views.

A Viewpoint is not:

- a feature category;
- a system domain;
- a summary of Concern and Activity;
- a routing middle layer that discards the original query;
- a generic free-form tag.

Each View is governed by exactly one Viewpoint. Query-time Viewpoint is optional and narrows results to one observation angle.

The matching model is not:

```text
Concern + Activity → Viewpoint → View
```

That would lose query information. Concern, Activity, Facets, and optional Viewpoint remain present through final View matching.

### 6.4 Activity and Facet

`Activity` describes what the reader is doing. `Concern` describes what system property or problem matters. They are distinct even though not every combination is meaningful.

`Facet` defines an orthogonal project-specific filter dimension. A corpus may define one or more Facets. Facets are not hardcoded by the helper.

## 7. Conceptual Model

```text
Stakeholder --holds--> Concern
Concern --supports--> Activity
Viewpoint --frames--> Concern

View --governed-by--> exactly one Viewpoint
View --addresses--> one or more Concerns
View --supports--> one or more Activities
View --applies-to--> one or more values of every defined Facet
```

### 7.1 Stakeholder

A Stakeholder identifies a reader role and exposes the Concerns available to that role.

Stakeholder affects Concern discovery and validation. It does not directly select Views after Concern availability has been validated.

Stakeholders represent stable reader roles, not login identities, permissions, concrete employee names, system domains, or arbitrary combinations of role and project area.

### 7.2 Concern

A Concern is a system property or problem dimension that matters to a Stakeholder. It is not an action, feature name, filename, or chapter.

Each Concern defines the Activities meaningful for it.

### 7.3 Activity

An Activity describes the reader's current kind of work, such as orienting, changing, diagnosing, operating, assessing, or deciding.

Concern and Activity are conceptually orthogonal but do not form a meaningful complete Cartesian product. The Concern owns its supported-Activity relationship.

### 7.4 Viewpoint

A Viewpoint defines an observation angle and conventions for constructing and interpreting a class of Views. It also declares the Concerns it can frame.

Typical angles include overview, static structure, dynamic behavior, decisions, and assurance. Actual Viewpoint keys and definitions belong to the corpus-controlled vocabulary.

### 7.5 View

A View is one Markdown document under `docs/architecture/`. Its identity is its path relative to that directory.

A View declares:

- one concise summary;
- exactly one Viewpoint;
- one or more Concerns;
- one or more Activities;
- one or more values for every defined Facet.

There is no separate View ID. Moving or renaming a file changes its View identity and requires reference updates.

### 7.6 Facet

A Facet is an orthogonal View-filter dimension defined by the project corpus. Each Facet declares its controlled values.

A View may declare multiple values for one Facet when its content genuinely spans them. A navigation query currently supplies exactly one value for every defined Facet, and matching tests membership in the View's declared values.

Facet names and values are project-specific. This handbook does not prescribe a fixed `domain`, `environment`, `capability`, or other Facet.

## 8. Controlled Vocabulary and Index Design

The required index structure is:

```text
docs/architecture/00-architecture-index/
├── README.md
├── stakeholders/
│   └── one Markdown file per Stakeholder
├── concerns/
│   └── one Markdown file per Concern
├── activities/
│   └── one Markdown file per Activity
├── viewpoints/
│   └── one Markdown file per Viewpoint
└── facets/
    └── one Markdown file per Facet
```

The index defines navigation and governance. It must not become a parallel description of the documented system's architecture.

Each definition has one Markdown file so it can carry:

- machine-readable front matter;
- concise summary;
- human-readable meaning and use guidance;
- definition-specific forward relationships;
- complete View metadata, because index documents are governed Views.

A definition key is its filename stem. A View key is its path relative to `docs/architecture/`.

### Relationship ownership

| Definition | Forward relationship |
|---|---|
| Stakeholder | `available_concerns` |
| Concern | `supported_activities` |
| Viewpoint | `framed_concerns` |
| Facet | `values`, represented as key-to-summary mapping |
| Activity | No additional forward relationship by default |

Maintain a forward relationship on the object that owns its meaning. Generate reverse relationships.

Therefore:

- Stakeholder defines which Concerns it exposes;
- Concern defines which Activities make sense for it;
- Viewpoint defines which Concerns it frames;
- Facet defines its legal values;
- View declares its own Viewpoint, Concerns, Activities, and Facet values;
- no Concern, Viewpoint, Facet, chapter, or central registry maintains a hand-written list of Views.

## 9. View Metadata Contract

Every Markdown file under `docs/architecture/` must contain YAML front matter with these common fields:

```yaml
---
summary: "One concise sentence describing the View."
viewpoint: "<exactly-one-defined-viewpoint>"
concerns:
  - "<at-least-one-defined-concern>"
activities:
  - "<at-least-one-defined-activity>"
facets:
  <defined-facet>:
    - "<at-least-one-defined-value>"
---
```

Every Facet defined by the index must appear in every View's `facets` mapping.

Do not add generic fields such as:

```text
id
status
title
owner
```

Reasons:

- path is already View identity;
- the Markdown heading is the human title;
- generic document lifecycle and archive semantics are intentionally absent;
- semantic ownership belongs in architecture content, not a generic documentation owner field;
- every common field creates corpus-wide maintenance cost.

Definition Views add their owned relationship field where applicable:

```text
stakeholders/*.md → available_concerns
concerns/*.md     → supported_activities
viewpoints/*.md   → framed_concerns
facets/*.md       → values
```

## 10. Navigation Model

### 10.1 Query shape

```text
NavigationQuery {
  stakeholder?    # optional reader-role validation
  concern         # required
  activity        # required
  facets          # exactly one queried value for every defined Facet
  viewpoint?      # optional observation-angle filter
}
```

Navigation is a relationship query, not a directory path. Concern, Activity, Facet, and Viewpoint do not correspond mechanically to filenames or arc42 chapter numbers.

### 10.2 Algorithm

1. Discover all controlled definitions from the index.
2. If Stakeholder is supplied, resolve it.
3. Resolve the selected Concern.
4. If Stakeholder is supplied, validate that the Concern is available to it.
5. Resolve the selected Activity.
6. Validate that the Concern supports the Activity.
7. Require exactly one query value for every defined Facet.
8. Resolve each supplied Facet and value.
9. If Viewpoint is supplied, resolve it and validate that it frames the Concern.
10. Match Views by Concern, Activity, and every queried Facet value.
11. If Viewpoint is supplied, additionally require exact Viewpoint equality.
12. Return matching View paths and summaries in deterministic path order.

Stakeholder is discarded after Concern validation. It does not otherwise alter matching.

### 10.3 Formal match

Without a Viewpoint filter:

```text
result = {
  view |
  concern in view.concerns
  and activity in view.activities
  and for every defined facet F:
      query.facets[F] in view.facets[F]
}
```

With a Viewpoint filter:

```text
result = {
  view |
  concern in view.concerns
  and activity in view.activities
  and for every defined facet F:
      query.facets[F] in view.facets[F]
  and view.viewpoint = query.viewpoint
}
```

### 10.4 Optional Stakeholder

Omit Stakeholder when:

- the applicable reader role is unknown;
- the query crosses reader roles;
- the Concern and other dimensions are already known;
- complete navigation space is wanted.

Provide Stakeholder when:

- discovering choices for one reader role;
- validating Concern availability;
- rejecting role-inapplicable queries early.

Stakeholder is a navigation aid, not authorization.

### 10.5 Optional Viewpoint

Every View must declare one Viewpoint. A query may omit Viewpoint to retrieve all matching observation angles.

Providing Viewpoint answers a narrower question, such as structure, runtime behavior, rationale, or assurance. Optional query filtering does not make Viewpoint optional in View metadata.

## 11. Agent-First Navigation Workflow

### First call: discover the complete reachable space

```bash
bun archdoc.ts choices
```

Or apply reader-role filtering:

```bash
bun archdoc.ts choices --stakeholder <stakeholder>
```

`choices` exposes:

1. definitions and descriptions;
2. Stakeholder-to-Concern availability;
3. Concern-to-Activity support;
4. reachable Concern/Activity-to-Facets queries and optional Viewpoint filters.

The output is a query space, not a literal file tree.

### Second call: retrieve Views

```bash
bun archdoc.ts views \
  --concern <concern> \
  --activity <activity> \
  --facet <facet>=<value> \
  [--facet <facet>=<value> ...] \
  [--stakeholder <stakeholder>] \
  [--viewpoint <viewpoint>]
```

Supply one `--facet` option for every Facet defined by the corpus.

`views` returns only matching paths and summaries. Read every returned Markdown document for actual architecture information.

The helper does not provide natural-language interpretation, semantic search, implicit value inference, or document-body answers.

## 12. Structural Governance

Run:

```bash
bun archdoc.ts check
```

The check recursively treats every Markdown file under `docs/architecture/` as a governed View.

It validates at least:

- YAML front matter exists and parses;
- required common fields exist;
- unknown metadata fields are rejected;
- summaries are non-empty;
- Viewpoint is one defined scalar value;
- Concerns and Activities are non-empty unique lists of defined values;
- every defined Facet exists in every View;
- Facet values are non-empty, unique, and defined;
- definition-specific fields occur only where applicable;
- definition keys are unique within their kind;
- Stakeholder Concern references exist;
- Concern Activity references exist;
- Viewpoint Concern references exist;
- each View Concern is framed by its Viewpoint;
- every declared View Activity is supported by every declared View Concern;
- every View is reachable through at least one valid complete query.

### Closed-world orphan policy

No Markdown file under `docs/architecture/` may escape governance. A missing-metadata, invalid-reference, or unreachable document makes the corpus structurally invalid.

### Semantic freshness boundary

A successful structural check does not prove that prose matches requirements, code, tests, schema, deployment, operations, or an accepted baseline.

When a View becomes stale:

- update it with the architecture change;
- split or merge it when its reader boundary is wrong;
- replace it when its authority has moved;
- delete it when it no longer belongs to the current Architecture Description.

Do not add archive or generic status fields to avoid semantic maintenance.

## 13. Executable Tool Contract

The helper is a deterministic command-line navigator. Current executable details belong to:

```bash
bun archdoc.ts --help
```

Its stable commands are:

```text
choices   discover controlled definitions and reachable query combinations
views     retrieve matching View paths and summaries
check     validate structural governance
```

Stable behavioral commitments:

- controlled definitions are discovered from the architecture index;
- Facets are not hardcoded in tool source;
- each defined Facet must be supplied once to `views`;
- Stakeholder is optional and affects Concern validation only;
- Viewpoint is optional at query time;
- results are deterministic and path-sorted;
- errors use nonzero exit status;
- the helper reads metadata, not document-body semantics;
- the helper does not use LLMs, embeddings, or natural-language inference;
- structural checking does not prove semantic freshness.

Do not duplicate the complete CLI help text in this handbook. The helper's help output is the executable authority for exact syntax, options, error wording, and examples.

## 14. Generic Migration Method

Migration converts an existing arc42 corpus into governed reader-oriented Views without turning historical file layout into unquestioned target structure.

### 14.1 Establish the fixed skeleton

1. Create the mandatory `docs/architecture/` arc42 top-level structure.
2. Preserve chapters 01–04 and 12 as chapter documents.
3. Preserve chapters 05–11 as chapter directories.
4. Create `00-architecture-index/` and its definition directories.
5. Keep the root handbook and helper outside the governed View corpus.

### 14.2 Define the smallest useful vocabulary

1. Identify stable reader roles.
2. Define actual architecture Concerns.
3. Define reader Activities independently from Concerns.
4. Define Viewpoints as observation and construction conventions.
5. Add only Facets needed to distinguish real reader situations.
6. Record forward relationships on their semantic owners.

Do not tune vocabulary around arbitrary existing filenames.

### 14.3 Restructure one reader boundary at a time

For each candidate View:

1. identify the reader question it answers;
2. identify its arc42 chapter authority;
3. identify its unique semantic facts;
4. separate current architecture from rationale, assurance, risk, debt, and proposal;
5. remove repeated facts already owned elsewhere;
6. remove local classes, functions, source inventories, and speculative decomposition without architecture value;
7. split when readers need one part without another;
8. merge when parts are always read together;
9. delete when no unique current information remains;
10. add complete valid metadata.

### 14.4 Preserve arc42 responsibility

- Overview material belongs in 01–04.
- Static decomposition belongs in 05.
- Interaction order and recovery sequences belong in 06.
- Deployment placement and lifecycle belong in 07.
- Shared mechanisms and rules belong in 08.
- Decision rationale belongs in 09.
- Verifiable quality scenarios belong in 10.
- Residual risks and persistent debt belong in 11.
- Canonical terminology belongs in 12.

A task-specific navigation result may cross several chapters. That does not weaken chapter ownership.

### 14.5 Validate migration

After each bounded migration step:

1. run structural checking;
2. correct metadata and reference failures;
3. run representative `choices` and `views` queries;
4. inspect whether results are relevant and reasonably small;
5. update links after moves or renames;
6. retain project-specific migration status outside this handbook;
7. separately validate semantic freshness against authoritative evidence.

Do not claim migration completion because files exist. Structural completion requires a successful complete-corpus check. Semantic completion requires project-appropriate architecture review and evidence.

## 15. Design Limits and Deferred Extensions

The core system intentionally leaves several extensions undefined unless evidence justifies them.

### 15.1 Multiple query values for one Facet

A query currently supplies one value for each Facet. OR, AND, exclusion, range, or mixed semantics for multiple queried values require an explicit design.

### 15.2 Facet hierarchy and wildcard

Facet values are flat by default. Parent-child inheritance, wildcard matching, aliases, and transitive selection are not implied.

### 15.3 Additional Facets

A project may add Facets through its index. Add one only when actual retrieval examples show stable ambiguity that existing dimensions cannot express economically.

### 15.4 Metadata precision

Exact matching can still return broad result sets when Views declare broad Concerns, Activities, or Facet values. Collect real excess-retrieval examples before splitting Views or adding dimensions.

### 15.5 Semantic freshness detection

The helper does not understand prose or compare it to implementation evidence. Semantic update triggers, review ownership, and revalidation policy require project governance beyond structural checking.

### 15.6 Packaging and integration

Package scripts, CI enforcement, editor support, generated reports, distribution, and executable packaging may vary by repository. They must preserve the same metadata and navigation semantics.

### 15.7 Relationship and metadata cost

Corpus-wide metadata may become expensive. Do not add fields, reverse relationships, or routing tables before actual maintenance evidence shows that their value exceeds their synchronization cost.

## 16. Rejected or Non-default Directions

### Natural-language navigation

Not part of the deterministic core. It would require semantic interpretation and introduce probabilistic behavior. A separate optional layer must not replace exact structural navigation.

### Incremental option discovery

Rejected as the normal agent workflow because it increases calls and context churn. `choices` exposes the complete reachable space in one call.

### Central registry of all Views

Rejected because every View addition, move, or deletion would require synchronized registry changes. Views self-describe; reverse indexes are generated.

### YAML-only definitions

Rejected because controlled definitions need human-readable explanation and are themselves governed Views.

### Concrete people as Stakeholders

Rejected by default. Stakeholders represent stable reader roles, not current personnel or login identities.

### Role-plus-Facet Stakeholders

Rejected by default. Reader role belongs to Stakeholder; system area and other orthogonal dimensions belong to Facets.

### Generic Context object

Rejected. Extensible Facets represent independent filter dimensions without hardcoding one project-specific context schema.

### Generic document status and archive

Rejected. Current Architecture Views are corrected, replaced, merged, split, or deleted. Git retains history; ADRs retain decision history.

### Separate View IDs

Rejected. Relative paths are View identities.

### Manually maintained chapter navigation

Rejected as a required mechanism. arc42 chapters retain structural ownership, while `choices` and `views` provide task-specific navigation. A chapter README must justify itself as a real View rather than duplicate file listings.

## 17. Principles for Future Changes

Before adding or changing a concept, field, command, or matching rule, ask:

1. Does it solve an observed reader or governance problem?
2. Does it reduce agent calls, latency, or irrelevant reading?
3. Is it orthogonal to Concern, Activity, Viewpoint, and existing Facets?
4. Can readers select it deterministically without semantic inference?
5. Is its vocabulary stable and controlled?
6. Does each relationship have one semantic owner?
7. Can reverse relationships be generated?
8. Does it create a second source of truth?
9. Does it preserve Viewpoint as a real observation angle?
10. Can the helper validate it mechanically?
11. Is maintenance cost lower than the cost of imprecise navigation?
12. Can the change wait for actual evidence?
13. Does it preserve the mandatory arc42 top-level structure?

Before restructuring a View, ask:

1. Is there a real situation where a reader needs one part without another?
2. Which arc42 chapter owns the subject?
3. Is the content current architecture, rationale, assurance, risk, debt, terminology, or navigation?
4. Does another View already own the same fact?
5. Is local implementation detail being mistaken for architecture?
6. Would deletion lose unique current information?
7. Can a shorter View answer the same reader question?
8. Will the resulting metadata produce useful queries?

## 18. Recommended Operating Workflow

### Find architecture for a task

1. Read this handbook only when documentation-system rules are needed.
2. Read executable help when exact CLI behavior is needed:

   ```bash
   bun archdoc.ts --help
   ```

3. Discover the corpus query space:

   ```bash
   bun archdoc.ts choices
   ```

   Or narrow by reader role:

   ```bash
   bun archdoc.ts choices --stakeholder <stakeholder>
   ```

4. Select one Concern, one supported Activity, one value for every Facet, and optional Viewpoint.
5. Retrieve Views:

   ```bash
   bun archdoc.ts views \
     --concern <concern> \
     --activity <activity> \
     --facet <facet>=<value> \
     [--facet <facet>=<value> ...] \
     [--stakeholder <stakeholder>] \
     [--viewpoint <viewpoint>]
   ```

6. Read every returned Markdown View.
7. Use authoritative requirements, code, tests, schema, deployment, and operating evidence when the task requires semantic validation.

### Change the corpus

1. Identify the owning arc42 chapter and reader boundary.
2. Update the canonical View rather than duplicating its facts.
3. Add complete metadata using defined vocabulary.
4. Update path references after moves or renames.
5. Run:

   ```bash
   bun archdoc.ts check
   ```

6. Test representative navigation queries.
7. Validate semantic freshness separately.

### Introduce a vocabulary or tool change

1. Collect real retrieval or governance evidence.
2. Identify relationship ownership and compatibility impact.
3. Update the accepted model, controlled definitions, helper behavior, and migration guidance coherently.
4. Keep project-specific status and examples outside this generic handbook.

## 19. Bottom Line

This system is a deterministic, agent-first navigation and governance layer for an arc42 Architecture Description.

Its essential commitments are:

```text
The arc42 top-level structure is mandatory.
01–04 and 12 are chapter documents.
05–11 are chapter directories containing reader-oriented Views.
00-architecture-index defines controlled vocabulary and navigation relationships.
Every architecture Markdown file is a governed View.
Every View declares one Viewpoint, Concerns, Activities, and values for every Facet.
Stakeholders expose Concerns.
Concerns constrain Activities.
Viewpoints frame Concerns and govern View interpretation.
Facets provide project-defined orthogonal filtering.
Stakeholder and Viewpoint are optional query filters.
Reverse relationships are generated.
Strict checking rejects invalid or unreachable Views.
Navigation is deterministic and normally requires at most two calls.
No LLM or semantic parser is used by the core helper.
No generic archive or document-status lifecycle exists.
Git preserves history.
Structural validity does not prove semantic freshness.
Project architecture and corpus status do not belong in this generic handbook.
```
