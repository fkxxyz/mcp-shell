import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const repoRoot = process.cwd();
const webRoot = resolve(repoRoot, "web/src");
const backendRoot = resolve(repoRoot, "src");
const contractsRoot = resolve(backendRoot, "contracts");
const violations = [];

for (const file of await sourceFiles(webRoot)) {
  const source = await readFile(file, "utf8");
  for (const specifier of moduleSpecifiers(source)) {
    if (!specifier.startsWith(".")) continue;

    const target = resolve(dirname(file), specifier);
    if (!isWithin(target, backendRoot) || isWithin(target, contractsRoot)) continue;

    violations.push(
      relative(repoRoot, file) + " imports backend implementation " + specifier,
    );
  }
}

if (violations.length > 0) {
  console.error([
    "Web source may depend on src/contracts only; backend implementation imports are forbidden:",
    ...violations.map((item) => "- " + item),
  ].join("\n"));
  process.exit(1);
}

console.log("Web dependency boundary: OK");

async function sourceFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await sourceFiles(path));
    } else if (entry.isFile() && (path.endsWith(".ts") || path.endsWith(".tsx"))) {
      result.push(path);
    }
  }
  return result;
}

function moduleSpecifiers(source) {
  const patterns = [
    /\\b(?:import|export)\\s+(?:type\\s+)?[^;]*?\\s+from\\s*["\']([^"\']+)["\']/g,
    /\\bimport\\s*["\']([^"\']+)["\']/g,
    /\\bimport\\s*\\(\\s*["\']([^"\']+)["\']\\s*\\)/g,
  ];
  const result = new Set();
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) result.add(match[1]);
  }
  return result;
}

function isWithin(path, root) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
