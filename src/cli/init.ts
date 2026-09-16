/** `init` subcommand: register the plugin in an OpenCode config file.
 *
 * Detects the active OpenCode config (global or project), generates the plugin
 * entry (path reference by default, npm spec with --npm), backs up the existing
 * config before writing, and refuses to clobber an already-registered entry or
 * a malformed file. Supports --dry-run, --print, and --yes for non-interactive
 * use. Never prints the full config contents (user configs may carry secrets).
 */
import { parseArgs } from "node:util"
import { homedir } from "node:os"
import { createHash } from "node:crypto"
import { satisfies } from "semver"
import { applyEdits, modify } from "jsonc-parser"
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { VERIFIED_V2_VERSION } from "../opencode/host-guard.ts"
import { stripCommentsAndTrailingCommas } from "../config/jsonc.ts"

interface PackageInfo {
  name: string
  version: string
  engines: { bun?: string; opencode?: string }
  root: string
}

type HostGeneration = "v1" | "v2"
type PluginEntry =
  | string
  | [string, Record<string, unknown>]
  | { package: string; options?: Record<string, unknown> }

const DEFAULT_PLUGIN_OPTIONS: Record<string, unknown> = {
  model: "openai/gpt-5.6-luna",
  variant: "max",
  timeoutMs: 120_000,
}

export async function runInit(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: "string" },
      global: { type: "boolean" },
      tui: { type: "boolean" },
      host: { type: "string", default: "auto" },
      binary: { type: "string", default: "opencode" },
      "dry-run": { type: "boolean" },
      print: { type: "boolean" },
      yes: { type: "boolean" },
      json: { type: "boolean" },
      npm: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  })

  if (values.help) {
    process.stderr.write(usage())
    return 0
  }

  const directory = values.project ?? process.cwd()
  if (!existsSync(directory)) {
    console.error(`init: project directory does not exist: ${directory}`)
    return 1
  }

  const pkg = readPackageInfo()
  if (!["auto", "v1", "v2"].includes(values.host!)) {
    console.error("init: --host must be auto, v1, or v2")
    return 2
  }
  const versionChecks = await runVersionChecks(pkg, values.binary!)
  if (values.host === "auto" && !versionChecks.find((check) => check.name === "opencode")?.ok) {
    console.error("init: detected host is unavailable or unsupported; no configuration was written")
    return 2
  }
  const version = versionChecks.find((check) => check.name === "opencode")?.version
  const detected = version?.startsWith("1.") ? "v1" : version?.startsWith("2.") ? "v2" : undefined
  const host = values.host === "auto" ? detected : (values.host as HostGeneration)
  if (!host) {
    console.error("init: cannot determine the host; pass --host v1 or --host v2")
    return 2
  }
  const entry = buildEntry(pkg, Boolean(values.npm), host)
  const targets = resolveTargets(directory, Boolean(values.global), Boolean(values.tui), host)
  const existingConfig = existsSync(targets.config) ? parseConfigFile(targets.config) : undefined
  if (
    values.host === "auto" &&
    existingConfig &&
    ((host === "v1" && "plugins" in existingConfig) ||
      (host === "v2" && "plugin" in existingConfig))
  ) {
    console.error("init: binary version and config format disagree; select --host explicitly")
    return 2
  }

  const plans = [targets.config, ...(targets.tui ? [targets.tui] : [])].map((p) =>
    planFileChange(p, pkg, host),
  )

  // --- output -------------------------------------------------------------

  if (values.print) {
    // Only the entry, never the full config (may contain secrets).
    console.log(JSON.stringify(entry, null, 2))
    return 0
  }

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          command: "init",
          host,
          dryRun: Boolean(values["dry-run"]),
          package: { name: pkg.name, version: pkg.version, root: pkg.root },
          versionChecks,
          targets: plans.map((p) => ({
            path: p.path,
            exists: existsSync(p.path),
            action: p.action,
            ...(p.backup ? { backup: p.backup } : {}),
          })),
          entry,
          writes: [],
          plannedWrites: plans
            .filter((p) => p.action === "append" || p.action === "create")
            .map((p) => p.path),
        },
        null,
        2,
      ),
    )
    return 0
  }

  // Human report (stderr so --json/--print stdout stays clean).
  console.error(`init: opencode-permission-reviewer ${pkg.version}`)
  for (const c of versionChecks) {
    const tag = c.ok ? "ok" : "warning"
    console.error(`  ${c.name}: ${c.version} (${c.range}) ${tag}`)
  }
  console.error(`  entry: ${JSON.stringify(entry)}`)

  for (const plan of plans) {
    console.error(`  ${plan.path}: ${plan.action}`)
  }

  if (values["dry-run"]) {
    console.error("init: dry-run, no files written")
    console.error("rollback: (nothing was changed)")
    return 0
  }

  // --- interactive gate ---------------------------------------------------

  if (!values.yes) {
    if (!process.stdin.isTTY) {
      console.error("init: not a TTY; pass --yes to apply changes non-interactively")
      return 2
    }
    process.stderr.write("Apply these changes? [y/N] ")
    const answer = (await readStdin()).trim().toLowerCase()
    if (answer !== "y" && answer !== "yes") {
      console.error("init: aborted, nothing changed")
      return 0
    }
  }

  // --- write --------------------------------------------------------------

  return applyPlannedWrites(plans, entry, pkg, host)
}

