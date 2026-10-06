import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export type SkillSummary = {
  name: string;
  description: string;
};

export type Skill = SkillSummary & {
  directory: string;
  instructions: string;
};

export type SkillDiagnostic = {
  path: string;
  reason: string;
};

type SkillCatalogOptions = {
  root?: string;
  onDiagnostic?: (diagnostic: SkillDiagnostic) => void;
};

type SkillRecord = Skill & {
  sourcePath: string;
};

function compareEntryNames(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function parseFrontmatter(content: string): unknown {
  const match = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) throw new Error("missing YAML frontmatter");
  return parseYaml(match[1]);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export class SkillCatalog {
  readonly root: string;
  private readonly onDiagnostic: (diagnostic: SkillDiagnostic) => void;

  constructor(options: SkillCatalogOptions = {}) {
    this.root = options.root ?? join(homedir(), ".agents", "skills");
    this.onDiagnostic = options.onDiagnostic ?? ((diagnostic) => {
      console.warn(`[skills] ${diagnostic.path}: ${diagnostic.reason}`);
    });
  }

  async discover(): Promise<SkillSummary[]> {
    const records = await this.scan();
    return [...records.values()]
      .map(({ name, description }) => ({ name, description }))
      .sort((left, right) => compareEntryNames(left.name, right.name));
  }

  async load(name: string): Promise<Skill | null> {
    const record = (await this.scan()).get(name);
    if (!record) return null;
    return {
      name: record.name,
      description: record.description,
      directory: record.directory,
      instructions: record.instructions,
    };
  }

  private diagnostic(path: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    this.onDiagnostic({ path, reason });
  }

  private async scan(): Promise<Map<string, SkillRecord>> {
    const records = new Map<string, SkillRecord>();
    const visitedDirectories = new Set<string>();
    const visitedFiles = new Set<string>();

    await this.walkDirectory(this.root, records, visitedDirectories, visitedFiles, true);
    return records;
  }

  private async walkDirectory(
    directory: string,
    records: Map<string, SkillRecord>,
    visitedDirectories: Set<string>,
    visitedFiles: Set<string>,
    isRoot = false,
  ): Promise<void> {
    let realDirectory: string;
    try {
      realDirectory = await realpath(directory);
      const directoryStat = await stat(realDirectory);
      if (!directoryStat.isDirectory()) {
        this.diagnostic(directory, new Error("skill tree entry is not a directory"));
        return;
      }
    } catch (error: any) {
      if (isRoot && error?.code === "ENOENT") return;
      this.diagnostic(directory, error);
      return;
    }

    if (visitedDirectories.has(realDirectory)) return;
    visitedDirectories.add(realDirectory);

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      this.diagnostic(directory, error);
      return;
    }
    entries.sort((left, right) => compareEntryNames(left.name, right.name));

    for (const entry of entries) {
      const path = join(directory, entry.name);

      if (entry.name === "SKILL.md") {
        await this.readSkill(path, realDirectory, records, visitedFiles);
        continue;
      }

      if (entry.isDirectory()) {
        await this.walkDirectory(path, records, visitedDirectories, visitedFiles);
        continue;
      }

      if (!entry.isSymbolicLink()) continue;

      try {
        const targetStat = await stat(path);
        if (targetStat.isDirectory()) {
          await this.walkDirectory(path, records, visitedDirectories, visitedFiles);
        }
      } catch (error) {
        this.diagnostic(path, error);
      }
    }
  }

  private async readSkill(
    path: string,
    directory: string,
    records: Map<string, SkillRecord>,
    visitedFiles: Set<string>,
  ): Promise<void> {
    let realFile: string;
    let content: string;
    try {
      realFile = await realpath(path);
      if (visitedFiles.has(realFile)) return;

      const fileStat = await stat(realFile);
      if (!fileStat.isFile()) throw new Error("SKILL.md is not a regular file");
      content = await readFile(path, "utf8");
    } catch (error) {
      this.diagnostic(path, error);
      return;
    }

    let metadata: unknown;
    try {
      metadata = parseFrontmatter(content);
    } catch (error) {
      this.diagnostic(path, error);
      visitedFiles.add(realFile);
      return;
    }

    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
      this.diagnostic(path, new Error("YAML frontmatter must be a mapping"));
      visitedFiles.add(realFile);
      return;
    }

    const name = (metadata as Record<string, unknown>).name;
    const description = (metadata as Record<string, unknown>).description;
    if (!isNonBlankString(name)) {
      this.diagnostic(path, new Error("skill name must be a non-empty string"));
      visitedFiles.add(realFile);
      return;
    }
    if (!isNonBlankString(description)) {
      this.diagnostic(path, new Error("skill description must be a non-empty string"));
      visitedFiles.add(realFile);
      return;
    }

    visitedFiles.add(realFile);
    const previous = records.get(name);
    if (previous) {
      this.onDiagnostic({
        path,
        reason: `duplicate skill name ${JSON.stringify(name)} replaces earlier skill at ${previous.sourcePath}`,
      });
    }
    records.set(name, {
      name,
      description,
      directory,
      instructions: content,
      sourcePath: path,
    });
  }
}
