#!/usr/bin/env bun

import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

declare const Bun: {
  YAML: {
    parse(source: string): unknown;
  };
};

const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url));
const ARCHITECTURE_ROOT = resolve(PROJECT_ROOT, "docs/architecture");
const INDEX_ROOT = "00-architecture-index";

const COMMON_FIELDS = [
  "summary",
  "viewpoint",
  "concerns",
  "activities",
  "facets",
] as const;

const OPTIONAL_COMMON_FIELDS = ["stakeholders"] as const;

type Metadata = Record<string, unknown>;

type View = {
  path: string;
  summary: string;
  viewpoint: string;
  stakeholders?: string[];
  concerns: string[];
  activities: string[];
  facets: Record<string, string[]>;
  metadata: Metadata;
};

type Definition = {
  key: string;
  path: string;
  summary: string;
  metadata: Metadata;
};

type Model = {
  views: View[];
  stakeholders: Map<string, Definition>;
  concerns: Map<string, Definition>;
  activities: Map<string, Definition>;
  viewpoints: Map<string, Definition>;
  facets: Map<string, Definition>;
  facetValues: Map<string, Map<string, string>>;
};

type ParsedArguments = {
  command?: string;
  options: Map<string, string[]>;
  help: boolean;
};

type QueryRelationship = {
  facets: FacetQuery;
  viewpoints: string[];
};

class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

