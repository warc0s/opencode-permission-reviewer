import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { basename, resolve } from "node:path"
import type { PermissionRequest } from "./types.ts"
import { sourceCommand } from "./evidence/source-command.ts"
import { shellCommandSegmentsWithDirectory } from "./ssh-evidence.ts"

const execFileAsync = promisify(execFile)

export interface GitEnrichmentResult {
  text: string
}

interface PlannedGitActions {
  relevant: boolean
  commit: boolean
  plannedAdd: string[]
  discardTargets: string[]
  removeTargets: string[]
  commands: string[]
  executionDirectory?: string
  directoryReason?: string
}

function gitSubcommand(tokens: string[], gitIndex: number): { command?: string; index: number } {
  let index = gitIndex + 1
  while (index < tokens.length) {
    const token = tokens[index]!
    if (token === "-C" || token === "-c" || token === "--git-dir" || token === "--work-tree") {
      index += 2
      continue
    }
    if (token.startsWith("-")) {
      index += 1
      continue
    }
    return { command: token, index }
  }
  return { index }
}

function positionalAfter(tokens: string[], index: number): string[] {
  const values: string[] = []
  let afterSeparator = false
  for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor]!
    if (token === "--") {
      afterSeparator = true
      continue
    }
    if (!afterSeparator && token.startsWith("-")) continue
    values.push(token)
  }
  return values
}

