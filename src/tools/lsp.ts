import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Type } from "typebox";
import { z } from "zod";
import { applyCommandPath, resolveExecutable, type CommandPathPolicy } from "../command-path.js";
import type { FileMutationCoordinator } from "../host/file-mutation-coordinator.js";
import { LspClient, type Diagnostic, type Range } from "../lsp/client.js";
import type { LspLaunchSpec } from "../lsp/connection.js";
import type { ToolCallRecorder } from "../observability/tool-call-recorder.js";
import type { ShellStore } from "../shell-store.js";
import { invokeShellTool } from "./invoke.js";
import type { InvocationGate } from "./invocation-gate.js";
import { shellIdSchema } from "./shell.js";

const DEFAULT_MAX_REFERENCES = 200
const DEFAULT_MAX_SYMBOLS = 200
const DEFAULT_MAX_DIAGNOSTICS = 200
const DEFAULT_MAX_DIRECTORY_FILES = 50

function normalizePath(baseDir: string, target: string): string {
  if (isAbsolute(target)) return resolve(target)
  return resolve(baseDir, target)
}

function stripJsoncComments(input: string): string {
  let output = ""
  let inString = false
  let stringQuote = '"'
  let escaping = false
  let inLineComment = false
  let inBlockComment = false

  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    const next = input[index + 1]

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false
        output += char
      }
      continue
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false
        index++
      }
      continue
    }

    if (inString) {
      output += char
      if (escaping) {
        escaping = false
      } else if (char === "\\") {
        escaping = true
      } else if (char === stringQuote) {
        inString = false
      }
      continue
    }

    if ((char === '"' || char === "'") && !inString) {
      inString = true
      stringQuote = char
      output += char
      continue
    }

    if (char === "/" && next === "/") {
      inLineComment = true
      index++
      continue
    }

    if (char === "/" && next === "*") {
      inBlockComment = true
      index++
      continue
    }

    output += char
  }

  return output
}

function stripTrailingCommas(input: string): string {
  let output = ""
  let inString = false
  let stringQuote = '"'
  let escaping = false

  for (let index = 0; index < input.length; index++) {
    const char = input[index]

    if (inString) {
      output += char
      if (escaping) {
        escaping = false
      } else if (char === "\\") {
        escaping = true
      } else if (char === stringQuote) {
        inString = false
      }
      continue
    }

    if (char === '"' || char === "'") {
      inString = true
      stringQuote = char
      output += char
      continue
    }

    if (char === ",") {
      let lookahead = index + 1
      while (lookahead < input.length && /\s/.test(input[lookahead]!)) {
        lookahead++
      }
      const next = input[lookahead]
      if (next === "}" || next === "]") {
        continue
      }
    }

    output += char
  }

  return output
}

function parseJsonc<T = unknown>(content: string): T {
  return JSON.parse(stripTrailingCommas(stripJsoncComments(content))) as T
}

function detectConfigFile(basePath: string): { format: "json" | "jsonc" | "none"; path: string } {
  const jsoncPath = `${basePath}.jsonc`
  const jsonPath = `${basePath}.json`

  if (existsSync(jsoncPath)) return { format: "jsonc", path: jsoncPath }
  if (existsSync(jsonPath)) return { format: "json", path: jsonPath }
  return { format: "none", path: jsonPath }
}

const PLUGIN_CONFIG_NAMES = ["lsp-tools", "oh-my-opencode", "oh-my-openagent"] as const

function detectPluginConfigFile(dir: string): { format: "json" | "jsonc" | "none"; path: string } {
  for (const name of PLUGIN_CONFIG_NAMES) {
    const result = detectConfigFile(join(dir, name))
    if (result.format !== "none") return result
  }
  return { format: "none", path: join(dir, `${PLUGIN_CONFIG_NAMES[0]}.json`) }
}

function resolveWritableDirectory(preferredDir: string, fallbackSuffix: string): string {
  try {
    mkdirSync(preferredDir, { recursive: true })
    accessSync(preferredDir, fsConstants.W_OK)
    return preferredDir
  } catch {
    const fallbackDir = join(tmpdir(), fallbackSuffix)
    mkdirSync(fallbackDir, { recursive: true })
    return fallbackDir
  }
}

function getDataDir(): string {
  const preferredDir = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  return resolveWritableDirectory(preferredDir, "pi-data")
}

function resolveConfigPath(pathValue: string): string {
  const resolvedPath = resolve(pathValue)
  if (!existsSync(resolvedPath)) return resolvedPath
  try {
    return realpathSync(resolvedPath)
  } catch {
    return resolvedPath
  }
}

function getPiConfigDir(): string {
  const envConfigDir = process.env.PI_CONFIG_DIR?.trim()
  if (envConfigDir) {
    return resolveConfigPath(envConfigDir)
  }

  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return resolveConfigPath(join(xdgConfig, "pi"))
}

type LSPServerConfig = {
  id: string
  command: string[]
  extensions: string[]
  disabled?: boolean
  env?: Record<string, string>
  initialization?: Record<string, unknown>
}

type Location = {
  uri: string
  range: Range
}

type LocationLink = {
  targetUri: string
  targetRange: Range
  targetSelectionRange: Range
  originSelectionRange?: Range
}

type SymbolInfo = {
  name: string
  kind: number
  location: Location
  containerName?: string
}

type DocumentSymbol = {
  name: string
  kind: number
  range: Range
  selectionRange: Range
  children?: DocumentSymbol[]
}

type TextEdit = {
  range: Range
  newText: string
}

type VersionedTextDocumentIdentifier = {
  uri: string
  version: number | null
}

type TextDocumentEdit = {
  textDocument: VersionedTextDocumentIdentifier
  edits: TextEdit[]
}

type CreateFile = {
  kind: "create"
  uri: string
  options?: { overwrite?: boolean; ignoreIfExists?: boolean }
}

type RenameFile = {
  kind: "rename"
  oldUri: string
  newUri: string
  options?: { overwrite?: boolean; ignoreIfExists?: boolean }
}

type DeleteFile = {
  kind: "delete"
  uri: string
  options?: { recursive?: boolean; ignoreIfNotExists?: boolean }
}

type WorkspaceEdit = {
  changes?: { [uri: string]: TextEdit[] }
  documentChanges?: (TextDocumentEdit | CreateFile | RenameFile | DeleteFile)[]
}

type PrepareRenameResult = {
  range: Range
  placeholder?: string
}

type PrepareRenameDefaultBehavior = {
  defaultBehavior: boolean
}