/** Apply precomputed file plans. Each plan is re-resolved against the current
 *  file before its write: the filesystem may have changed between planning
 *  and applying (concurrent edit, new file), and a drifted plan refuses that
 *  file's write instead of acting on stale assumptions. Returns the process
 *  exit code. Exported so unit tests can drive it with stale plans and cover
 *  the drift guards without racing the CLI. */
export function applyPlannedWrites(
  plans: FilePlan[],
  entry: PluginEntry,
  pkg: PackageInfo,
  host: HostGeneration = "v1",
): number {
  const written: string[] = []
  for (const plan of plans) {
    if (plan.action === "noop") continue
    const fresh = planFileChange(plan.path, pkg, host)
    if (
      fresh.action !== plan.action ||
      (plan.fingerprint !== undefined && fresh.fingerprint !== plan.fingerprint)
    ) {
      console.error(
        `init: ${plan.path} changed since planning (was ${plan.action}, now ${fresh.action}); refusing to write`,
      )
      return 1
    }
    if (fresh.action === "error") {
      console.error(
        `init: ${plan.path} is malformed or has a non-array "plugin" key; refusing to write`,
      )
      return 1
    }
    // append or create
    if (fresh.backup !== undefined && existsSync(plan.path)) {
      console.error(`  backup: ${writeBackup(plan.path, fresh.backup)}`)
    }
    try {
      writeEntry(plan.path, entry, fresh.action === "create", host, fresh.fingerprint)
    } catch (error) {
      // A file created in the residual race between re-planning and writing
      // must never be clobbered; anything else is unexpected and propagates.
      if ((error as { code?: unknown }).code !== "EEXIST") throw error
      console.error(`init: ${plan.path} was created concurrently; refusing to overwrite`)
      return 1
    }
    written.push(plan.path)
  }

  console.error("init: done")
  console.error("next: restart OpenCode to load the plugin")
  console.error(
    'next: ensure at least one permission "ask" rule (e.g. bash), or the plugin is a no-op',
  )
  if (plans.some((p) => p.backup)) {
    console.error("rollback: restore from the .bak file above and restart OpenCode")
  }

  return 0
}

/** Copy the current file to a backup name, claiming the destination
 *  atomically: when the planned name was taken concurrently, the next free
 *  rotation name is used instead of overwriting the collision. Returns the
 *  backup path actually written. Exported for unit tests. */
export function writeBackup(source: string, preferred: string): string {
  let dest = preferred
  for (;;) {
    try {
      copyFileSync(source, dest, fsConstants.COPYFILE_EXCL)
      return dest
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") throw error
      dest = backupPath(source)
    }
  }
}

// --- internals ----------------------------------------------------------------

function usage(): string {
  return `Usage:
  opencode-permission-reviewer init [--project <dir>] [--global] [--tui]
                                    [--npm] [--dry-run] [--print] [--yes] [--json]

Register the permission-reviewer plugin in an OpenCode config file.
Backs up the existing file before writing. Never overwrites an already-
registered entry or a malformed config.

  --project <dir>   target project directory (default: cwd)
  --global          target ~/.config/opencode/opencode.json
  --tui             also register in tui.json
  --host <host>     v1, v2, or auto (default); auto refuses uncertain detection
  --binary <path>   OpenCode binary used for version detection
  --npm             emit an npm spec entry instead of a path reference
  --dry-run         print the plan, write nothing
  --print           print only the plugin entry JSON to stdout
  --yes             skip confirmation (required when stdin is not a TTY)
  --json            print planned changes as JSON without writing files
`
}

