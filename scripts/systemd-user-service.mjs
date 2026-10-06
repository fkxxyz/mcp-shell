import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDirectory, "..");

export const MANAGED_MARKER = "# Managed by mcp-shell. Source: deploy/systemd/mcp-shell.service.in";
const NODE_TOKEN = "@@NODE@@";
const ENTRYPOINT_TOKEN = "@@ENTRYPOINT@@";
const UNIT_NAME = "mcp-shell.service";

const expectedEffectiveProperties = {
  LoadState: "loaded",
  KillSignal: "15",
  KillMode: "mixed",
  SendSIGKILL: "yes",
  TimeoutStopUSec: "15s",
  NeedDaemonReload: "no",
};

export function userUnitPath(options = {}) {
  const home = options.home ?? homedir();
  const environment = options.env ?? process.env;
  const configuredHome = environment.XDG_CONFIG_HOME;
  if (configuredHome && !isAbsolute(configuredHome)) {
    throw new Error(`XDG_CONFIG_HOME must be absolute: ${configuredHome}`);
  }
  const configHome = configuredHome || join(home, ".config");
  return join(configHome, "systemd", "user", UNIT_NAME);
}

export function renderUnit(template, { nodePath, entrypoint }) {
  for (const token of [NODE_TOKEN, ENTRYPOINT_TOKEN]) {
    if (countOccurrences(template, token) !== 1) {
      throw new Error(`Systemd unit template must contain ${token} exactly once`);
    }
  }

  const rendered = template
    .replace(NODE_TOKEN, () => quoteSystemdExecArgument(nodePath))
    .replace(ENTRYPOINT_TOKEN, () => quoteSystemdExecArgument(entrypoint));

  if (!rendered.startsWith(`${MANAGED_MARKER}\n`)) {
    throw new Error("Systemd unit template is missing the managed marker");
  }
  return rendered;
}

export function isManagedUnit(content) {
  return content.startsWith(`${MANAGED_MARKER}\n`);
}

export function quoteSystemdExecArgument(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Systemd ExecStart arguments must be non-empty strings");
  }
  if (/[\0\r\n]/.test(value)) {
    throw new Error("Systemd ExecStart arguments cannot contain NUL or newlines");
  }

  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, () => "$$")
    .replace(/%/g, "%%");
  return `"${escaped}"`;
}

export function parseRenderedExecStart(unit) {
  const lines = unit.split(/\r?\n/).filter((line) => line.startsWith("ExecStart="));
  if (lines.length !== 1) throw new Error("Managed systemd unit must contain exactly one ExecStart");

  const args = parseQuotedArguments(lines[0].slice("ExecStart=".length));
  if (args.length !== 2) throw new Error("Managed systemd unit ExecStart must contain node and entrypoint only");
  return { nodePath: args[0], entrypoint: args[1] };
}

export function parseSystemctlShow(output) {
  const properties = {};
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    properties[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return properties;
}

export function effectivePropertyErrors(properties, expectedFragmentPath) {
  const errors = [];
  for (const [name, expected] of Object.entries(expectedEffectiveProperties)) {
    const actual = properties[name];
    if (actual !== expected) errors.push(`${name}: expected ${expected}, got ${actual ?? "(missing)"}`);
  }

  if (expectedFragmentPath !== undefined) {
    const actual = properties.FragmentPath;
    if (resolve(actual || "/") !== resolve(expectedFragmentPath)) {
      errors.push(`FragmentPath: expected ${expectedFragmentPath}, got ${actual || "(missing)"}`);
    }
  }
  return errors;
}

export async function installService(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const nodePath = options.nodePath ?? process.execPath;
  const target = options.target ?? userUnitPath(options);
  const runSystemctl = options.runSystemctl ?? systemctl;
  const runSystemdAnalyze = options.runSystemdAnalyze ?? systemdAnalyze;
  const replaceExisting = options.replaceExisting ?? false;
  const templatePath = join(repoRoot, "deploy", "systemd", "mcp-shell.service.in");
  const entrypoint = resolve(repoRoot, "dist", "server", "mcp-shell.js");

  await access(nodePath, constants.X_OK).catch((error) => {
    throw new Error(`Node executable is not usable: ${nodePath}`, { cause: error });
  });
  await access(entrypoint, constants.R_OK).catch((error) => {
    throw new Error(`Production entrypoint is missing: ${entrypoint}. Run npm run build first.`, { cause: error });
  });

  const template = await readFile(templatePath, "utf8");
  const rendered = renderUnit(template, { nodePath, entrypoint });
  const existing = await readOptional(target);
  if (existing !== undefined && !isManagedUnit(existing) && !replaceExisting) {
    throw new Error(
      `Refusing to replace unmanaged systemd unit at ${target}. ` +
      "Re-run with --replace-existing after reviewing the existing unit.",
    );
  }

  await verifyUnitWithSystemd(rendered, runSystemdAnalyze);
  await atomicWrite(target, rendered);
  await runSystemctl(["--user", "daemon-reload"]);
  return { target, nodePath, entrypoint, replacedExisting: existing !== undefined };
}

export async function checkService(options = {}) {
  const target = options.target ?? userUnitPath(options);
  const runSystemctl = options.runSystemctl ?? systemctl;
  const installed = await readFile(target, "utf8").catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(`mcp-shell user service is not installed at ${target}`);
    }
    throw error;
  });

  if (!isManagedUnit(installed)) {
    throw new Error(`Systemd unit at ${target} is not managed by mcp-shell`);
  }

  const { nodePath, entrypoint } = parseRenderedExecStart(installed);
  await access(nodePath, constants.X_OK).catch((error) => {
    throw new Error(`Configured Node executable is not usable: ${nodePath}`, { cause: error });
  });
  await access(entrypoint, constants.R_OK).catch((error) => {
    throw new Error(`Configured production entrypoint is missing: ${entrypoint}`, { cause: error });
  });

  const propertiesToRead = [
    ...Object.keys(expectedEffectiveProperties),
    "FragmentPath",
  ];
  const output = await runSystemctl([
    "--user",
    "show",
    UNIT_NAME,
    ...propertiesToRead.flatMap((property) => ["-p", property]),
  ]);
  const properties = parseSystemctlShow(output);
  const errors = effectivePropertyErrors(properties, target);
  if (errors.length > 0) {
    throw new Error(`Systemd service contract mismatch:\n- ${errors.join("\n- ")}`);
  }

  return { target, nodePath, entrypoint, properties };
}