type ResolvedServer = {
  id: string
  command: string[]
  extensions: string[]
  priority: number
  env?: Record<string, string>
  initialization?: Record<string, unknown>
}

type ServerLookupInfo = {
  id: string
  command: string[]
  extensions: string[]
}

type ServerLookupResult =
  | { status: "found"; server: ResolvedServer; launch: LspLaunchSpec }
  | { status: "not_configured"; extension: string; availableServers: string[] }
  | { status: "not_installed"; server: ServerLookupInfo; launchRoot: string; installHint: string }

type ApplyResult = {
  success: boolean
  filesModified: string[]
  totalEdits: number
  errors: string[]
}

const SYMBOL_KIND_MAP: Record<number, string> = {
  1: "File",
  2: "Module",
  3: "Namespace",
  4: "Package",
  5: "Class",
  6: "Method",
  7: "Property",
  8: "Field",
  9: "Constructor",
  10: "Enum",
  11: "Interface",
  12: "Function",
  13: "Variable",
  14: "Constant",
  15: "String",
  16: "Number",
  17: "Boolean",
  18: "Array",
  19: "Object",
  20: "Key",
  21: "Null",
  22: "EnumMember",
  23: "Struct",
  24: "Event",
  25: "Operator",
  26: "TypeParameter",
}

const SEVERITY_MAP: Record<number, string> = {
  1: "error",
  2: "warning",
  3: "information",
  4: "hint",
}

const EXT_TO_LANG: Record<string, string> = {
  ".abap": "abap",
  ".bat": "bat",
  ".bib": "bibtex",
  ".bibtex": "bibtex",
  ".clj": "clojure",
  ".cljs": "clojure",
  ".cljc": "clojure",
  ".edn": "clojure",
  ".coffee": "coffeescript",
  ".c": "c",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".cc": "cpp",
  ".c++": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".d": "d",
  ".pas": "pascal",
  ".pascal": "pascal",
  ".diff": "diff",
  ".patch": "diff",
  ".dart": "dart",
  ".dockerfile": "dockerfile",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hrl": "erlang",
  ".fs": "fsharp",
  ".fsi": "fsharp",
  ".fsx": "fsharp",
  ".fsscript": "fsharp",
  ".gitcommit": "git-commit",
  ".gitrebase": "git-rebase",
  ".go": "go",
  ".groovy": "groovy",
  ".gleam": "gleam",
  ".hbs": "handlebars",
  ".handlebars": "handlebars",
  ".hs": "haskell",
  ".html": "html",
  ".htm": "html",
  ".ini": "ini",
  ".java": "java",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".json": "json",
  ".jsonc": "jsonc",
  ".tex": "latex",
  ".latex": "latex",
  ".less": "less",
  ".lua": "lua",
  ".makefile": "makefile",
  makefile: "makefile",
  ".md": "markdown",
  ".markdown": "markdown",
  ".m": "objective-c",
  ".mm": "objective-cpp",
  ".pl": "perl",
  ".pm": "perl",
  ".pm6": "perl6",
  ".php": "php",
  ".ps1": "powershell",
  ".psm1": "powershell",
  ".pug": "jade",
  ".jade": "jade",
  ".py": "python",
  ".pyi": "python",
  ".r": "r",
  ".cshtml": "razor",
  ".razor": "razor",
  ".rb": "ruby",
  ".rake": "ruby",
  ".gemspec": "ruby",
  ".ru": "ruby",
  ".erb": "erb",
  ".html.erb": "erb",
  ".js.erb": "erb",
  ".css.erb": "erb",
  ".json.erb": "erb",
  ".rs": "rust",
  ".scss": "scss",
  ".sass": "sass",
  ".scala": "scala",
  ".shader": "shaderlab",
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".zsh": "shellscript",
  ".ksh": "shellscript",
  ".sql": "sql",
  ".svelte": "svelte",
  ".swift": "swift",
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".mts": "typescript",
  ".cts": "typescript",
  ".mtsx": "typescriptreact",
  ".ctsx": "typescriptreact",
  ".xml": "xml",
  ".xsl": "xsl",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".vue": "vue",
  ".zig": "zig",
  ".zon": "zig",
  ".astro": "astro",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".tf": "terraform",
  ".tfvars": "terraform-vars",
  ".hcl": "hcl",
  ".nix": "nix",
  ".typ": "typst",
  ".typc": "typst",
  ".ets": "typescript",
  ".lhs": "haskell",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".prisma": "prisma",
  ".h": "c",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
  ".h++": "cpp",
  ".objc": "objective-c",
  ".objcpp": "objective-cpp",
  ".fish": "fish",
  ".graphql": "graphql",
  ".gql": "graphql",
}

const LSP_INSTALL_HINTS: Record<string, string> = {
  typescript: "npm install -g typescript-language-server typescript",
  deno: "Install Deno from https://deno.land",
  vue: "npm install -g @vue/language-server",
  eslint: "npm install -g vscode-langservers-extracted",
  oxlint: "npm install -g oxlint",
  biome: "npm install -g @biomejs/biome",
  gopls: "go install golang.org/x/tools/gopls@latest",
  "ruby-lsp": "gem install ruby-lsp",
  basedpyright: "pip install basedpyright",
  pyright: "pip install pyright",
  ty: "pip install ty",
  ruff: "pip install ruff",
  "elixir-ls": "See https://github.com/elixir-lsp/elixir-ls",
  zls: "See https://github.com/zigtools/zls",
  csharp: "dotnet tool install -g csharp-ls",
  fsharp: "dotnet tool install -g fsautocomplete",
  "sourcekit-lsp": "Included with Xcode or Swift toolchain",
  rust: "rustup component add rust-analyzer",
  clangd: "See https://clangd.llvm.org/installation",
  svelte: "npm install -g svelte-language-server",
  astro: "npm install -g @astrojs/language-server",
  "bash-ls": "npm install -g bash-language-server",
  bash: "npm install -g bash-language-server",
  jdtls: "See https://github.com/eclipse-jdtls/eclipse.jdt.ls",
  "yaml-ls": "npm install -g yaml-language-server",
  "lua-ls": "See https://github.com/LuaLS/lua-language-server",
  php: "npm install -g intelephense",
  dart: "Included with Dart SDK",
  "terraform-ls": "See https://github.com/hashicorp/terraform-ls",
  terraform: "See https://github.com/hashicorp/terraform-ls",
  prisma: "npm install -g prisma",
  "ocaml-lsp": "opam install ocaml-lsp-server",
  texlab: "See https://github.com/latex-lsp/texlab",
  dockerfile: "npm install -g dockerfile-language-server-nodejs",
  gleam: "See https://gleam.run/getting-started/installing/",
  "clojure-lsp": "See https://clojure-lsp.io/installation/",
  nixd: "nix profile install nixpkgs#nixd",
  tinymist: "See https://github.com/Myriad-Dreamin/tinymist",
  "haskell-language-server": "ghcup install hls",
  "kotlin-ls": "See https://github.com/Kotlin/kotlin-lsp",
}

