#!/usr/bin/env bun
/*
 * opencode-permission-reviewer CLI.
 *
 * Subcommands:
 *   init                 register the plugin in an OpenCode config file
 *   explain              dry-run a bash request through the analyzer + policy engine
 *   doctor               report versions, config sources, audit path, policy mode
 *   config print-effective   print the resolved config + effective policy hash
 *   audit report         summarize the JSONL audit trail
 *
 * Backward compatible: invoked with no subcommand (or with a flag first), it
 * runs `explain` against stdin/`--event`, matching the original behavior.
 */
import { parseArgs } from "node:util"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, open } from "node:fs/promises"
import { dirname, join } from "node:path"
import { resolveConfig } from "../config.ts"
import { loadResolvedConfig, globalConfigPath, projectConfigPath } from "../config/loader.ts"
import { parseCommand } from "../capability/command-parser.ts"
import { analyzeCapability } from "../capability/bash-analyzer.ts"
import {
  evaluatePolicy,
  filterProjectAllowRules,
  hashEffectivePolicy,
} from "../policy/policy-engine.ts"
import { expandHome, resolveAuditPath, readAuditSummary, type AuditSummary } from "../audit.ts"
import { runInit } from "./init.ts"
import type { PermissionRequest, PermissionToolSource, ReviewerConfig } from "../types.ts"

// Guarded so importing the module (e.g. via the "./cli" export or in tests)
// never triggers the CLI or kills the importing process; only a direct
// `bun run`/bin invocation runs the dispatcher.
if (import.meta.main) {
  const code = await runCli(process.argv.slice(2))
  process.exit(code)
}

// --- dispatcher --------------------------------------------------------------

export async function runCli(argv: string[]): Promise<number> {
  const first = argv[0]
  const explicit = first !== undefined && !first.startsWith("-")
  const command = explicit ? first! : "explain"
  const rest = explicit ? argv.slice(1) : argv
  try {
    switch (command) {
      case "init":
        return await runInit(rest)
      case "explain":
        return await runExplain(rest)
      case "doctor":
        return await runDoctor(rest)
      case "config":
        return await runConfig(rest)
      case "audit":
        return await runAudit(rest)
      default:
        console.error(`unknown command: ${command}\n${usage()}`)
        return 2
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ERR_PARSE_ARGS_INVALID_OPTION") {
      console.error(String((error as Error).message ?? error))
      return 2
    }
    console.error(String((error as Error)?.message ?? error))
    return 2
  }
}

function usage(): string {
  return `Usage:
  opencode-permission-reviewer init [--project <dir>] [--global] [--tui] [--dry-run] [--print] [--yes]
  opencode-permission-reviewer explain [--event <file>] [--project <dir>]
  opencode-permission-reviewer doctor [--project <dir>] [--json]
  opencode-permission-reviewer config print-effective [--project <dir>]
  opencode-permission-reviewer audit report [--path <file>] [--project <dir>] [--json]`
}

// --- explain -----------------------------------------------------------------

async function runExplain(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      event: { type: "string" },
      project: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  })
  if (values.help) {
    console.error(`Usage: explain --event <fixture.json> [--project <dir>]
Reads a permission request JSON, runs the capability analyzer and policy engine
(observe mode), and prints the result as JSON.`)
    return 0
  }

  let raw: string
  if (values.event) {
    raw = readFileSync(values.event, "utf8")
  } else {
    raw = await readStdin()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.error("explain: input is not valid JSON")
    return 2
  }

  const request = normalizeRequest(parsed)
  if (request === undefined) {
    console.error('explain: input must have "permission" and "metadata.command" or "patterns"')
    return 2
  }

  const config = resolveConfig(undefined)
  const directory = values.project ?? process.cwd()
  const worktree = directory
  const command =
    typeof request.metadata?.command === "string"
      ? request.metadata.command
      : (request.patterns ?? []).filter((p) => typeof p === "string").join("\n")

  const result: Record<string, unknown> = { permission: request.permission, command }
  if (request.permission === "bash" && command.trim()) {
    const parsedCmd = parseCommand(command)
    const capability = analyzeCapability(parsedCmd, directory, worktree)
    const policyTrace = evaluatePolicy(capability, undefined, config, config.policyRules)
    result.capability = capability
    result.policyTrace = policyTrace
  } else {
    result.capability = null
    result.policyTrace = evaluatePolicy(undefined, undefined, config, config.policyRules)
  }
  console.log(JSON.stringify(result, null, 2))
  return 0
}

