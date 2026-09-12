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
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { stripCommentsAndTrailingCommas } from "../config/jsonc.ts"

interface PackageInfo {
  name: string
  version: string
  engines: { bun?: string; opencode?: string }
  root: string
}

type PluginEntry = string | [string, Record<string, unknown>]

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
  const entry = buildEntry(pkg, Boolean(values.npm))
  const versionChecks = await runVersionChecks(pkg)
  const targets = resolveTargets(directory, Boolean(values.global), Boolean(values.tui))

  const plans = [targets.config, ...(targets.tui ? [targets.tui] : [])].map((p) =>
    planFileChange(p, pkg),
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
          writes: values["dry-run"]
            ? []
            : plans
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

  return applyPlannedWrites(plans, entry, pkg)
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
): number {
  const written: string[] = []
  for (const plan of plans) {
    if (plan.action === "noop") continue
    const fresh = planFileChange(plan.path, pkg)
    if (fresh.action !== plan.action) {
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
      writeEntry(plan.path, entry, fresh.action === "create")
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
  --npm             emit an npm spec entry instead of a path reference
  --dry-run         print the plan, write nothing
  --print           print only the plugin entry JSON to stdout
  --yes             skip confirmation (required when stdin is not a TTY)
  --json            machine-readable report on stdout
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

function buildEntry(pkg: PackageInfo, npm: boolean): PluginEntry {
  // When installed via npm the root is under node_modules; emit a bare spec so
  // opencode resolves it from its own node_modules. Otherwise emit an absolute
  // path reference (the documented dev workflow).
  const fromNodeModules = pkg.root.includes(join("node_modules", ""))
  if (npm || fromNodeModules) {
    return `${pkg.name}@^${pkg.version}`
  }
  return [pkg.root, { ...DEFAULT_PLUGIN_OPTIONS }]
}

function resolveTargets(
  directory: string,
  forceGlobal: boolean,
  wantTui: boolean,
): { config: string; tui?: string } {
  const globalDir = join(homedir(), ".config", "opencode")
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

function isOurEntry(entry: unknown, pkg: PackageInfo): boolean {
  let head: string | undefined
  if (typeof entry === "string") {
    head = entry
  } else if (Array.isArray(entry) && typeof entry[0] === "string") {
    head = entry[0]
  }
  if (head === undefined) return false
  return head === pkg.root || head === pkg.name || head.startsWith(`${pkg.name}@`)
}

interface FilePlan {
  path: string
  action: "create" | "append" | "noop" | "error"
  backup?: string
}

export type { FilePlan, PackageInfo, PluginEntry }

export function planFileChange(path: string, pkg: PackageInfo): FilePlan {
  if (!existsSync(path)) {
    return { path, action: "create" }
  }
  const cfg = parseConfigFile(path)
  if (cfg === null) {
    return { path, action: "error" }
  }
  const plugin = cfg.plugin
  if (plugin === undefined) {
    return { path, action: "append", backup: backupPath(path) }
  }
  if (!Array.isArray(plugin)) {
    return { path, action: "error" }
  }
  if (plugin.some((e) => isOurEntry(e, pkg))) {
    return { path, action: "noop" }
  }
  return { path, action: "append", backup: backupPath(path) }
}

function backupPath(path: string): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  let bak = `${path}.bak-${stamp}`
  for (let i = 2; existsSync(bak); i++) bak = `${path}.bak-${stamp}-${i}`
  return bak
}

export function writeEntry(path: string, entry: PluginEntry, create: boolean): void {
  if (create) {
    mkdirSync(dirname(path), { recursive: true })
    const schema =
      path.includes("tui.json") || path.includes("tui.jsonc")
        ? "https://opencode.ai/tui.json"
        : "https://opencode.ai/config.json"
    const fresh: Record<string, unknown> = { $schema: schema, plugin: [entry] }
    // Exclusive create: a file that appeared after planning is never
    // clobbered; the EEXIST failure maps to a refusal in the caller.
    writeFileSync(path, `${JSON.stringify(fresh, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
    return
  }
  const cfg = parseConfigFile(path) ?? {}
  const plugin = Array.isArray(cfg.plugin) ? cfg.plugin : []
  plugin.push(entry)
  cfg.plugin = plugin
  // Warn if the source had comments (rewrite drops them — JSONC limitation).
  try {
    const raw = readFileSync(path, "utf8")
    if (hasComments(raw)) {
      console.error(
        `init: warning: rewriting ${path} drops comments and trailing commas (JSONC round-trip limitation)`,
      )
    }
  } catch {
    // ignore
  }
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf8")
}

/** Detects whether the raw text has line or block comments outside strings. */
function hasComments(raw: string): boolean {
  let i = 0
  while (i < raw.length) {
    const ch = raw[i]!
    if (ch === '"') {
      i += 1
      while (i < raw.length) {
        if (raw[i] === "\\") {
          i += 2
          continue
        }
        i += 1
        if (raw[i - 1] === '"') break
      }
      continue
    }
    if (ch === "/" && (raw[i + 1] === "/" || raw[i + 1] === "*")) return true
    i += 1
  }
  return false
}

interface VersionCheck {
  name: string
  version: string
  range: string
  ok: boolean
}

async function runVersionChecks(pkg: PackageInfo): Promise<VersionCheck[]> {
  const checks: VersionCheck[] = []
  const bunVer = process.versions.bun ?? process.versions.node ?? "0.0.0"
  const bunRange = pkg.engines.bun ?? "(unstated)"
  checks.push({
    name: "bun",
    version: bunVer,
    range: bunRange,
    ok: !pkg.engines.bun || satisfies(bunVer, pkg.engines.bun),
  })
  const ocVersion = await probeOpencodeVersion()
  const ocRange = pkg.engines.opencode ?? "(unstated)"
  checks.push({
    name: "opencode",
    version: ocVersion ?? "(not found)",
    range: ocRange,
    ok:
      ocVersion !== undefined &&
      (!pkg.engines.opencode || satisfies(ocVersion, pkg.engines.opencode)),
  })
  return checks
}

async function probeOpencodeVersion(): Promise<string | undefined> {
  try {
    const proc = Bun.spawn({ cmd: ["opencode", "--version"], stdout: "pipe", stderr: "pipe" })
    const timer = setTimeout(() => proc.kill(), 2000)
    const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
    clearTimeout(timer)
    if (code !== 0) return undefined
    return (out.match(/\d+\.\d+\.\d+/) ?? [])[0]
  } catch {
    return undefined
  }
}

/** Lightweight semver satisfies check (no dependency). Handles `>=`, `<`, and
 *  exact ranges as used in engines.opencode (e.g. ">=1.18.11 <2"). Strips
 *  prerelease suffixes before comparing. */
function satisfies(version: string, range: string): boolean {
  const v = parseSemver(version)
  if (v === null) return false
  const comparators = range.split(/\s+/).filter(Boolean)
  for (const c of comparators) {
    const m = c.match(/^(>=|<=|>|<|==|=|\^|~)?(\d+(?:\.\d+){0,2})$/)
    if (m === null) continue
    const op = m[1] ?? "="
    const r = parseSemver(m[2]!)
    if (r === null) continue
    const cmp = compareSemver(v, r)
    let ok: boolean
    switch (op) {
      case ">=":
        ok = cmp >= 0
        break
      case "<=":
        ok = cmp <= 0
        break
      case ">":
        ok = cmp > 0
        break
      case "<":
        ok = cmp < 0
        break
      default:
        ok = cmp === 0
    }
    if (!ok) return false
  }
  return true
}

function parseSemver(s: string): { major: number; minor: number; patch: number } | null {
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (m === null) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

function compareSemver(
  a: { major: number; minor: number; patch: number },
  b: { major: number; minor: number; patch: number },
): number {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1
  return 0
}

async function readStdin(): Promise<string> {
  return new Response(await Bun.stdin.text()).text()
}