const BUILTIN_SERVERS: Record<string, Omit<LSPServerConfig, "id">> = {
  typescript: { command: ["typescript-language-server", "--stdio"], extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"] },
  deno: { command: ["deno", "lsp"], extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"] },
  vue: { command: ["vue-language-server", "--stdio"], extensions: [".vue"] },
  eslint: { command: ["vscode-eslint-language-server", "--stdio"], extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue"] },
  oxlint: { command: ["oxlint", "--lsp"], extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".astro", ".svelte"] },
  biome: { command: ["biome", "lsp-proxy", "--stdio"], extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json", ".jsonc", ".vue", ".astro", ".svelte", ".css", ".graphql", ".gql", ".html"] },
  gopls: { command: ["gopls"], extensions: [".go"] },
  "ruby-lsp": { command: ["rubocop", "--lsp"], extensions: [".rb", ".rake", ".gemspec", ".ru"] },
  basedpyright: { command: ["basedpyright-langserver", "--stdio"], extensions: [".py", ".pyi"] },
  pyright: { command: ["pyright-langserver", "--stdio"], extensions: [".py", ".pyi"] },
  ty: { command: ["ty", "server"], extensions: [".py", ".pyi"] },
  ruff: { command: ["ruff", "server"], extensions: [".py", ".pyi"] },
  "elixir-ls": { command: ["elixir-ls"], extensions: [".ex", ".exs"] },
  zls: { command: ["zls"], extensions: [".zig", ".zon"] },
  csharp: { command: ["csharp-ls"], extensions: [".cs"] },
  fsharp: { command: ["fsautocomplete"], extensions: [".fs", ".fsi", ".fsx", ".fsscript"] },
  "sourcekit-lsp": { command: ["sourcekit-lsp"], extensions: [".swift", ".objc", ".objcpp"] },
  rust: { command: ["rust-analyzer"], extensions: [".rs"] },
  clangd: { command: ["clangd", "--background-index", "--clang-tidy"], extensions: [".c", ".cpp", ".cc", ".cxx", ".c++", ".h", ".hpp", ".hh", ".hxx", ".h++"] },
  svelte: { command: ["svelteserver", "--stdio"], extensions: [".svelte"] },
  astro: { command: ["astro-ls", "--stdio"], extensions: [".astro"] },
  bash: { command: ["bash-language-server", "start"], extensions: [".sh", ".bash", ".zsh", ".ksh"] },
  "bash-ls": { command: ["bash-language-server", "start"], extensions: [".sh", ".bash", ".zsh", ".ksh"] },
  jdtls: { command: ["jdtls"], extensions: [".java"] },
  "yaml-ls": { command: ["yaml-language-server", "--stdio"], extensions: [".yaml", ".yml"] },
  "lua-ls": { command: ["lua-language-server"], extensions: [".lua"] },
  php: { command: ["intelephense", "--stdio"], extensions: [".php"] },
  dart: { command: ["dart", "language-server", "--lsp"], extensions: [".dart"] },
  terraform: { command: ["terraform-ls", "serve"], extensions: [".tf", ".tfvars"] },
  "terraform-ls": { command: ["terraform-ls", "serve"], extensions: [".tf", ".tfvars"] },
  prisma: { command: ["prisma", "language-server"], extensions: [".prisma"] },
  "ocaml-lsp": { command: ["ocamllsp"], extensions: [".ml", ".mli"] },
  texlab: { command: ["texlab"], extensions: [".tex", ".bib"] },
  dockerfile: { command: ["docker-langserver", "--stdio"], extensions: [".dockerfile"] },
  gleam: { command: ["gleam", "lsp"], extensions: [".gleam"] },
  "clojure-lsp": { command: ["clojure-lsp", "listen"], extensions: [".clj", ".cljs", ".cljc", ".edn"] },
  nixd: { command: ["nixd"], extensions: [".nix"] },
  tinymist: { command: ["tinymist"], extensions: [".typ", ".typc"] },
  "haskell-language-server": { command: ["haskell-language-server-wrapper", "--lsp"], extensions: [".hs", ".lhs"] },
  "kotlin-ls": { command: ["kotlin-lsp"], extensions: [".kt", ".kts"] },
}

function getLanguageId(ext: string): string {
  return EXT_TO_LANG[ext] || "plaintext"
}

type LspEntry = {
  disabled?: boolean
  command?: string[]
  extensions?: string[]
  priority?: number
  env?: Record<string, string>
  initialization?: Record<string, unknown>
}

type ConfigJson = {
  lsp?: Record<string, LspEntry>
}

type ConfigSource = "project" | "user" | "pi"

type ServerWithSource = ResolvedServer & { source: ConfigSource }

function loadJsonFile<T>(pathValue: string): T | null {
  if (!existsSync(pathValue)) return null
  try {
    return parseJsonc<T>(readFileSync(pathValue, "utf-8"))
  } catch {
    return null
  }
}

function getConfigPaths(projectDirectory: string): { project: string; user: string; pi: string } {
  const configDir = getPiConfigDir()
  return {
    project: detectPluginConfigFile(join(projectDirectory, ".pi")).path,
    user: detectPluginConfigFile(configDir).path,
    pi: detectConfigFile(join(configDir, "pi")).path,
  }
}

function loadAllConfigs(projectDirectory: string): Map<ConfigSource, ConfigJson> {
  const paths = getConfigPaths(projectDirectory)
  const configs = new Map<ConfigSource, ConfigJson>()

  const project = loadJsonFile<ConfigJson>(paths.project)
  if (project) configs.set("project", project)

  const user = loadJsonFile<ConfigJson>(paths.user)
  if (user) configs.set("user", user)

  const pi = loadJsonFile<ConfigJson>(paths.pi)
  if (pi) configs.set("pi", pi)

  return configs
}

function getMergedServers(projectDirectory: string): ServerWithSource[] {
  const configs = loadAllConfigs(projectDirectory)
  const servers: ServerWithSource[] = []
  const disabled = new Set<string>()
  const seen = new Set<string>()
  const sources: ConfigSource[] = ["project", "user", "pi"]

  for (const source of sources) {
    const config = configs.get(source)
    if (!config?.lsp) continue

    for (const [id, entry] of Object.entries(config.lsp)) {
      if (entry.disabled) {
        disabled.add(id)
        continue
      }
      if (seen.has(id)) continue
      if (!entry.command || !entry.extensions) continue

      servers.push({
        id,
        command: entry.command,
        extensions: entry.extensions,
        priority: entry.priority ?? 0,
        env: entry.env,
        initialization: entry.initialization,
        source,
      })
      seen.add(id)
    }
  }

  for (const [id, config] of Object.entries(BUILTIN_SERVERS)) {
    if (disabled.has(id) || seen.has(id)) continue
    servers.push({
      id,
      command: config.command,
      extensions: config.extensions,
      priority: -100,
      source: "pi",
    })
  }

  return servers.sort((a, b) => {
    if (a.source !== b.source) {
      const order: Record<ConfigSource, number> = { project: 0, user: 1, pi: 2 }
      return order[a.source] - order[b.source]
    }
    return b.priority - a.priority
  })
}

function getLspServerAdditionalPathBases(workingDirectory: string): string[] {
  const configDir = getPiConfigDir()
  const dataDir = join(getDataDir(), "pi")

  return [
    join(workingDirectory, "node_modules", ".bin"),
    join(configDir, "bin"),
    join(configDir, "node_modules", ".bin"),
    join(dataDir, "bin"),
    join(dataDir, "bin", "node_modules", ".bin"),
  ]
}

function prepareLspLaunch(
  server: ResolvedServer,
  launchRoot: string,
  commandPath: CommandPathPolicy,
): LspLaunchSpec | undefined {
  if (server.command.length === 0) return undefined

  const env = { ...process.env, ...server.env }
  const pathValue = process.platform === "win32" ? env.PATH ?? env.Path ?? "" : env.PATH ?? ""
  const launchPath = [pathValue, ...getLspServerAdditionalPathBases(launchRoot)].filter(Boolean).join(delimiter)
  if (process.platform === "win32" && env.Path !== undefined) env.Path = launchPath
  env.PATH = launchPath
  const effectiveEnv = applyCommandPath(env, commandPath)
  const executable = resolveExecutable(server.command[0]!, { cwd: launchRoot, env: effectiveEnv })
  if (!executable) return undefined

  return {
    cwd: launchRoot,
    env: effectiveEnv,
    executable,
    args: server.command.slice(1),
  }
}

function findServerForExtension(
  configRoot: string,
  launchRoot: string,
  ext: string,
  commandPath: CommandPathPolicy,
): ServerLookupResult {
  const servers = getMergedServers(configRoot)

  for (const server of servers) {
    if (!server.extensions.includes(ext)) continue
    const launch = prepareLspLaunch(server, launchRoot, commandPath)
    if (launch) {
      return {
        status: "found",
        server: {
          id: server.id,
          command: server.command,
          extensions: server.extensions,
          priority: server.priority,
          env: server.env,
          initialization: server.initialization,
        },
        launch,
      }
    }
  }

  for (const server of servers) {
    if (server.extensions.includes(ext)) {
      return {
        status: "not_installed",
        server: {
          id: server.id,
          command: server.command,
          extensions: server.extensions,
        },
        launchRoot,
        installHint: LSP_INSTALL_HINTS[server.id] || `Install '${server.command[0]}' and ensure it's in your PATH`,
      }
    }
  }

  return {
    status: "not_configured",
    extension: ext,
    availableServers: [...new Set(servers.map((server) => server.id))],
  }
}

function isDirectoryPath(filePath: string): boolean {
  if (!existsSync(filePath)) return false
  return statSync(filePath).isDirectory()
}

function uriToPath(uri: string): string {
  return fileURLToPath(uri)
}

function findWorkspaceRoot(filePath: string): string {
  let dir = resolve(filePath)
  if (!existsSync(dir) || !isDirectoryPath(dir)) {
    dir = dirname(dir)
  }

  const markers = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle"]
  let previous = ""
  while (dir !== previous) {
    for (const marker of markers) {
      if (existsSync(join(dir, marker))) return dir
    }
    previous = dir
    dir = dirname(dir)
  }

  return dirname(resolve(filePath))
}

function formatServerLookupError(result: Exclude<ServerLookupResult, { status: "found" }>): string {
  if (result.status === "not_installed") {
    const command = result.server.command[0] ?? "<empty command>"
    const resolvedRelative = !isAbsolute(command) && (command.includes("/") || command.includes("\\"))
      ? resolve(result.launchRoot, command)
      : undefined
    return [
      `LSP server '${result.server.id}' is configured but NOT INSTALLED.`,
      "",
      `Executable unavailable in the effective LSP launch environment: ${command}`,
      ...(resolvedRelative ? [`Resolved workspace-relative path: ${resolvedRelative}`] : []),
      "",
      "To install:",
      `  ${result.installHint}`,
      "",
      `Supported extensions: ${result.server.extensions.join(", ")}`,
    ].join("\n")
  }

  return [
    `No LSP server configured for extension: ${result.extension}`,
    "",
    `Available servers: ${result.availableServers.slice(0, 10).join(", ")}${result.availableServers.length > 10 ? "..." : ""}`,
    "",
    "Add a custom server in your pi config under 'lsp'.",
  ].join("\n")
}

type ManagedClient = {
  client: LspClient
  lastUsedAt: number
  refCount: number
  initPromise?: Promise<void>
  isInitializing: boolean
  initializingSince?: number
}

export class LSPServerManager {
  private clients = new Map<string, ManagedClient>()
  private cleanupInterval: ReturnType<typeof setInterval> | null = null
  private closePromise: Promise<void> | undefined
  private readonly IDLE_TIMEOUT = 5 * 60 * 1000
  private readonly INIT_TIMEOUT = 60 * 1000

  private key(root: string, serverId: string): string {
    return `${root}::${serverId}`
  }

  private startCleanupTimer(): void {
    if (this.cleanupInterval) return
    this.cleanupInterval = setInterval(() => this.cleanupIdleClients(), 60_000)
    this.cleanupInterval.unref()
  }

  private cleanupIdleClients(): void {
    const now = Date.now()
    for (const [key, managed] of this.clients) {
      if (managed.refCount === 0 && now - managed.lastUsedAt > this.IDLE_TIMEOUT) {
        void managed.client.stop().catch(() => {})
        this.clients.delete(key)
      }
    }
  }

  async getClient(server: ResolvedServer, launch: LspLaunchSpec): Promise<LspClient> {
    if (this.closePromise) throw new Error("LSP server manager is closing")
    this.startCleanupTimer()

    const root = launch.cwd
    const key = this.key(root, server.id)
    let managed = this.clients.get(key)

    if (managed) {
      const now = Date.now()
      if (managed.isInitializing && managed.initializingSince !== undefined && now - managed.initializingSince >= this.INIT_TIMEOUT) {
        try {
          await managed.client.stop()
        } catch {}
        this.clients.delete(key)
        managed = undefined
      }
    }

    if (managed) {
      if (managed.initPromise) {
        try {
          await managed.initPromise
        } catch {
          try {
            await managed.client.stop()
          } catch {}
          this.clients.delete(key)
          managed = undefined
        }
      }

      if (managed) {
        if (managed.client.isAlive()) {
          managed.refCount++
          managed.lastUsedAt = Date.now()
          return managed.client
        }
        try {
          await managed.client.stop()
        } catch {}
        this.clients.delete(key)
      }
    }

    const client = new LspClient({
      serverId: server.id,
      initializationOptions: server.initialization,
      languageIdForPath: (filePath) => getLanguageId(extname(filePath)),
    }, launch)
    const initPromise = (async () => {
      await client.start()
      await client.initialize()
    })()
    const startedAt = Date.now()

    this.clients.set(key, {
      client,
      lastUsedAt: startedAt,
      refCount: 1,
      initPromise,
      isInitializing: true,
      initializingSince: startedAt,
    })

    try {
      await initPromise
    } catch (error) {
      this.clients.delete(key)
      try {
        await client.stop()
      } catch {}
      throw error
    }

    if (this.closePromise) {
      this.clients.delete(key)
      await client.stop().catch(() => {})
      throw new Error("LSP server manager is closing")
    }

    const current = this.clients.get(key)
    if (current) {
      current.initPromise = undefined
      current.isInitializing = false
      current.initializingSince = undefined
    }

    return client
  }

  releaseClient(root: string, serverId: string): void {
    const managed = this.clients.get(this.key(root, serverId))
    if (managed && managed.refCount > 0) {
      managed.refCount--
      managed.lastUsedAt = Date.now()
    }
  }

  isServerInitializing(root: string, serverId: string): boolean {
    return this.clients.get(this.key(root, serverId))?.isInitializing ?? false
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeClients()
    return this.closePromise
  }

  private async closeClients(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }

    const clients = [...this.clients.values()].map((managed) => managed.client)
    this.clients.clear()
    await Promise.allSettled(clients.map((client) => client.stop()))
  }
}

async function withLspClient<T>(
  manager: LSPServerManager,
  projectDirectory: string,
  filePath: string,
  commandPath: CommandPathPolicy,
  fn: (client: LspClient) => Promise<T>
): Promise<T> {
  const absPath = resolve(filePath)
  if (isDirectoryPath(absPath)) {
    throw new Error("Directory paths are not supported by this LSP tool. Use lsp_diagnostics with the 'extension' parameter for directory diagnostics.")
  }

  const root = findWorkspaceRoot(absPath)
  const result = findServerForExtension(projectDirectory, root, extname(absPath), commandPath)
  if (result.status !== "found") {
    throw new Error(formatServerLookupError(result))
  }

  const client = await manager.getClient(result.server, result.launch)
  try {
    return await fn(client)
  } catch (error) {
    if (error instanceof Error && error.message.includes("timeout") && manager.isServerInitializing(root, result.server.id)) {
      throw new Error(`LSP server is still initializing. Please retry in a few seconds. Original error: ${error.message}`)
    }
    throw error
  } finally {
    manager.releaseClient(root, result.server.id)
  }
}

function formatLocation(location: Location | LocationLink): string {
  if ("targetUri" in location) {
    return `${uriToPath(location.targetUri)}:${location.targetRange.start.line + 1}:${location.targetRange.start.character}`
  }
  return `${uriToPath(location.uri)}:${location.range.start.line + 1}:${location.range.start.character}`
}

function formatSymbolKind(kind: number): string {
  return SYMBOL_KIND_MAP[kind] || `Unknown(${kind})`
}

function formatSeverity(severity: number | undefined): string {
  if (!severity) return "unknown"
  return SEVERITY_MAP[severity] || `unknown(${severity})`
}

function formatDocumentSymbol(symbol: DocumentSymbol, indent = 0): string {
  const prefix = "  ".repeat(indent)
  const line = symbol.range.start.line + 1
  let result = `${prefix}${symbol.name} (${formatSymbolKind(symbol.kind)}) - line ${line}`
  for (const child of symbol.children ?? []) {
    result += `\n${formatDocumentSymbol(child, indent + 1)}`
  }
  return result
}

function formatSymbolInfo(symbol: SymbolInfo): string {
  const container = symbol.containerName ? ` (in ${symbol.containerName})` : ""
  return `${symbol.name} (${formatSymbolKind(symbol.kind)})${container} - ${formatLocation(symbol.location)}`
}

function formatDiagnostic(diag: Diagnostic): string {
  const source = diag.source ? `[${diag.source}]` : ""
  const code = diag.code ? ` (${diag.code})` : ""
  return `${formatSeverity(diag.severity)}${source}${code} at ${diag.range.start.line + 1}:${diag.range.start.character}: ${diag.message}`
}

function filterDiagnosticsBySeverity(
  diagnostics: Diagnostic[],
  severity?: "error" | "warning" | "information" | "hint" | "all"
): Diagnostic[] {
  if (!severity || severity === "all") return diagnostics
  const severityMap: Record<string, number> = {
    error: 1,
    warning: 2,
    information: 3,
    hint: 4,
  }
  return diagnostics.filter((diag) => diag.severity === severityMap[severity])
}

function formatPrepareRenameResult(result: PrepareRenameResult | PrepareRenameDefaultBehavior | Range | null): string {
  if (!result) return "Cannot rename at this position"
  if ("defaultBehavior" in result) {
    return result.defaultBehavior ? "Rename supported (using default behavior)" : "Cannot rename at this position"
  }
  if ("range" in result) {
    return `Rename available at ${result.range.start.line + 1}:${result.range.start.character}-${result.range.end.line + 1}:${result.range.end.character}${result.placeholder ? ` (current: \"${result.placeholder}\")` : ""}`
  }
  if ("start" in result && "end" in result) {
    return `Rename available at ${result.start.line + 1}:${result.start.character}-${result.end.line + 1}:${result.end.character}`
  }
  return "Cannot rename at this position"
}

function formatApplyResult(result: ApplyResult): string {
  const lines: string[] = []
  if (result.success) {
    lines.push(`Applied ${result.totalEdits} edit(s) to ${result.filesModified.length} file(s):`)
    for (const file of result.filesModified) {
      lines.push(`  - ${file}`)
    }
  } else {
    lines.push("Failed to apply some changes:")
    for (const error of result.errors) {
      lines.push(`  Error: ${error}`)
    }
    if (result.filesModified.length > 0) {
      lines.push(`Successfully modified: ${result.filesModified.join(", ")}`)
    }
  }
  return lines.join("\n")
}

function applyTextEditsToFile(filePath: string, edits: TextEdit[]): { success: boolean; editCount: number; error?: string } {
  try {
    const lines = readFileSync(filePath, "utf-8").split("\n")
    const sortedEdits = [...edits].sort((left, right) => {
      if (right.range.start.line !== left.range.start.line) return right.range.start.line - left.range.start.line
      return right.range.start.character - left.range.start.character
    })

    for (const edit of sortedEdits) {
      const { start, end } = edit.range
      if (start.line === end.line) {
        const line = lines[start.line] || ""
        lines[start.line] = line.slice(0, start.character) + edit.newText + line.slice(end.character)
      } else {
        const first = lines[start.line] || ""
        const last = lines[end.line] || ""
        const newContent = first.slice(0, start.character) + edit.newText + last.slice(end.character)
        lines.splice(start.line, end.line - start.line + 1, ...newContent.split("\n"))
      }
    }

    writeFileSync(filePath, lines.join("\n"), "utf-8")
    return { success: true, editCount: edits.length }
  } catch (error) {
    return { success: false, editCount: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

function workspaceEditPaths(edit: WorkspaceEdit | null): string[] {
  if (!edit) return [];

  const paths: string[] = [];
  if (edit.changes) {
    for (const uri of Object.keys(edit.changes)) paths.push(uriToPath(uri));
  }

  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ("kind" in change) {
        if (change.kind === "rename") {
          paths.push(uriToPath(change.oldUri), uriToPath(change.newUri));
        } else {
          paths.push(uriToPath(change.uri));
        }
      } else {
        paths.push(uriToPath(change.textDocument.uri));
      }
    }
  }

  return paths;
}

function applyWorkspaceEdit(edit: WorkspaceEdit | null): ApplyResult {
  if (!edit) {
    return { success: false, filesModified: [], totalEdits: 0, errors: ["No edit provided"] }
  }

  const result: ApplyResult = { success: true, filesModified: [], totalEdits: 0, errors: [] }

  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      const filePath = uriToPath(uri)
      const applied = applyTextEditsToFile(filePath, edits)
      if (applied.success) {
        result.filesModified.push(filePath)
        result.totalEdits += applied.editCount
      } else {
        result.success = false
        result.errors.push(`${filePath}: ${applied.error}`)
      }
    }
  }

  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ("kind" in change) {
        try {
          if (change.kind === "create") {
            writeFileSync(uriToPath(change.uri), "", "utf-8")
            result.filesModified.push(uriToPath(change.uri))
          } else if (change.kind === "rename") {
            const oldPath = uriToPath(change.oldUri)
            const newPath = uriToPath(change.newUri)
            writeFileSync(newPath, readFileSync(oldPath, "utf-8"), "utf-8")
            unlinkSync(oldPath)
            result.filesModified.push(newPath)
          } else if (change.kind === "delete") {
            const filePath = uriToPath(change.uri)
            unlinkSync(filePath)
            result.filesModified.push(filePath)
          }
        } catch (error) {
          result.success = false
          result.errors.push(`${change.kind} failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      } else {
        const filePath = uriToPath(change.textDocument.uri)
        const applied = applyTextEditsToFile(filePath, change.edits)
        if (applied.success) {
          result.filesModified.push(filePath)
          result.totalEdits += applied.editCount
        } else {
          result.success = false
          result.errors.push(`${filePath}: ${applied.error}`)
        }
      }
    }
  }

  return result
}

const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", ".next", "out"])

function collectFilesWithExtension(directory: string, extension: string, maxFiles: number): string[] {
  const files: string[] = []

  const walk = (currentDirectory: string): void => {
    if (files.length >= maxFiles) return
    let entries: string[] = []
    try {
      entries = readdirSync(currentDirectory)
    } catch {
      return
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) return
      const fullPath = join(currentDirectory, entry)

      let stats: Stats | undefined
      try {
        stats = lstatSync(fullPath)
      } catch {
        continue
      }

      if (!stats || stats.isSymbolicLink()) continue

      if (stats.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry)) walk(fullPath)
      } else if (stats.isFile() && extname(fullPath) === extension) {
        files.push(fullPath)
      }
    }
  }

  walk(directory)
  return files
}

async function aggregateDiagnosticsForDirectory(
  manager: LSPServerManager,
  projectDirectory: string,
  directory: string,
  extension: string,
  commandPath: CommandPathPolicy,
  severity?: "error" | "warning" | "information" | "hint" | "all",
  signal?: AbortSignal,
  maxFiles: number = DEFAULT_MAX_DIRECTORY_FILES
): Promise<string> {
  if (!extension.startsWith(".")) {
    throw new Error(`Extension must start with a dot. Use '.${extension}' instead.`)
  }

  const absDir = resolve(directory)
  if (!existsSync(absDir)) {
    throw new Error(`Directory does not exist: ${absDir}`)
  }

  const root = findWorkspaceRoot(absDir)
  const serverResult = findServerForExtension(projectDirectory, root, extension, commandPath)
  if (serverResult.status !== "found") {
    throw new Error(formatServerLookupError(serverResult))
  }

  const allFiles = collectFilesWithExtension(absDir, extension, maxFiles + 1)
  const wasCapped = allFiles.length > maxFiles
  const filesToProcess = allFiles.slice(0, maxFiles)

  if (filesToProcess.length === 0) {
    return [`Directory: ${absDir}`, `Extension: ${extension}`, "Files scanned: 0", `No files found with extension \"${extension}\".`].join("\n")
  }

  const allDiagnostics: Array<{ filePath: string; diagnostic: Diagnostic }> = []
  const fileErrors: Array<{ file: string; error: string }> = []
  const client = await manager.getClient(serverResult.server, serverResult.launch)

  try {
    for (const file of filesToProcess) {
      try {
        const result = await client.diagnostics(file, signal)
        const filtered = filterDiagnosticsBySeverity(result.items, severity)
        allDiagnostics.push(...filtered.map((diagnostic) => ({ filePath: file, diagnostic })))
      } catch (error) {
        fileErrors.push({ file, error: error instanceof Error ? error.message : String(error) })
      }
    }
  } finally {
    manager.releaseClient(root, serverResult.server.id)
  }

  const displayDiagnostics = allDiagnostics.slice(0, DEFAULT_MAX_DIAGNOSTICS)
  const lines: string[] = [
    `Directory: ${absDir}`,
    `Extension: ${extension}`,
    `Files scanned: ${filesToProcess.length}${wasCapped ? ` (capped at ${maxFiles})` : ""}`,
    `Files with errors: ${fileErrors.length}`,
    `Total diagnostics: ${allDiagnostics.length}`,
  ]

  if (fileErrors.length > 0) {
    lines.push("", "File processing errors:")
    for (const { file, error } of fileErrors) {
      lines.push(`  ${file}: ${error}`)
    }
  }

  if (displayDiagnostics.length > 0) {
    lines.push("")
    for (const { filePath, diagnostic } of displayDiagnostics) {
      lines.push(`${filePath}: ${formatDiagnostic(diagnostic)}`)
    }
    if (allDiagnostics.length > DEFAULT_MAX_DIAGNOSTICS) {
      lines.push("", `... (${allDiagnostics.length - DEFAULT_MAX_DIAGNOSTICS} more diagnostics not shown)`)
    }
  }

  return lines.join("\n")
}



type ToolTextResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

function textResult(text: string, details: Record<string, unknown> = {}): ToolTextResult {
  return { content: [{ type: "text", text }], details };
}

function errorText(error: unknown): ToolTextResult {
  return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
}

export function registerLspTools(
  server: McpServer,
  invocations: InvocationGate,
  shells: ShellStore,
  recorder: ToolCallRecorder,
  commandPath: CommandPathPolicy,
  mutations: FileMutationCoordinator,
  manager: LSPServerManager,
) {
  const schemas: Record<string, Record<string, z.ZodType>> = {
    lsp_goto_definition: {
      shell_id: shellIdSchema, filePath: z.string(), line: z.number().int().min(1), character: z.number().int().min(0),
    },
    lsp_find_references: {
      shell_id: shellIdSchema, filePath: z.string(), line: z.number().int().min(1), character: z.number().int().min(0),
      includeDeclaration: z.boolean().optional(),
    },
    lsp_symbols: {
      shell_id: shellIdSchema, filePath: z.string(), scope: z.enum(["document", "workspace"]).optional(),
      query: z.string().optional(), limit: z.number().int().positive().optional(),
    },
    lsp_diagnostics: {
      shell_id: shellIdSchema, filePath: z.string().optional(), directory: z.string().optional(),
      severity: z.enum(["error", "warning", "information", "hint", "all"]).optional(),
      extension: z.string().optional(),
    },
    lsp_prepare_rename: {
      shell_id: shellIdSchema, filePath: z.string(), line: z.number().int().min(1), character: z.number().int().min(0),
    },
    lsp_rename: {
      shell_id: shellIdSchema, filePath: z.string(), line: z.number().int().min(1), character: z.number().int().min(0), newName: z.string(),
    },
  };

  const pi = {
    registerTool(config: {
      name: string;
      label: string;
      description: string;
      execute: (toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) => Promise<any>;
      [key: string]: any;
    }) {
      server.registerTool(config.name, {
        title: config.label,
        description: config.description,
        inputSchema: schemas[config.name]!,
        outputSchema: {
          text: z.string(),
          details: z.record(z.string(), z.unknown()),
        },
        annotations: config.name === "lsp_rename"
          ? { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
          : { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      }, async (params, extra) => invokeShellTool(invocations, recorder, shells, config.name, params, async (shell) => {
        const { shell_id: _shellId, ...toolParams } = params;
        const result = await config.execute("mcp", toolParams, extra.signal, undefined, { cwd: shell.cwd });
        const text = result.content
          .filter((item: { type: string }) => item.type === "text")
          .map((item: { text?: string }) => item.text ?? "")
          .join("\n");
        return {
          content: result.content,
          structuredContent: {
            text,
            details: result.details ?? {},
          },
        };
      }, { shutdownCancellable: config.name !== "lsp_rename" }));
    },
  };

  pi.registerTool({
    name: "lsp_goto_definition",
    label: "LSP Go To Definition",
    description: "Jump to symbol definition. Find WHERE something is defined.",
    promptSnippet: "Jump to a symbol definition with the configured language server.",
    parameters: Type.Object({
      filePath: Type.String(),
      line: Type.Number({ minimum: 1, description: "1-based" }),
      character: Type.Number({ minimum: 0, description: "0-based" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const filePath = normalizePath(ctx.cwd, params.filePath);
        const result = await withLspClient(manager, ctx.cwd, filePath, commandPath, (client) => client.definition(filePath, params.line, params.character) as Promise<Location | Location[] | LocationLink[] | null>);
        if (!result) return textResult("No definition found");
        const locations = Array.isArray(result) ? result : [result];
        if (locations.length === 0) return textResult("No definition found");
        return textResult(locations.map(formatLocation).join("\n"), { locations });
      } catch (error) {
        return errorText(error);
      }
    },
  });

  pi.registerTool({
    name: "lsp_find_references",
    label: "LSP Find References",
    description: "Find ALL usages/references of a symbol across the entire workspace.",
    promptSnippet: "Find all references to a symbol with the configured language server.",
    parameters: Type.Object({
      filePath: Type.String(),
      line: Type.Number({ minimum: 1, description: "1-based" }),
      character: Type.Number({ minimum: 0, description: "0-based" }),
      includeDeclaration: Type.Optional(Type.Boolean({ description: "Include the declaration itself" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const filePath = normalizePath(ctx.cwd, params.filePath);
        const result = await withLspClient(manager, ctx.cwd, filePath, commandPath, (client) => client.references(filePath, params.line, params.character, params.includeDeclaration ?? true) as Promise<Location[] | null>);
        if (!result || result.length === 0) return textResult("No references found");
        const total = result.length;
        const limited = total > DEFAULT_MAX_REFERENCES ? result.slice(0, DEFAULT_MAX_REFERENCES) : result;
        const lines = limited.map(formatLocation);
        if (total > DEFAULT_MAX_REFERENCES) lines.unshift(`Found ${total} references (showing first ${DEFAULT_MAX_REFERENCES}):`);
        return textResult(lines.join("\n"), { total, shown: limited.length });
      } catch (error) {
        return errorText(error);
      }
    },
  });

  pi.registerTool({
    name: "lsp_symbols",
    label: "LSP Symbols",
    description: "Get symbols from file (document) or search across workspace. Use scope='document' for file outline, scope='workspace' for project-wide symbol search.",
    promptSnippet: "Get document symbols or search workspace symbols with LSP.",
    parameters: Type.Object({
      filePath: Type.String({ description: "File path for LSP context" }),
      scope: Type.Optional(Type.Union([Type.Literal("document"), Type.Literal("workspace")], { default: "document", description: "'document' for file symbols, 'workspace' for project-wide search" })),
      query: Type.Optional(Type.String({ description: "Symbol name to search (required for workspace scope)" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 200)" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const filePath = normalizePath(ctx.cwd, params.filePath);
        const scope = params.scope ?? "document";

        if (scope === "workspace") {
          if (!params.query) return textResult("Error: 'query' is required for workspace scope");
          const result = await withLspClient(manager, ctx.cwd, filePath, commandPath, (client) => client.workspaceSymbols(params.query!) as Promise<SymbolInfo[] | null>);
          if (!result || result.length === 0) return textResult("No symbols found");
          const limit = Math.min(params.limit ?? DEFAULT_MAX_SYMBOLS, DEFAULT_MAX_SYMBOLS);
          const lines = result.slice(0, limit).map(formatSymbolInfo);
          if (result.length > limit) lines.unshift(`Found ${result.length} symbols (showing first ${limit}):`);
          return textResult(lines.join("\n"), { total: result.length, shown: Math.min(result.length, limit) });
        }

        const result = await withLspClient(manager, ctx.cwd, filePath, commandPath, (client) => client.documentSymbols(filePath) as Promise<DocumentSymbol[] | SymbolInfo[] | null>);
        if (!result || result.length === 0) return textResult("No symbols found");
        const limit = Math.min(params.limit ?? DEFAULT_MAX_SYMBOLS, DEFAULT_MAX_SYMBOLS);
        const limited = result.slice(0, limit);
        const lines: string[] = [];
        if (result.length > limit) lines.push(`Found ${result.length} symbols (showing first ${limit}):`);
        if (limited.length > 0 && "range" in limited[0]!) lines.push(...(limited as DocumentSymbol[]).map((symbol) => formatDocumentSymbol(symbol)));
        else lines.push(...(limited as SymbolInfo[]).map(formatSymbolInfo));
        return textResult(lines.join("\n"), { total: result.length, shown: limited.length });
      } catch (error) {
        return errorText(error);
      }
    },
  });

  pi.registerTool({
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description: "Get errors, warnings, hints from language server BEFORE running build. Use filePath for a single file, or filePath with extension for a directory.",
    promptSnippet: "Get diagnostics from the configured language server.",
    parameters: Type.Object({
      filePath: Type.Optional(Type.String({ description: "File or directory path to check diagnostics for" })),
      directory: Type.Optional(Type.String({ description: "Alias for filePath when checking a directory" })),
      severity: Type.Optional(Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("information"), Type.Literal("hint"), Type.Literal("all")], { description: "Filter by severity level" })),
      extension: Type.Optional(Type.String({ description: "Required if target is a directory. Example: '.ts'" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const targetPath = params.filePath || params.directory;
        if (!targetPath) throw new Error("Provide either 'filePath' or 'directory' parameter.");
        const absoluteTarget = normalizePath(ctx.cwd, targetPath);
        if (isDirectoryPath(absoluteTarget)) {
          if (!params.extension) throw new Error("Directory path requires 'extension' parameter. Example: lsp_diagnostics(filePath='src', extension='.ts')");
          return textResult(await aggregateDiagnosticsForDirectory(manager, ctx.cwd, absoluteTarget, params.extension, commandPath, params.severity, signal));
        }
        const result = await withLspClient(manager, ctx.cwd, absoluteTarget, commandPath, (client) => client.diagnostics(absoluteTarget, signal) as Promise<{ items?: Diagnostic[] } | Diagnostic[] | null>);
        let diagnostics: Diagnostic[] = [];
        if (Array.isArray(result)) diagnostics = result;
        else if (result?.items) diagnostics = result.items;
        diagnostics = filterDiagnosticsBySeverity(diagnostics, params.severity);
        if (diagnostics.length === 0) return textResult("No diagnostics found");
        const limited = diagnostics.slice(0, DEFAULT_MAX_DIAGNOSTICS);
        const lines = limited.map(formatDiagnostic);
        if (diagnostics.length > DEFAULT_MAX_DIAGNOSTICS) lines.unshift(`Found ${diagnostics.length} diagnostics (showing first ${DEFAULT_MAX_DIAGNOSTICS}):`);
        return textResult(lines.join("\n"), { total: diagnostics.length, shown: limited.length });
      } catch (error) {
        return errorText(error);
      }
    },
  });

  pi.registerTool({
    name: "lsp_prepare_rename",
    label: "LSP Prepare Rename",
    description: "Check if rename is valid. Use BEFORE lsp_rename.",
    promptSnippet: "Check if a symbol can be renamed with LSP.",
    parameters: Type.Object({
      filePath: Type.String(),
      line: Type.Number({ minimum: 1, description: "1-based" }),
      character: Type.Number({ minimum: 0, description: "0-based" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const filePath = normalizePath(ctx.cwd, params.filePath);
        const result = await withLspClient(manager, ctx.cwd, filePath, commandPath, (client) => client.prepareRename(filePath, params.line, params.character) as Promise<PrepareRenameResult | PrepareRenameDefaultBehavior | Range | null>);
        return textResult(formatPrepareRenameResult(result), { result });
      } catch (error) {
        return errorText(error);
      }
    },
  });

  pi.registerTool({
    name: "lsp_rename",
    label: "LSP Rename",
    description: "Rename symbol across entire workspace. APPLIES changes to all files.",
    promptSnippet: "Rename a symbol across the workspace using LSP and apply edits.",
    parameters: Type.Object({
      filePath: Type.String(),
      line: Type.Number({ minimum: 1, description: "1-based" }),
      character: Type.Number({ minimum: 0, description: "0-based" }),
      newName: Type.String({ description: "New symbol name" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const filePath = normalizePath(ctx.cwd, params.filePath);
        const edit = await withLspClient(manager, ctx.cwd, filePath, commandPath, (client) => client.rename(filePath, params.line, params.character, params.newName) as Promise<WorkspaceEdit | null>);
        const result = await mutations.runExclusive(
          workspaceEditPaths(edit),
          async () => applyWorkspaceEdit(edit),
        );
        return textResult(formatApplyResult(result), result as unknown as Record<string, unknown>);
      } catch (error) {
        return errorText(error);
      }
    },
  });
}