async function atomicWrite(path, content) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = join(directory, `.${UNIT_NAME}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, content, { encoding: "utf8", mode: 0o644 });
    await chmod(tempPath, 0o644);
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch((cleanupError) => {
      if (cleanupError?.code !== "ENOENT") console.warn(`Failed to remove ${tempPath}:`, cleanupError);
    });
    throw error;
  }
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function systemctl(args) {
  const { stdout } = await execFileAsync("systemctl", args, { encoding: "utf8" });
  return stdout;
}

async function systemdAnalyze(args) {
  const { stdout } = await execFileAsync("systemd-analyze", args, { encoding: "utf8" });
  return stdout;
}

async function verifyUnitWithSystemd(content, runSystemdAnalyze) {
  const path = join(tmpdir(), `mcp-shell-${randomUUID()}.service`);
  try {
    await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
    await runSystemdAnalyze(["verify", path]);
  } catch (error) {
    throw new Error("Rendered systemd unit failed systemd-analyze verify", { cause: error });
  } finally {
    await unlink(path).catch((cleanupError) => {
      if (cleanupError?.code !== "ENOENT") console.warn(`Failed to remove ${path}:`, cleanupError);
    });
  }
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

function parseQuotedArguments(input) {
  const result = [];
  let index = 0;

  while (index < input.length) {
    while (input[index] === " " || input[index] === "\t") index += 1;
    if (index >= input.length) break;
    if (input[index] !== '"') throw new Error("Managed ExecStart contains an unexpected unquoted argument");
    index += 1;

    let value = "";
    let closed = false;
    while (index < input.length) {
      const char = input[index++];
      if (char === '"') {
        closed = true;
        break;
      }
      if (char === "\\") {
        if (index >= input.length) throw new Error("Managed ExecStart ends with an incomplete escape");
        const escaped = input[index++];
        if (escaped !== "\\" && escaped !== '"') {
          throw new Error(`Managed ExecStart contains unsupported escape \\${escaped}`);
        }
        value += escaped;
        continue;
      }
      if (char === "$" || char === "%") {
        if (input[index] !== char) {
          throw new Error(`Managed ExecStart contains unescaped ${char}`);
        }
        index += 1;
        value += char;
        continue;
      }
      value += char;
    }
    if (!closed) throw new Error("Managed ExecStart contains an unterminated quoted argument");
    result.push(value);
  }
  return result;
}

async function main(argv) {
  const [command, ...args] = argv;
  if (command === "install") {
    const unknown = args.filter((arg) => arg !== "--replace-existing");
    if (unknown.length > 0) throw new Error(`Unknown install option: ${unknown[0]}`);
    const result = await installService({ replaceExisting: args.includes("--replace-existing") });
    console.log(`Installed ${result.target}`);
    console.log(`Deployment entrypoint: ${result.entrypoint}`);
    console.log("systemd manager reloaded. Service was not enabled, started, or restarted.");
    return;
  }

  if (command === "check") {
    if (args.length > 0) throw new Error(`Unknown check option: ${args[0]}`);
    const result = await checkService();
    console.log(`Systemd service contract: OK (${result.target})`);
    console.log(`Deployment entrypoint: ${result.entrypoint}`);
    return;
  }

  throw new Error("Usage: node scripts/systemd-user-service.mjs <install [--replace-existing] | check>");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