// --- doctor ------------------------------------------------------------------

async function runDoctor(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  })
  if (values.help) {
    console.error("Usage: doctor [--project <dir>] [--json]")
    return 0
  }
  const directory = values.project ?? process.cwd()
  const pkg = readPackageJson()
  const config = loadResolvedConfig(undefined, directory)
  const sources = inspectConfigSources(directory)
  const effectiveHash = hashEffectivePolicy(filterProjectAllowRules(config.policyRules), config)
  const auditPath = resolveAuditPath(config)
  const auditWritable = await checkWritable(auditPath)

  const report = {
    version: {
      package: pkg.version,
      opencodeRange: pkg.engines.opencode ?? "(unstated)",
      runtime: `bun/${process.versions.bun ?? "?"}`,
    },
    config: {
      global: sources.global,
      project: sources.project,
      model: config.model,
      enforcementMode: config.enforcementMode,
      repositoryTrust: config.repositoryTrust,
      policyRuleCount: config.policyRules.length,
      effectivePolicyHash: effectiveHash,
    },
    audit: {
      path: auditPath,
      writable: auditWritable.ok,
      ...(auditWritable.error ? { error: auditWritable.error } : {}),
    },
  }

  if (values.json) {
    console.log(JSON.stringify(report, null, 2))
    return 0
  }
  console.error(`opencode-permission-reviewer doctor ${pkg.version}`)
  console.error(`version`)
  console.error(`  package:    ${report.version.package}`)
  console.error(`  opencode:   ${report.version.opencodeRange} (engines.opencode)`)
  console.error(`  runtime:    ${report.version.runtime}`)
  console.error(`config`)
  console.error(`  global:     ${fmtSource(sources.global)}`)
  console.error(`  project:    ${fmtSource(sources.project)}`)
  console.error(`  model:      ${report.config.model}`)
  console.error(`  mode:       ${report.config.enforcementMode}`)
  console.error(`  trust:      ${report.config.repositoryTrust}`)
  console.error(
    `  rules:      ${report.config.policyRuleCount} (effectivePolicyHash: ${effectiveHash})`,
  )
  console.error(`audit`)
  console.error(`  path:       ${auditPath}`)
  console.error(
    `  writable:   ${auditWritable.ok ? "yes" : "no"}${auditWritable.error ? ` (${auditWritable.error})` : ""}`,
  )
  return 0
}

// --- config print-effective --------------------------------------------------

async function runConfig(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { project: { type: "string" }, help: { type: "boolean", short: "h" } },
    strict: true,
    allowPositionals: true,
  })
  if (values.help || positionals[0] !== "print-effective") {
    console.error("Usage: config print-effective [--project <dir>]")
    return 2
  }
  const directory = values.project ?? process.cwd()
  const config = loadResolvedConfig(undefined, directory)
  const sources = inspectConfigSources(directory)
  const report = {
    command: "print-effective",
    directory,
    sources,
    config: redactConfig(config),
    policy: {
      ruleCount: config.policyRules.length,
      effectivePolicyHash: hashEffectivePolicy(filterProjectAllowRules(config.policyRules), config),
    },
  }
  console.log(JSON.stringify(report, null, 2))
  return 0
}

// --- audit report ------------------------------------------------------------

async function runAudit(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      path: { type: "string" },
      project: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  })
  if (values.help || positionals[0] !== "report") {
    console.error("Usage: audit report [--path <file>] [--project <dir>] [--json]")
    return 2
  }
  const directory = values.project ?? process.cwd()
  const config = loadResolvedConfig(undefined, directory)
  const auditPath = values.path ? expandHome(values.path) : resolveAuditPath(config)
  const summary = readAuditSummary(auditPath)
  if (!summary.exists) {
    console.error(`audit report: ${auditPath}: no such file`)
    return 1
  }
  if (values.json) {
    console.log(JSON.stringify(summary, null, 2))
    return 0
  }
  printAuditHuman(summary)
  return 0
}