function gitExecutionDirectory(
  tokens: string[],
  gitIndex: number,
  subcommandIndex: number,
  initialDirectory: string | undefined,
): { directory?: string; reason?: string } {
  if (!initialDirectory) return { reason: "working directory before Git is unresolved" }
  let directory = initialDirectory
  for (let index = gitIndex + 1; index < subcommandIndex; index += 1) {
    const token = tokens[index]!
    let target: string | undefined
    if (token === "-C") {
      target = tokens[index + 1]
      index += 1
    } else if (token.startsWith("-C") && token.length > 2) {
      target = token.slice(2)
    }
    if (target === undefined) continue
    if (/[$`*?{}<>]/.test(target)) return { reason: "git -C contains unresolved shell expansion" }
    directory = resolve(directory, target)
  }
  return { directory }
}

function plannedActions(command: string, directory: string): PlannedGitActions {
  const result: PlannedGitActions = {
    relevant: false,
    commit: false,
    plannedAdd: [],
    discardTargets: [],
    removeTargets: [],
    commands: [],
  }
  const executionDirectories = new Set<string>()
  const directoryReasons = new Set<string>()

  for (const segment of shellCommandSegmentsWithDirectory(command, directory)) {
    const gitIndex = segment.tokens.findIndex((token) => basename(token) === "git")
    if (gitIndex < 0) continue
    const { command: subcommand, index } = gitSubcommand(segment.tokens, gitIndex)
    if (!subcommand) continue
    if (!["add", "commit", "checkout", "restore", "rm"].includes(subcommand)) continue
    const execution = gitExecutionDirectory(segment.tokens, gitIndex, index, segment.directory)
    if (execution.directory) executionDirectories.add(execution.directory)
    else
      directoryReasons.add(
        execution.reason ?? segment.directoryReason ?? "Git directory is unresolved",
      )
    result.relevant = true
    result.commands.push(subcommand)
    if (subcommand === "commit") result.commit = true
    if (subcommand === "add") result.plannedAdd.push(...positionalAfter(segment.tokens, index))
    if (subcommand === "rm") result.removeTargets.push(...positionalAfter(segment.tokens, index))
    if (subcommand === "checkout" || subcommand === "restore") {
      const separator = segment.tokens.indexOf("--", index + 1)
      if (separator >= 0) result.discardTargets.push(...segment.tokens.slice(separator + 1))
    }
  }
  if (executionDirectories.size === 1 && directoryReasons.size === 0) {
    result.executionDirectory = [...executionDirectories][0]!
  } else if (executionDirectories.size > 1) {
    result.directoryReason = "compound command targets multiple Git working directories"
  } else if (directoryReasons.size > 0) {
    result.directoryReason = [...directoryReasons].join("; ")
  }
  return result
}

function boundedList(values: string[], max = 200): { values: string[]; omitted: number } {
  return {
    values: values.slice(0, max),
    omitted: Math.max(0, values.length - max),
  }
}

/** Git inspection must never execute repository-configured extensions before
 *  the permission decision. Conversion filters (`clean`/`smudge`/`process`)
 *  and diff `textconv` drivers are shell commands from git config; disabling
 *  hooks, fsmonitor, and external diff is not enough because `git status` and
 *  `git diff` can invoke them on content comparison. Enumerate the configured
 *  keys (pure config reading, executes nothing) and override every one with a
 *  no-op so the evidence snapshot cannot run repo code.
 *
 *  Only the in-flight subprocess is shared per directory: concurrent snapshots
 *  reuse one scan so burst evidence collection does not multiply git
 *  processes, but the result is never reused across time — a repository whose
 *  config changed since the last verified scan must be re-verified, not
 *  inspected on stale assurance. A failed or over-limit scan fails closed: if
 *  the whole relevant config cannot be proven neutralized, the snapshot is
 *  withheld rather than risk running repo code. */
const MAX_NEUTRALIZED_FILTERS = 50
const MAX_NEUTRALIZED_DIFF_DRIVERS = 50
const inFlightFilterScans = new Map<string, Promise<string[]>>()

/** Filter/driver names may themselves contain dots (`filter.a.b.clean`), so
 *  keys are matched structurally (strip the section and the trailing property)
 *  instead of with a dot-free capture group. */
function collectConversionKeys(stdout: string): {
  filterNames: Set<string>
  diffDrivers: Set<string>
} {
  const filterNames = new Set<string>()
  const diffDrivers = new Set<string>()
  const filterProps = [".clean", ".smudge", ".process", ".required"]
  for (const line of stdout.split("\n")) {
    const key = line.split(/\s/, 1)[0]
    if (key === undefined) continue
    if (key.startsWith("filter.")) {
      const prop = filterProps.find((suffix) => key.endsWith(suffix))
      if (prop === undefined) continue
      const name = key.slice("filter.".length, key.length - prop.length)
      if (name.length > 0) filterNames.add(name)
      continue
    }
    if (key.startsWith("diff.") && key.endsWith(".textconv")) {
      const driver = key.slice("diff.".length, key.length - ".textconv".length)
      if (driver.length > 0) diffDrivers.add(driver)
    }
  }
  return { filterNames, diffDrivers }
}

function filterNeutralizationArgs(directory: string): Promise<string[]> {
  const existing = inFlightFilterScans.get(directory)
  if (existing !== undefined) return existing
  const scan = (async () => {
    try {
      const result = await execFileAsync("git", ["config", "--get-regexp", "^(filter|diff)\\."], {
        cwd: directory,
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
        env: gitInspectionEnv(),
      })
      const { filterNames, diffDrivers } = collectConversionKeys(result.stdout)
      if (filterNames.size > MAX_NEUTRALIZED_FILTERS) {
        // A resource limit must never degrade into "inspect while leaving the
        // remainder active": refuse the inspection instead.
        throw new Error(
          `repository configures ${filterNames.size} conversion filters (limit ${MAX_NEUTRALIZED_FILTERS}); refusing to inspect`,
        )
      }
      if (diffDrivers.size > MAX_NEUTRALIZED_DIFF_DRIVERS) {
        throw new Error(
          `repository configures ${diffDrivers.size} diff textconv drivers (limit ${MAX_NEUTRALIZED_DIFF_DRIVERS}); refusing to inspect`,
        )
      }
      const args: string[] = []
      for (const name of filterNames) {
        args.push(
          "-c",
          `filter.${name}.clean=cat`,
          "-c",
          `filter.${name}.smudge=cat`,
          "-c",
          `filter.${name}.process=`,
          "-c",
          `filter.${name}.required=false`,
        )
      }
      for (const driver of diffDrivers) {
        args.push("-c", `diff.${driver}.textconv=`)
      }
      return args
    } catch (error) {
      const record = error as { code?: unknown }
      // git config exits 1 when nothing matches: the common, benign case.
      if (record.code === 1) return []
      // Surface scan failures so the caller fails closed instead of
      // inspecting unverified.
      throw error instanceof Error ? error : new Error(String(error))
    } finally {
      inFlightFilterScans.delete(directory)
    }
  })()
  inFlightFilterScans.set(directory, scan)
  return scan
}

function gitInspectionEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    // Skip the system gitconfig too: it can define filters just like the
    // repository-local config can.
    GIT_CONFIG_NOSYSTEM: "1",
  }
}

async function runGit(
  directory: string,
  args: string[],
  neutralization: string[] = [],
): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  try {
    const result = await execFileAsync(
      "git",
      ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...neutralization, ...args],
      {
        cwd: directory,
        timeout: 2_000,
        maxBuffer: 512 * 1024,
        encoding: "utf8",
        env: gitInspectionEnv(),
      },
    )
    return { ok: true, stdout: result.stdout }
  } catch (error) {
    const record = error as {
      code?: unknown
      signal?: unknown
      stderr?: unknown
      message?: unknown
    }
    const reason =
      typeof record.stderr === "string" && record.stderr.trim()
        ? record.stderr.trim()
        : typeof record.message === "string"
          ? record.message
          : String(error)
    return { ok: false, reason: reason.slice(0, 1_000) }
  }
}

function parseStatus(stdout: string): {
  branch: string
  staged: string[]
  unstaged: string[]
  untracked: string[]
} {
  const lines = stdout.split(/\r?\n/).filter(Boolean)
  const branchLine = lines.find((line) => line.startsWith("## "))
  const branch = branchLine?.slice(3).split("...")[0]?.trim() || "<detached-or-unknown>"
  const staged: string[] = []
  const unstaged: string[] = []
  const untracked: string[] = []
  for (const line of lines) {
    if (line.startsWith("## ")) continue
    const x = line[0] ?? " "
    const y = line[1] ?? " "
    const path = line.slice(3)
    if (x === "?" && y === "?") {
      untracked.push(path)
      continue
    }
    if (x !== " ") staged.push(path)
    if (y !== " ") unstaged.push(path)
  }
  return { branch, staged, unstaged, untracked }
}

function unresolved(values: string[]): string[] {
  return values.filter((value) => /[$`*?{}<>]/.test(value))
}

export async function enrichGitEvidence(
  request: PermissionRequest,
  directory: string,
  maxChars: number,
): Promise<GitEnrichmentResult> {
  if (request.permission !== "bash") return { text: "" }
  const command = sourceCommand(request)
  const planned = plannedActions(command, directory)
  if (!planned.relevant) return { text: "" }
  if (!planned.executionDirectory) {
    return {
      text: `GIT_STATE_ANALYSIS\n${JSON.stringify(
        {
          status: "unavailable",
          reason: planned.directoryReason ?? "Git directory is unresolved",
          planned,
        },
        null,
        2,
      ).slice(0, maxChars)}`,
    }
  }
  const gitDirectory = planned.executionDirectory
  let neutralization: string[]
  try {
    neutralization = await filterNeutralizationArgs(gitDirectory)
  } catch (error) {
    // Fail closed: without a verified config we cannot prove the inspection
    // would not run repository-configured filters, so no snapshot is taken.
    const reason = `unable to verify git conversion filters before inspection (${error instanceof Error ? error.message : String(error)})`
    return {
      text: `GIT_STATE_ANALYSIS\n${JSON.stringify(
        { status: "unavailable", reason: reason.slice(0, 1_000), planned },
        null,
        2,
      ).slice(0, maxChars)}`,
    }
  }

  const [root, status] = await Promise.all([
    runGit(gitDirectory, ["rev-parse", "--show-toplevel"], neutralization),
    runGit(
      gitDirectory,
      ["status", "--porcelain=v1", "--branch", "--untracked-files=normal"],
      neutralization,
    ),
  ])
  if (!root.ok || !status.ok) {
    const reason = !root.ok ? root.reason : !status.ok ? status.reason : "unknown git error"
    return {
      text: `GIT_STATE_ANALYSIS\n${JSON.stringify(
        { status: "unavailable", reason, planned },
        null,
        2,
      ).slice(0, maxChars)}`,
    }
  }

  const parsed = parseStatus(status.stdout)
  const affectedTargets = [
    ...new Set([...planned.discardTargets, ...planned.removeTargets]),
  ].filter((value) => !/[$`*?{}<>]/.test(value))
  const targetDiff =
    affectedTargets.length === 0
      ? undefined
      : await runGit(
          gitDirectory,
          ["diff", "--numstat", "--no-ext-diff", "--", ...affectedTargets],
          neutralization,
        )

  const record = {
    status: "available",
    repositoryRoot: root.stdout.trim(),
    branch: parsed.branch,
    plannedCommands: planned.commands,
    commitRequested: planned.commit,
    plannedAdd: boundedList(planned.plannedAdd),
    preexistingStaged: boundedList(parsed.staged),
    unstaged: boundedList(parsed.unstaged),
    untracked: boundedList(parsed.untracked),
    discardTargets: boundedList(planned.discardTargets),
    removeTargets: boundedList(planned.removeTargets),
    unresolvedPlannedPaths: boundedList(
      unresolved([...planned.plannedAdd, ...planned.discardTargets, ...planned.removeTargets]),
    ),
    ...(targetDiff === undefined
      ? {}
      : targetDiff.ok
        ? { affectedTargetNumstat: targetDiff.stdout.slice(0, 8_000) || "<no unstaged diff>" }
        : { affectedTargetNumstat: `<unavailable: ${targetDiff.reason}>` }),
  }
  const serialized = JSON.stringify(record, null, 2)
  const bounded =
    serialized.length <= maxChars
      ? serialized
      : `${serialized.slice(0, maxChars)}\n<git_enrichment_truncated characters="${serialized.length - maxChars}" />`
  return { text: `GIT_STATE_ANALYSIS\n${bounded}` }
}