function usage(): string {
  return `Architecture Documentation Navigator

PURPOSE

  Find the architecture documents relevant to your current work in any project.

  If you only remember one thing:
    choices tells you what you can ask.
    views gives you the documents for that question.

  Normal workflow:
    1. Run choices to discover valid values and relationships.
    2. Choose a Concern, Activity, Facet values, and optional Viewpoint.
    3. Run views to retrieve matching document paths and summaries.
    4. Read the returned Markdown documents relevant to the task.

NAVIGATION MODEL

  [Stakeholder] → Concern → Activity → Facets → [Viewpoint] → Views

  This is a query path, not a directory path. Each part answers a different
  question about the documentation you need.

PARAMETER DISTINCTIONS

  Stakeholder = who you are / which reader role you use
    A reader role used to limit available Concerns and relevant Views.
    Examples: architect, developer, operator.
    Optional. If omitted, no reader-role filtering is applied.

  Concern = what property or problem matters
    A system property or problem you want to understand or evaluate.
    Examples: correctness, operability, security, operability.

  Activity = what you are doing now
    The kind of work you are performing.
    Examples: orient, change, diagnose, operate, assess, decide.

  Facet = an orthogonal filter dimension
    Each Facet is defined by the architecture index. The current Facet is
    domain, which identifies the mcp-shell responsibility area involved. Future Facets may
    describe other independent dimensions without changing this tool.
      Example Facet values might identify responsibility areas, environments,
    capabilities, or other project-specific dimensions. Run choices to see
    the values defined by the current architecture corpus.

    Use one --facet <facet>=<value> option for each defined Facet.

  Viewpoint = which observation angle you want
    overview  goals, scope, context, constraints, and strategy
    static    structure, responsibility, ownership, interfaces, dependencies
    dynamic   execution order, state changes, failure, and recovery
    decision  alternatives, rationale, consequences, and reassessment
    assurance quality, risks, technical debt, and validation

    Optional. If omitted, views returns all matching viewpoints.

  Short version:
    Stakeholder = who is reading?
    Concern     = what matters?
    Activity    = what are you doing?
    Facets      = which filter dimensions and values?
    Viewpoint   = what kind of explanation?

WHAT THESE PARAMETERS ARE NOT

  - Stakeholder is not a login identity or permission grant.
  - Stakeholder is not a system Domain or Facet value.
  - Concern is not a document filename or chapter.
  - Activity is not necessarily a runtime operation.
  - A Facet is not necessarily a deployment environment.
  - Viewpoint does not replace Concern, Activity, or Facets.
  - A valid individual value does not guarantee a valid complete query.

RELATIONSHIPS

  Stakeholder → Concern availability + View audience
    Which Concerns and Views are relevant to this reader role?

  Concern → Activity support
    Which Activities are meaningful for this Concern?
    This explains why some Concern + Activity combinations are rejected.

  Concern + Activity → Facets + Viewpoint
    Which complete queries lead to at least one architecture View?
    This is the final executable query space shown by choices.

COMMANDS

  choices [--stakeholder <stakeholder>]
    Discovery command. Shows definitions and reachable relationships.

    Omit --stakeholder to see the complete navigation space.
    Provide --stakeholder to see one reader role's relevant space.

    Output sections:
      - definitions and descriptions;
      - Stakeholder → Concern availability;
      - Concern → Activity support;
      - all reachable Concern / Activity → Facets [Viewpoints] queries,
        losslessly grouped by identical relationships.

  views [--stakeholder <stakeholder>] --concern <concern> \\
    --activity <activity> --facet <facet>=<value> \\
    [--facet <facet>=<value> ...] [--viewpoint <viewpoint>]
    Retrieval command. Returns matching architecture View paths and summaries.

    Required:
      --concern
      --activity
      --facet <facet>=<value>  One value for each defined Facet.

    Optional:
      --stakeholder  Validate Concern availability and filter Views by reader role.
      --viewpoint    Narrow results to one observation angle.

    Omit Stakeholder to query across all reader roles.

  check
    Structural governance command. Validates front matter, controlled values,
    references, relationships, and View reachability.

    It does not prove that architecture prose matches code, requirements,
    tests, databases, deployment, or operational evidence.

HOW TO USE choices

  Run:
    bun archdoc.ts choices

  Or narrow discovery:
    bun archdoc.ts choices --stakeholder developer

  choices prints definitions first. Each definition is described once.
  It then explains two smaller relationships before the final query map.
  Repeated Activities and Facet values with identical reachable relationships
  are grouped without removing any valid query.

  Example final query group:
    operability:
      diagnose | orient:
        domain=mcp-runtime | host-tools [dynamic, static]

  This means:
    --concern operability
    --activity diagnose or orient
    --facet domain=mcp-runtime or host-tools
    --viewpoint dynamic or static

  Every combination represented by one group is reachable. Choose one value
  from each grouped dimension when constructing a views command.

  The output is not a literal file tree. It does not represent a path named
  concern/activity/facet.

HOW TO CHOOSE A QUERY

  1. Activity: What am I doing?
  2. Concern: What property matters for that work?
  3. Facets: Which filter dimensions and values apply?
  4. Viewpoint: What kind of explanation do I want?
  5. Stakeholder: Do I want reader-role filtering?

  The relationship model starts with Stakeholder, but Stakeholder is optional
  in views. When supplied, it validates Concern availability and filters Views
  by reader role.

  Facets are discovered from the index automatically. Adding a Facet definition
  and adding that Facet to every View is enough; the tool source does not need
  to change. Every defined Facet must be supplied once to views.

STANDARD WORKFLOW

  1. Discover:
    bun archdoc.ts choices

  2. Optionally filter by reader role:
    bun archdoc.ts choices --stakeholder developer

  3. Retrieve documents:
    bun archdoc.ts views --stakeholder developer --concern operability --activity change --facet domain=<responsibility-area> --viewpoint dynamic

    Replace <responsibility-area> with a value from choices.

  4. Read the paths relevant to the task.

WHEN TO OMIT Stakeholder

  Omit it when:
    - you do not know which reader role applies;
    - you want the complete navigation space;
    - your work crosses multiple reader roles.

  Example:
    bun archdoc.ts views --concern operability --activity diagnose --facet domain=<responsibility-area> --viewpoint dynamic

    Replace <responsibility-area> with a value from choices.

WHEN TO PROVIDE Stakeholder

  Provide it when:
    - you want choices for one reader role;
    - you want View results scoped to that role.

  Example:
    bun archdoc.ts choices --stakeholder operator
    bun archdoc.ts views --stakeholder operator --concern operability --activity operate --facet domain=<responsibility-area> --viewpoint dynamic

    Replace <responsibility-area> with a value from choices.

WHEN TO OMIT Viewpoint

  Omit it to retrieve every matching observation angle:
    bun archdoc.ts views --concern operability --activity diagnose --facet domain=<responsibility-area>

    Replace <responsibility-area> with a value from choices.

  Provide it to retrieve one specific angle:
    --viewpoint overview   goals and overall strategy
    --viewpoint static     structure and ownership
    --viewpoint dynamic    behavior and recovery
    --viewpoint decision   architectural rationale
    --viewpoint assurance  quality and validation

COMMON SCENARIOS

  Understand the system structure:
    bun archdoc.ts views --concern architecture-coherence --activity orient --facet domain=<system-area> --viewpoint overview

  Change an application component:
    bun archdoc.ts views --stakeholder developer --concern maintainability --activity change --facet domain=<system-area> --viewpoint static

  Diagnose a production failure:
    bun archdoc.ts views --concern correctness --activity diagnose --facet domain=<system-area> --viewpoint dynamic

  Operate a deployment:
    bun archdoc.ts views --stakeholder operator --concern operability --activity operate --facet domain=<system-area> --viewpoint dynamic

  Review security controls:
    bun archdoc.ts views --concern security --activity assess --facet domain=<system-area> --viewpoint assurance

  Understand an architecture decision:
    bun archdoc.ts views --concern rationale --activity decide --facet domain=<system-area> --viewpoint decision

  Replace <system-area> with a domain value printed by choices.

ERRORS AND NEXT STEPS

  Unknown Stakeholder
    The reader role is not defined. Run choices to see valid Stakeholders.

  Unknown Concern
    The Concern is not defined. Run choices to see valid Concerns.

  Unknown Activity
    The Activity is not defined. Run choices to see valid Activities.

  Invalid --facet value
    Use the form --facet <facet>=<value>. Run choices to see valid Facets and
    values. Supply each defined Facet exactly once.

  Unknown Facet or Facet value
    The Facet or its value is not defined. Run choices to see valid Facets
    and values.

  Missing required Facet
    Every Facet defined by the index requires one --facet <facet>=<value>
    option. Run choices to see the required Facets and values.

  Unknown Viewpoint
    The Viewpoint is not defined. Run choices to see valid Viewpoints.

  Concern is not available to Stakeholder
    Choose a Concern listed for that role, or omit Stakeholder for a
    cross-role query.

  Concern does not support Activity
    The selected Concern does not define that Activity as meaningful.

  No architecture Views match
    The individual values are valid, but their complete combination has no
    matching document. Run choices and select a reachable query.

IMPORTANT

  - choices does not read document bodies.
  - views returns paths and summaries, not document contents.
  - Read relevant returned Markdown files for the actual architecture information.
  - Facets are not hardcoded; choices and views discover them from the index.
  - The tool is deterministic and does not interpret natural language.
  - The tool does not guess values from a task description.
  - Structural validity does not prove semantic freshness.
`;
}