function printAuditHuman(s: AuditSummary): void {
  console.log(`audit report: ${s.path}`)
  console.log(`  valid records:     ${s.validRecords} (invalid lines: ${s.invalidLines})`)
  console.log(`  schema versions:   ${fmtCounts(s.bySchemaVersion)}`)
  if (s.firstTimestamp || s.lastTimestamp) {
    console.log(`  time range:        ${s.firstTimestamp ?? "?"} → ${s.lastTimestamp ?? "?"}`)
  }
  console.log(`  by outcome:        ${fmtCounts(s.byOutcome)}`)
  console.log(`  by risk level:     ${fmtCounts(s.byRiskLevel)}`)
  if (Object.keys(s.byDecisionSource).length > 0) {
    console.log(`  by decision source:${fmtCounts(s.byDecisionSource)}`)
  }
  if (Object.keys(s.byPermission).length > 0) {
    console.log(`  by permission:     ${fmtCounts(s.byPermission)}`)
  }
  if (s.unknownActorNames.length > 0) {
    console.log(`  unknown actors:    ${s.unknownActorNames.length}`)
    for (const a of s.unknownActorNames.slice(0, 10)) console.log(`    ${a.name} (${a.count})`)
  }
  if (s.missingRequiredFields.length > 0) {
    console.log(`  missing required fields: ${s.missingRequiredFields.length}`)
    for (const m of s.missingRequiredFields.slice(0, 10)) {
      console.log(`    line ${m.lineNo}: missing ${m.missing.join(", ")}`)
    }
  }
}

// --- shared helpers ----------------------------------------------------------

/** Locate the nearest package.json by walking up from this module. The CLI
 *  lives at <root>/src/cli (source) or <root>/dist (bundle), so the package
 *  root is a different number of levels up in each layout; searching upward
 *  works for both. */
function readPackageJson(): { version: string; engines: { opencode?: string; bun?: string } } {
  let dir = import.meta.dirname
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, "package.json")
    if (existsSync(candidate)) {
      const raw = JSON.parse(readFileSync(candidate, "utf8")) as {
        version: string
        engines?: { opencode?: string; bun?: string }
      }
      return { version: raw.version, engines: raw.engines ?? {} }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error("could not locate package.json")
}

interface SourceInfo {
  path: string
  exists: boolean
  sha256: string | null
}

function inspectConfigSources(directory: string): { global: SourceInfo; project: SourceInfo } {
  return {
    global: inspectFile(globalConfigPath()),
    project: inspectFile(projectConfigPath(directory)),
  }
}

function inspectFile(path: string): SourceInfo {
  try {
    const content = readFileSync(path, "utf8")
    return { path, exists: true, sha256: sha256hex(content).slice(0, 16) }
  } catch {
    return { path, exists: false, sha256: null }
  }
}

function fmtSource(s: SourceInfo): string {
  return `${s.path}  exists=${s.exists ? "yes" : "no"}  sha256=${s.sha256 ?? "-"}`
}

function fmtCounts(map: Record<string, number>): string {
  const entries = Object.entries(map)
  if (entries.length === 0) return "(none)"
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(" | ")
}

async function checkWritable(path: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await mkdir(dirname(path), { recursive: true })
    // Match the writer's 0600 mode so a doctor probe never leaves a
    // world-readable audit trail behind.
    const fh = await open(path, "a", 0o600)
    await fh.close()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

/** Defensive redaction: no ReviewerConfig field is sensitive today, but this
 *  guards against future additions (tokens, keys) leaking via print-effective. */
function redactConfig(config: ReviewerConfig): ReviewerConfig {
  return config
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => (data += chunk))
    process.stdin.on("end", () => resolve(data))
  })
}

function normalizeRequest(value: unknown): PermissionRequest | undefined {
  if (typeof value !== "object" || value === null) return
  const v = value as Record<string, unknown>
  if (typeof v.permission !== "string") return
  const req: PermissionRequest = {
    id: typeof v.id === "string" ? v.id : "explain-dry-run",
    sessionID: typeof v.sessionID === "string" ? v.sessionID : "explain-session",
    permission: v.permission,
    patterns: Array.isArray(v.patterns) ? v.patterns : [],
    always: Array.isArray(v.always) ? v.always : [],
    metadata:
      typeof v.metadata === "object" && v.metadata !== null
        ? (v.metadata as Record<string, unknown>)
        : {},
  }
  if (
    typeof v.tool === "object" &&
    v.tool !== null &&
    typeof (v.tool as Record<string, unknown>).messageID === "string"
  ) {
    req.tool = v.tool as PermissionToolSource
  }
  return req
}