function readPackageInfo(): PackageInfo {
  let dir = import.meta.dirname ?? process.cwd()
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, "package.json")
    if (existsSync(candidate)) {
      const raw = JSON.parse(readFileSync(candidate, "utf8")) as {
        name?: string
        version?: string
        engines?: { bun?: string; opencode?: string }
      }
      return {
        name: raw.name ?? "opencode-permission-reviewer",
        version: raw.version ?? "0.0.0",
        engines: raw.engines ?? {},
        root: dir,
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error("init: could not locate package.json")
}

function buildEntry(pkg: PackageInfo, npm: boolean, host: HostGeneration): PluginEntry {
  // When installed via npm the root is under node_modules; emit a bare spec so
  // opencode resolves it from its own node_modules. Otherwise emit an absolute
  // path reference (the documented dev workflow).
  const fromNodeModules = pkg.root.includes(join("node_modules", ""))
  if (npm || fromNodeModules) {
    const name = `${pkg.name}@^${pkg.version}`
    return host === "v2" ? { package: name, options: {} } : name
  }
  return host === "v2"
    ? { package: pkg.root, options: {} }
    : [pkg.root, { ...DEFAULT_PLUGIN_OPTIONS }]
}

function resolveTargets(
  directory: string,
  forceGlobal: boolean,
  wantTui: boolean,
  host: HostGeneration,
): { config: string; tui?: string } {
  const globalDir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode")
  const globalCfg = pickExisting([
    join(globalDir, "opencode.json"),
    join(globalDir, "opencode.jsonc"),
  ])
  const projectCfg = pickExisting([
    join(directory, "opencode.json"),
    join(directory, "opencode.jsonc"),
    join(directory, ".opencode", "opencode.json"),
    join(directory, ".opencode", "opencode.jsonc"),
  ])
  const configPath = forceGlobal
    ? (globalCfg ?? join(globalDir, "opencode.json"))
    : (projectCfg ?? globalCfg ?? join(directory, "opencode.json"))

  if (!wantTui) return { config: configPath }
  if (host === "v2") return { config: configPath, tui: join(globalDir, "cli.json") }

  const tuiDir = forceGlobal ? globalDir : dirname(configPath)
  const tuiPath =
    pickExisting([join(tuiDir, "tui.json"), join(tuiDir, "tui.jsonc")]) ?? join(tuiDir, "tui.json")
  return { config: configPath, tui: tuiPath }
}

function pickExisting(candidates: string[]): string | undefined {
  return candidates.find((p) => existsSync(p))
}

function parseConfigFile(path: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(path, "utf8")
    if (raw.trim() === "") return {}
    const parsed: unknown = JSON.parse(stripCommentsAndTrailingCommas(raw))
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function isOurEntry(entry: unknown, pkg: PackageInfo, directory: string): boolean {
  let head: string | undefined
  if (typeof entry === "string") {
    head = entry
  } else if (Array.isArray(entry) && typeof entry[0] === "string") {
    head = entry[0]
  } else if (
    typeof entry === "object" &&
    entry !== null &&
    "package" in entry &&
    typeof entry.package === "string"
  ) {
    head = entry.package
  }
  if (head === undefined) return false
  if (head === pkg.root || head === pkg.name || head.startsWith(`${pkg.name}@`)) return true
  try {
    const path = head.startsWith("file:") ? fileURLToPath(head) : resolve(directory, head)
    return realpathSync(path) === realpathSync(pkg.root)
  } catch {
    return false
  }
}

interface FilePlan {
  path: string
  action: "create" | "append" | "noop" | "error"
  backup?: string
  fingerprint?: string
}

export type { FilePlan, PackageInfo, PluginEntry }

export function planFileChange(
  path: string,
  pkg: PackageInfo,
  host: HostGeneration = "v1",
): FilePlan {
  if (!existsSync(path)) {
    return { path, action: "create" }
  }
  const cfg = parseConfigFile(path)
  if (cfg === null) {
    return { path, action: "error" }
  }
  const fingerprint = createHash("sha256").update(readFileSync(path)).digest("hex")
  const plugin = cfg[host === "v2" ? "plugins" : "plugin"]
  if (plugin === undefined) {
    return { path, action: "append", backup: backupPath(path), fingerprint }
  }
  if (!Array.isArray(plugin)) {
    return { path, action: "error" }
  }
  const matching = plugin.filter((entry) => isOurEntry(entry, pkg, dirname(path)))
  if (matching.length > 1) return { path, action: "error" }
  if (matching.length === 1) {
    const existing = matching[0]
    const isObject = typeof existing === "object" && existing !== null && !Array.isArray(existing)
    if (isObject !== (host === "v2")) return { path, action: "error" }
    const spec =
      typeof existing === "string"
        ? existing
        : Array.isArray(existing)
          ? existing[0]
          : existing.package
    if (
      typeof spec === "string" &&
      spec.startsWith(`${pkg.name}@`) &&
      spec !== `${pkg.name}@${pkg.version}`
    )
      return { path, action: "error" }
    return { path, action: "noop" }
  }
  return { path, action: "append", backup: backupPath(path), fingerprint }
}

function backupPath(path: string): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  let bak = `${path}.bak-${stamp}`
  for (let i = 2; existsSync(bak); i++) bak = `${path}.bak-${stamp}-${i}`
  return bak
}

export function writeEntry(
  path: string,
  entry: PluginEntry,
  create: boolean,
  host: HostGeneration = "v1",
  fingerprint?: string,
): void {
  const key = host === "v2" ? "plugins" : "plugin"
  if (create) {
    mkdirSync(dirname(path), { recursive: true })
    const schema =
      path.includes("tui.json") || path.includes("tui.jsonc")
        ? "https://opencode.ai/tui.json"
        : "https://opencode.ai/config.json"
    const fresh: Record<string, unknown> = path.endsWith("cli.json")
      ? { [key]: [entry] }
      : { $schema: schema, [key]: [entry] }
    // Exclusive create: a file that appeared after planning is never
    // clobbered; the EEXIST failure maps to a refusal in the caller.
    writeFileSync(path, `${JSON.stringify(fresh, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
    return
  }
  const raw = readFileSync(path, "utf8")
  if (fingerprint !== undefined && createHash("sha256").update(raw).digest("hex") !== fingerprint) {
    throw new Error("Config changed after planning; refusing to overwrite")
  }
  const cfg = parseConfigFile(path)
  if (!cfg || (cfg[key] !== undefined && !Array.isArray(cfg[key])))
    throw new Error("Invalid plugin config")
  const edits = modify(
    raw.trim() ? raw : "{}",
    cfg[key] === undefined ? [key] : [key, -1],
    cfg[key] === undefined ? [entry] : entry,
    {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    },
  )
  writeFileSync(path, applyEdits(raw.trim() ? raw : "{}", edits), "utf8")
}

interface VersionCheck {
  name: string
  version: string
  range: string
  ok: boolean
}

async function runVersionChecks(pkg: PackageInfo, binary: string): Promise<VersionCheck[]> {
  const checks: VersionCheck[] = []
  const bunVer = process.versions.bun ?? process.versions.node ?? "0.0.0"
  const bunRange = pkg.engines.bun ?? "(unstated)"
  checks.push({
    name: "bun",
    version: bunVer,
    range: bunRange,
    ok: !pkg.engines.bun || satisfies(bunVer, pkg.engines.bun),
  })
  const ocVersion = await probeOpencodeVersion(binary)
  const ocRange = pkg.engines.opencode ?? "(unstated)"
  checks.push({
    name: "opencode",
    version: ocVersion ?? "(not found)",
    range: ocRange,
    ok:
      ocVersion !== undefined &&
      (!ocVersion.startsWith("2.") || ocVersion === VERIFIED_V2_VERSION) &&
      (!pkg.engines.opencode || satisfies(ocVersion, pkg.engines.opencode)),
  })
  return checks
}

export async function probeOpencodeVersion(binary = "opencode"): Promise<string | undefined> {
  try {
    const proc = Bun.spawn({ cmd: [binary, "--version"], stdout: "pipe", stderr: "pipe" })
    const timer = setTimeout(() => proc.kill(), 2000)
    const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
    clearTimeout(timer)
    if (code !== 0) return undefined
    return (out.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/) ?? [])[0]
  } catch {
    return undefined
  }
}

async function readStdin(): Promise<string> {
  return new Response(await Bun.stdin.text()).text()
}