function parseArguments(argv: string[]): ParsedArguments {
  const result: ParsedArguments = {
    command: undefined,
    options: new Map(),
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;

    if (argument === "--help" || argument === "-h") {
      result.help = true;
      continue;
    }

    if (!argument.startsWith("--")) {
      if (result.command !== undefined) {
        throw new CliError(`Unexpected positional argument: ${argument}`, 2);
      }
      result.command = argument;
      continue;
    }

    const key = argument.slice(2);
    if (!key) {
      throw new CliError("Invalid empty option.", 2);
    }
    if (key !== "facet" && result.options.has(key)) {
      throw new CliError(`Option --${key} was supplied more than once.`, 2);
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliError(`Option --${key} requires a value.`, 2);
    }

    result.options.set(key, [...(result.options.get(key) ?? []), value]);
    index += 1;
  }

  return result;
}

function assertAllowedOptions(
  options: Map<string, string[]>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of options.keys()) {
    if (!allowedSet.has(key)) {
      throw new CliError(`Unknown option --${key}.`, 2);
    }
  }
}

function requireOption(options: Map<string, string[]>, key: string): string {
  const values = options.get(key);
  if (values === undefined || values.length !== 1 || values[0]!.trim() === "") {
    throw new CliError(`Missing required option --${key}.`, 2);
  }
  return values[0]!;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFrontMatter(path: string, source: string, issues: string[]): Metadata | undefined {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    issues.push(`${path}: missing YAML front matter.`);
    return undefined;
  }

  const closingIndex = normalized.indexOf("\n---\n", 4);
  if (closingIndex < 0) {
    issues.push(`${path}: YAML front matter has no closing delimiter.`);
    return undefined;
  }

  const yamlSource = normalized.slice(4, closingIndex);
  try {
    const parsed: unknown = Bun.YAML.parse(yamlSource);
    if (!isRecord(parsed)) {
      issues.push(`${path}: YAML front matter must be a mapping.`);
      return undefined;
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push(`${path}: invalid YAML front matter: ${message}`);
    return undefined;
  }
}

function readString(
  metadata: Metadata,
  field: string,
  path: string,
  issues: string[],
): string | undefined {
  const value = metadata[field];
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${path}: ${field} must be a non-empty string.`);
    return undefined;
  }
  return value.trim();
}

function readStringList(
  metadata: Metadata,
  field: string,
  path: string,
  issues: string[],
): string[] | undefined {
  const value = metadata[field];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    issues.push(`${path}: ${field} must be a non-empty list of strings.`);
    return undefined;
  }

  const normalized = value.map((item) => (item as string).trim());
  if (new Set(normalized).size !== normalized.length) {
    issues.push(`${path}: ${field} contains duplicate values.`);
    return undefined;
  }
  return normalized;
}

function readFacetValues(
  metadata: Metadata,
  path: string,
  issues: string[],
): Record<string, string[]> | undefined {
  const rawFacets = metadata.facets;
  if (!isRecord(rawFacets) || Object.keys(rawFacets).length === 0) {
    issues.push(`${path}: facets must be a non-empty mapping.`);
    return undefined;
  }

  const facets: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(rawFacets)) {
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some((item) => typeof item !== "string" || item.trim() === "")
    ) {
      issues.push(`${path}: facets.${key} must be a non-empty list of strings.`);
      continue;
    }

    const normalized = value.map((item) => (item as string).trim());
    if (new Set(normalized).size !== normalized.length) {
      issues.push(`${path}: facets.${key} contains duplicate values.`);
      continue;
    }
    facets[key] = normalized;
  }

  return facets;
}

function definitionKind(path: string):
  | "stakeholders"
  | "concerns"
  | "activities"
  | "viewpoints"
  | "facets"
  | undefined {
  const match = path.match(
    /^00-architecture-index\/(stakeholders|concerns|activities|viewpoints|facets)\/([^/]+)\.md$/,
  );
  return match?.[1] as ReturnType<typeof definitionKind>;
}

function expectedFields(path: string): Set<string> {
  const fields = new Set<string>([...COMMON_FIELDS, ...OPTIONAL_COMMON_FIELDS]);
  const kind = definitionKind(path);
  if (kind === "stakeholders") fields.add("available_concerns");
  if (kind === "concerns") fields.add("supported_activities");
  if (kind === "viewpoints") fields.add("framed_concerns");
  if (kind === "facets") fields.add("values");
  return fields;
}

function validateFieldSet(path: string, metadata: Metadata, issues: string[]): void {
  const expected = expectedFields(path);
  const actual = new Set(Object.keys(metadata));

  const required = new Set<string>(COMMON_FIELDS);
  const kind = definitionKind(path);
  if (kind === "stakeholders") required.add("available_concerns");
  if (kind === "concerns") required.add("supported_activities");
  if (kind === "viewpoints") required.add("framed_concerns");
  if (kind === "facets") required.add("values");

  for (const field of required) {
    if (!actual.has(field)) {
      issues.push(`${path}: missing required field ${field}.`);
    }
  }
  for (const field of actual) {
    if (!expected.has(field)) {
      issues.push(`${path}: unknown field ${field}.`);
    }
  }
}

async function listMarkdownFiles(
  directory: string,
  prefix = "",
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      paths.push(...(await listMarkdownFiles(resolve(directory, entry.name), path)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      paths.push(path);
    }
  }

  return paths;
}

async function loadModel(strict = true): Promise<Model> {
  const issues: string[] = [];
  const paths = (await listMarkdownFiles(ARCHITECTURE_ROOT)).sort();

  if (paths.length === 0) {
    throw new CliError(`No Markdown files found under ${ARCHITECTURE_ROOT}.`);
  }

  const views: View[] = [];
  const rawMetadata = new Map<string, Metadata>();

  for (const path of paths) {
    const source = await readFile(resolve(ARCHITECTURE_ROOT, path), "utf8");
    const metadata = parseFrontMatter(path, source, issues);
    if (metadata === undefined) continue;

    validateFieldSet(path, metadata, issues);
    rawMetadata.set(path, metadata);

    const summary = readString(metadata, "summary", path, issues);
    const viewpoint = readString(metadata, "viewpoint", path, issues);
    const stakeholders = metadata.stakeholders === undefined
      ? undefined
      : readStringList(metadata, "stakeholders", path, issues);
    const concerns = readStringList(metadata, "concerns", path, issues);
    const activities = readStringList(metadata, "activities", path, issues);
    const facets = readFacetValues(metadata, path, issues);

    if (
      summary &&
      viewpoint &&
      (metadata.stakeholders === undefined || stakeholders) &&
      concerns &&
      activities &&
      facets
    ) {
      views.push({
        path,
        summary,
        viewpoint,
        stakeholders,
        concerns,
        activities,
        facets,
        metadata,
      });
    }
  }

  const definitions = {
    stakeholders: new Map<string, Definition>(),
    concerns: new Map<string, Definition>(),
    activities: new Map<string, Definition>(),
    viewpoints: new Map<string, Definition>(),
    facets: new Map<string, Definition>(),
  };

  for (const view of views) {
    const kind = definitionKind(view.path);
    if (kind === undefined) continue;
    const key = view.path.slice(view.path.lastIndexOf("/") + 1, -3);
    const registry = definitions[kind];
    if (registry.has(key)) {
      issues.push(`${view.path}: duplicate ${kind} definition key ${key}.`);
      continue;
    }
    registry.set(key, {
      key,
      path: view.path,
      summary: view.summary,
      metadata: view.metadata,
    });
  }

  for (const kind of Object.keys(definitions) as Array<keyof typeof definitions>) {
    if (definitions[kind].size === 0) {
      issues.push(`${INDEX_ROOT}/${kind}: no definitions found.`);
    }
  }

  const facetValues = new Map<string, Map<string, string>>();
  for (const [key, definition] of definitions.facets) {
    const values = definition.metadata.values;
    if (!isRecord(values) || Object.keys(values).length === 0) {
      issues.push(`${definition.path}: values must be a non-empty key-to-summary mapping.`);
      continue;
    }

    const parsedValues = new Map<string, string>();
    for (const [valueKey, summary] of Object.entries(values)) {
      if (typeof summary !== "string" || summary.trim() === "") {
        issues.push(`${definition.path}: values.${valueKey} must be a non-empty summary string.`);
        continue;
      }
      parsedValues.set(valueKey, summary.trim());
    }
    facetValues.set(key, parsedValues);
  }

  function validateReferences(
    path: string,
    field: string,
    values: string[] | undefined,
    registry: Map<string, Definition>,
  ): void {
    if (values === undefined) return;
    for (const value of values) {
      if (!registry.has(value)) {
        issues.push(`${path}: ${field} references undefined key ${value}.`);
      }
    }
  }

  for (const definition of definitions.stakeholders.values()) {
    const values = readStringList(
      definition.metadata,
      "available_concerns",
      definition.path,
      issues,
    );
    validateReferences(
      definition.path,
      "available_concerns",
      values,
      definitions.concerns,
    );
  }

  for (const definition of definitions.concerns.values()) {
    const values = readStringList(
      definition.metadata,
      "supported_activities",
      definition.path,
      issues,
    );
    validateReferences(
      definition.path,
      "supported_activities",
      values,
      definitions.activities,
    );
  }

  for (const definition of definitions.viewpoints.values()) {
    const values = readStringList(
      definition.metadata,
      "framed_concerns",
      definition.path,
      issues,
    );
    validateReferences(
      definition.path,
      "framed_concerns",
      values,
      definitions.concerns,
    );
  }

  const definedFacetKeys = new Set(definitions.facets.keys());
  for (const view of views) {
    validateReferences(
      view.path,
      "stakeholders",
      view.stakeholders,
      definitions.stakeholders,
    );
    validateReferences(
      view.path,
      "viewpoint",
      [view.viewpoint],
      definitions.viewpoints,
    );
    validateReferences(
      view.path,
      "concerns",
      view.concerns,
      definitions.concerns,
    );
    validateReferences(
      view.path,
      "activities",
      view.activities,
      definitions.activities,
    );

    const actualFacetKeys = new Set(Object.keys(view.facets));
    for (const key of definedFacetKeys) {
      if (!actualFacetKeys.has(key)) {
        issues.push(`${view.path}: missing required Facet ${key}.`);
      }
    }
    for (const key of actualFacetKeys) {
      if (!definedFacetKeys.has(key)) {
        issues.push(`${view.path}: references undefined Facet ${key}.`);
        continue;
      }
      const allowedValues = facetValues.get(key);
      for (const value of view.facets[key] ?? []) {
        if (!allowedValues?.has(value)) {
          issues.push(`${view.path}: facets.${key} references undefined value ${value}.`);
        }
      }
    }

    const viewpoint = definitions.viewpoints.get(view.viewpoint);
    const framedConcerns = viewpoint
      ? new Set(
          readStringList(
            viewpoint.metadata,
            "framed_concerns",
            viewpoint.path,
            issues,
          ) ?? [],
        )
      : new Set<string>();

    const activitiesInEffectivePairs = new Set<string>();

    for (const concern of view.concerns) {
      if (viewpoint && !framedConcerns.has(concern)) {
        issues.push(
          `${view.path}: Viewpoint ${view.viewpoint} does not frame Concern ${concern}.`,
        );
      }

      const concernDefinition = definitions.concerns.get(concern);
      if (!concernDefinition) continue;
      const supported = new Set(
        readStringList(
          concernDefinition.metadata,
          "supported_activities",
          concernDefinition.path,
          issues,
        ) ?? [],
      );
      const effectiveActivities = view.activities.filter((activity) =>
        supported.has(activity),
      );

      if (effectiveActivities.length === 0) {
        issues.push(
          `${view.path}: Concern ${concern} has no supported declared Activity.`,
        );
      }

      for (const activity of effectiveActivities) {
        activitiesInEffectivePairs.add(activity);
      }
    }

    for (const activity of view.activities) {
      if (!activitiesInEffectivePairs.has(activity)) {
        issues.push(
          `${view.path}: Activity ${activity} is unsupported by every declared Concern.`,
        );
      }
    }
  }

  for (const view of views) {
    const reachable = Array.from(definitions.stakeholders.values()).some(
      (stakeholder) =>
        (view.stakeholders === undefined ||
          view.stakeholders.includes(stakeholder.key)) &&
        view.concerns.some((concern) =>
          definitionStringList(stakeholder, "available_concerns").includes(concern),
        ),
    );
    if (!reachable) {
      issues.push(`${view.path}: orphan View; no Stakeholder can select any declared Concern.`);
    }
  }

  if (issues.length > 0 && strict) {
    const rendered = issues.map((issue) => `- ${issue}`).join("\n");
    throw new CliError(
      `Architecture documentation is invalid (${issues.length} issue${issues.length === 1 ? "" : "s"}):\n${rendered}`,
    );
  }

  if (issues.length > 0 && !strict) {
    const invalidPaths = new Set(
      paths.filter((path) =>
        issues.some((issue) => issue.startsWith(`${path}:`)),
      ),
    );

    if (invalidPaths.size > 0) {
      console.error(
        `Warning: excluded ${invalidPaths.size} invalid architecture document${invalidPaths.size === 1 ? "" : "s"}; run 'bun archdoc.ts check' for details.`,
      );
    }

    const activeViews = views.filter((view) => !invalidPaths.has(view.path));
    const activeDefinitions = {
      stakeholders: new Map<string, Definition>(),
      concerns: new Map<string, Definition>(),
      activities: new Map<string, Definition>(),
      viewpoints: new Map<string, Definition>(),
      facets: new Map<string, Definition>(),
    };

    for (const view of activeViews) {
      const kind = definitionKind(view.path);
      if (kind === undefined) continue;
      const key = view.path.slice(view.path.lastIndexOf("/") + 1, -3);
      activeDefinitions[kind].set(key, {
        key,
        path: view.path,
        summary: view.summary,
        metadata: view.metadata,
      });
    }

    const activeFacetValues = new Map<string, Map<string, string>>();
    for (const [key, definition] of activeDefinitions.facets) {
      const values = definition.metadata.values;
      if (!isRecord(values)) continue;
      activeFacetValues.set(
        key,
        new Map(
          Object.entries(values).filter(
            ([, summary]) => typeof summary === "string" && summary.trim() !== "",
          ) as Array<[string, string]>,
        ),
      );
    }

    return {
      views: activeViews,
      stakeholders: activeDefinitions.stakeholders,
      concerns: activeDefinitions.concerns,
      activities: activeDefinitions.activities,
      viewpoints: activeDefinitions.viewpoints,
      facets: activeDefinitions.facets,
      facetValues: activeFacetValues,
    };
  }

  return {
    views,
    stakeholders: definitions.stakeholders,
    concerns: definitions.concerns,
    activities: definitions.activities,
    viewpoints: definitions.viewpoints,
    facets: definitions.facets,
    facetValues,
  };
}

function definitionStringList(definition: Definition, field: string): string[] {
  return definition.metadata[field] as string[];
}

function validateStakeholderConcernActivity(
  model: Model,
  stakeholderKey: string | undefined,
  concernKey: string,
  activityKey: string,
): void {
  const stakeholder = stakeholderKey === undefined
    ? undefined
    : model.stakeholders.get(stakeholderKey);
  if (stakeholderKey !== undefined && !stakeholder) {
    throw new CliError(`Unknown Stakeholder: ${stakeholderKey}.`);
  }

  const concern = model.concerns.get(concernKey);
  if (!concern) {
    throw new CliError(`Unknown Concern: ${concernKey}.`);
  }

  if (
    stakeholder &&
    !definitionStringList(stakeholder, "available_concerns").includes(concernKey)
  ) {
    throw new CliError(
      `Concern ${concernKey} is not available to Stakeholder ${stakeholderKey}.`,
    );
  }

  if (!model.activities.has(activityKey)) {
    throw new CliError(`Unknown Activity: ${activityKey}.`);
  }

  if (!definitionStringList(concern, "supported_activities").includes(activityKey)) {
    throw new CliError(
      `Concern ${concernKey} does not support Activity ${activityKey}.`,
    );
  }
}

type FacetQuery = Map<string, string>;

function facetKeys(model: Model): string[] {
  return Array.from(model.facets.keys()).sort();
}

function parseFacetQuery(
  options: Map<string, string[]>,
  model: Model,
): FacetQuery {
  const query: FacetQuery = new Map();
  for (const argument of options.get("facet") ?? []) {
    const separator = argument.indexOf("=");
    if (separator <= 0 || separator === argument.length - 1) {
      throw new CliError(
        `Option --facet expects <facet>=<value>; received ${argument}.`,
        2,
      );
    }

    const key = argument.slice(0, separator).trim();
    const value = argument.slice(separator + 1).trim();
    if (query.has(key)) {
      throw new CliError(`Facet ${key} was supplied more than once.`, 2);
    }
    query.set(key, value);
  }

  for (const key of query.keys()) {
    const values = model.facetValues.get(key);
    if (!values) {
      throw new CliError(`Unknown Facet: ${key}.`, 2);
    }
    const value = query.get(key)!;
    if (!values.has(value)) {
      throw new CliError(`Unknown value for Facet ${key}: ${value}.`, 2);
    }
  }

  for (const key of facetKeys(model)) {
    if (!query.has(key)) {
      throw new CliError(`Missing required Facet: ${key}.`, 2);
    }
  }

  return query;
}

function facetValueCombinations(
  model: Model,
  views: View[],
): FacetQuery[] {
  const keys = facetKeys(model);
  const combinations: FacetQuery[] = [];

  const visit = (
    index: number,
    current: FacetQuery,
    valuesByFacet: Map<string, string[]>,
  ): void => {
    if (index === keys.length) {
      combinations.push(new Map(current));
      return;
    }

    const key = keys[index]!;
    const values = valuesByFacet.get(key);
    if (!values) return;
    for (const value of values) {
      current.set(key, value);
      visit(index + 1, current, valuesByFacet);
    }
    current.delete(key);
  };

  for (const view of views) {
    const valuesByFacet = new Map<string, string[]>(
      keys.map((key) => [key, view.facets[key] ?? []]),
    );
    visit(0, new Map(), valuesByFacet);
  }

  const unique = new Map<string, FacetQuery>();
  for (const combination of combinations) {
    const identity = keys
      .map((key) => `${key}=${combination.get(key)}`)
      .join(";");
    unique.set(identity, combination);
  }
  return Array.from(unique.values());
}

function matchesView(
  view: View,
  query: {
    stakeholder?: string;
    concern: string;
    activity: string;
    facets: FacetQuery;
    viewpoint?: string;
  },
): boolean {
  return (
    (query.stakeholder === undefined ||
      view.stakeholders === undefined ||
      view.stakeholders.includes(query.stakeholder)) &&
    view.concerns.includes(query.concern) &&
    view.activities.includes(query.activity) &&
    Array.from(query.facets.entries()).every(([key, value]) =>
      (view.facets[key] ?? []).includes(value),
    ) &&
    (query.viewpoint === undefined || view.viewpoint === query.viewpoint)
  );
}

function printDefinitionGroup(
  title: string,
  definitions: Definition[],
): void {
  console.log(`${title}:`);
  for (const definition of definitions.sort((left, right) =>
    left.key.localeCompare(right.key),
  )) {
    console.log(`- ${definition.key} — ${definition.summary}`);
  }
  console.log();
}

function printKeySummaryGroup(
  title: string,
  values: Map<string, string>,
): void {
  console.log(`${title}:`);
  for (const [key, summary] of Array.from(values.entries()).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    console.log(`- ${key} — ${summary}`);
  }
  console.log();
}

function facetQueryIdentity(model: Model, facets: FacetQuery): string {
  return facetKeys(model)
    .map((facetKey) => `${facetKey}=${facets.get(facetKey)}`)
    .join("\u001f");
}

function queryRelationshipsIdentity(
  model: Model,
  relationships: QueryRelationship[],
): string {
  return relationships
    .map(({ facets, viewpoints }) =>
      `${facetQueryIdentity(model, facets)}\u001e${viewpoints.join("\u001f")}`
    )
    .sort()
    .join("\u001d");
}

function formatFacetAlternatives(model: Model, queries: FacetQuery[]): string {
  const keys = facetKeys(model);
  const sorted = [...queries].sort((left, right) =>
    facetQueryIdentity(model, left).localeCompare(facetQueryIdentity(model, right))
  );

  if (keys.length === 1) {
    const key = keys[0]!;
    return `${key}=${sorted.map((query) => query.get(key)).join(" | ")}`;
  }

  return sorted
    .map((query) =>
      `{${keys.map((key) => `${key}=${query.get(key)}`).join("; ")}}`
    )
    .join(" | ");
}

function printGroupedQueryRelationships(
  model: Model,
  relationships: Map<string, Map<string, QueryRelationship[]>>,
): void {
  const queryCount = Array.from(relationships.values()).reduce(
    (concernTotal, activities) =>
      concernTotal + Array.from(activities.values()).reduce(
        (activityTotal, queries) => activityTotal + queries.length,
        0,
      ),
    0,
  );

  console.log(
    `Reachable queries (Concern → Activity → Facets [Viewpoints]; ${queryCount} Concern / Activity / Facet combinations represented):`,
  );

  for (const [concernKey, activityRelationships] of Array.from(
    relationships.entries(),
  ).sort(([left], [right]) => left.localeCompare(right))) {
    console.log(`- ${concernKey}:`);

    const activityGroups = new Map<
      string,
      { activities: string[]; queries: QueryRelationship[] }
    >();
    for (const [activityKey, queries] of Array.from(
      activityRelationships.entries(),
    ).sort(([left], [right]) => left.localeCompare(right))) {
      const identity = queryRelationshipsIdentity(model, queries);
      const group = activityGroups.get(identity);
      if (group) {
        group.activities.push(activityKey);
      } else {
        activityGroups.set(identity, { activities: [activityKey], queries });
      }
    }

    for (const { activities, queries } of Array.from(activityGroups.values()).sort(
      (left, right) => left.activities[0]!.localeCompare(right.activities[0]!),
    )) {
      console.log(`  ${activities.join(" | ")}:`);

      const viewpointGroups = new Map<string, FacetQuery[]>();
      for (const { facets, viewpoints } of queries) {
        const identity = viewpoints.join("\u001f");
        const groupedFacets = viewpointGroups.get(identity) ?? [];
        groupedFacets.push(facets);
        viewpointGroups.set(identity, groupedFacets);
      }

      for (const [viewpointIdentity, groupedFacets] of Array.from(
        viewpointGroups.entries(),
      ).sort(([, left], [, right]) =>
        facetQueryIdentity(model, left[0]!).localeCompare(
          facetQueryIdentity(model, right[0]!),
        )
      )) {
        const viewpoints = viewpointIdentity.split("\u001f");
        console.log(
          `    ${formatFacetAlternatives(model, groupedFacets)} [${viewpoints.join(", ")}]`,
        );
      }
    }
  }
}

async function runCheck(options: Map<string, string[]>): Promise<void> {
  assertAllowedOptions(options, []);
  const model = await loadModel();
  console.log(
    `OK: ${model.views.length} Views, ${model.stakeholders.size} Stakeholders, ${model.concerns.size} Concerns, ${model.activities.size} Activities, ${model.viewpoints.size} Viewpoints, ${model.facets.size} Facets.`,
  );
}

async function runChoices(options: Map<string, string[]>): Promise<void> {
  assertAllowedOptions(options, ["stakeholder"]);
  const stakeholderKey = options.get("stakeholder")?.[0];
  const model = await loadModel(false);

  let selectedStakeholders: Definition[];
  if (stakeholderKey !== undefined) {
    const stakeholder = model.stakeholders.get(stakeholderKey);
    if (!stakeholder) {
      throw new CliError(`Unknown Stakeholder: ${stakeholderKey}.`);
    }
    selectedStakeholders = [stakeholder];
  } else {
    selectedStakeholders = Array.from(model.stakeholders.values());
  }

  const concernKeys = Array.from(
    new Set(
      selectedStakeholders.flatMap((stakeholder) =>
        definitionStringList(stakeholder, "available_concerns"),
      ),
    ),
  ).sort();

  const reachableActivities = new Set<string>();
  const reachableFacetValues = new Map<string, Set<string>>();
  const reachableViewpoints = new Set<string>();
  const relationships = new Map<
    string,
    Map<string, QueryRelationship[]>
  >();
  const combinations = facetValueCombinations(model, model.views);

  for (const concernKey of concernKeys) {
    const concern = model.concerns.get(concernKey);
    if (!concern) continue;

    for (const activityKey of definitionStringList(
      concern,
      "supported_activities",
    ).sort()) {
      const queryRelationships: QueryRelationship[] = [];

      for (const facets of combinations) {
        const matching = model.views.filter((view) =>
          matchesView(view, {
            stakeholder: stakeholderKey,
            concern: concernKey,
            activity: activityKey,
            facets,
          }),
        );
        if (matching.length === 0) continue;

        const viewpoints = Array.from(
          new Set(matching.map((view) => view.viewpoint)),
        ).sort();
        queryRelationships.push({ facets, viewpoints });
        for (const [facetKey, facetValue] of facets) {
          const values = reachableFacetValues.get(facetKey) ?? new Set<string>();
          values.add(facetValue);
          reachableFacetValues.set(facetKey, values);
        }
        for (const viewpoint of viewpoints) reachableViewpoints.add(viewpoint);
      }

      if (queryRelationships.length > 0) {
        reachableActivities.add(activityKey);
        let concernRelationships = relationships.get(concernKey);
        if (!concernRelationships) {
          concernRelationships = new Map();
          relationships.set(concernKey, concernRelationships);
        }
        concernRelationships.set(activityKey, queryRelationships);
      }
    }
  }

  if (relationships.size === 0) {
    const subject = stakeholderKey === undefined
      ? "available Stakeholders"
      : `Stakeholder ${stakeholderKey}`;
    throw new CliError(`${subject} have no reachable architecture Views.`);
  }

  const stakeholderDefinitions = stakeholderKey === undefined
    ? Array.from(model.stakeholders.values())
    : selectedStakeholders;
  const concernDefinitions = concernKeys
    .map((key) => model.concerns.get(key))
    .filter((definition): definition is Definition => definition !== undefined);
  const activityDefinitions = Array.from(reachableActivities)
    .map((key) => model.activities.get(key))
    .filter((definition): definition is Definition => definition !== undefined);
  const viewpointDefinitions = Array.from(reachableViewpoints)
    .map((key) => model.viewpoints.get(key))
    .filter((definition): definition is Definition => definition !== undefined);
  console.log("Architecture navigation");
  console.log("Query shape: Stakeholder → Concern → Activity → Facets → optional Viewpoint\n");

  printDefinitionGroup("Stakeholders", stakeholderDefinitions);
  printDefinitionGroup("Concerns", concernDefinitions);
  printDefinitionGroup("Activities", activityDefinitions);
  console.log("Facets:");
  for (const facetKey of facetKeys(model)) {
    const facet = model.facets.get(facetKey)!;
    console.log(`- ${facetKey} — ${facet.summary}`);
    const values = model.facetValues.get(facetKey)!;
    for (const [valueKey, summary] of Array.from(values.entries()).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      if (!reachableFacetValues.get(facetKey)?.has(valueKey)) continue;
      console.log(`  - ${valueKey} — ${summary}`);
    }
  }
  console.log();
  printDefinitionGroup("Viewpoints", viewpointDefinitions);

  console.log("Stakeholder → Concern availability:");
  for (const stakeholder of stakeholderDefinitions.sort((left, right) =>
    left.key.localeCompare(right.key),
  )) {
    const available = definitionStringList(
      stakeholder,
      "available_concerns",
    ).filter((key) => concernKeys.includes(key)).sort();
    console.log(`- ${stakeholder.key}: ${available.join(", ")}`);
  }
  console.log();

  console.log("Concern → Activity support:");
  for (const concern of concernDefinitions.sort((left, right) =>
    left.key.localeCompare(right.key),
  )) {
    const activities = definitionStringList(
      concern,
      "supported_activities",
    ).filter((key) => reachableActivities.has(key)).sort();
    console.log(`- ${concern.key}: ${activities.join(", ")}`);
  }
  console.log();

  printGroupedQueryRelationships(model, relationships);
}

async function runViews(options: Map<string, string[]>): Promise<void> {
  assertAllowedOptions(options, [
    "stakeholder",
    "concern",
    "activity",
    "facet",
    "viewpoint",
  ]);

  const stakeholder = options.get("stakeholder")?.[0];
  const concern = requireOption(options, "concern");
  const activity = requireOption(options, "activity");
  const viewpoint = options.get("viewpoint")?.[0];

  const model = await loadModel(false);
  validateStakeholderConcernActivity(
    model,
    stakeholder,
    concern,
    activity,
  );

  const facets = parseFacetQuery(options, model);

  if (viewpoint !== undefined) {
    const viewpointDefinition = model.viewpoints.get(viewpoint);
    if (!viewpointDefinition) {
      throw new CliError(`Unknown Viewpoint: ${viewpoint}.`);
    }
    if (
      !definitionStringList(
        viewpointDefinition,
        "framed_concerns",
      ).includes(concern)
    ) {
      throw new CliError(
        `Viewpoint ${viewpoint} does not frame Concern ${concern}.`,
      );
    }
  }

  const matching = model.views
    .filter((view) =>
      matchesView(view, {
        stakeholder,
        concern,
        activity,
        facets,
        viewpoint,
      }),
    )
    .sort((left, right) => left.path.localeCompare(right.path));

  if (matching.length === 0) {
    throw new CliError("No architecture Views match the supplied query.");
  }

  for (const [index, view] of matching.entries()) {
    if (index > 0) console.log();
    console.log(`docs/architecture/${view.path}`);
    console.log(`  ${view.summary}`);
  }
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help || parsed.command === undefined) {
    console.log(usage());
    return;
  }

  if (parsed.command === "check") {
    await runCheck(parsed.options);
    return;
  }
  if (parsed.command === "choices") {
    await runChoices(parsed.options);
    return;
  }
  if (parsed.command === "views") {
    await runViews(parsed.options);
    return;
  }

  throw new CliError(`Unknown command: ${parsed.command}.\n\n${usage()}`, 2);
}

try {
  await main();
} catch (error) {
  if (error instanceof CliError) {
    console.error(error.message);
    process.exit(error.exitCode);
  }
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
}
