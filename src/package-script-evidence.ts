import { basename, dirname, join, resolve } from "node:path"
import { lstat, realpath, stat } from "node:fs/promises"
import type { PermissionRequest } from "./types.ts"
import { sourceCommand } from "./evidence/source-command.ts"
import { includeEvidenceFile, shellCommandSegmentsWithDirectory } from "./ssh-evidence.ts"
import { enrichLocalScriptEvidence } from "./local-script-evidence.ts"
import { effectiveCommands } from "./shell-lexer.ts"

const MANAGERS = new Set(["bun", "npm", "pnpm", "yarn"])
const MAX_SCRIPT_DEPTH = 4
const MAX_SCRIPT_RECORDS = 16

interface ScriptInvocation {
  manager: string
  script: string
  arguments: string[]
  unresolved?: string
}

interface ScriptRecord {
  manager: string
  script: string
  directory?: string
  manifest?: string
  phase?: string
  command?: string
  arguments?: string[]
  status: "included" | "unavailable" | "blocked" | "truncated" | "cycle"
  reason?: string
  referencedCode?: string
}

interface ManifestEvidence {
  path: string
  scripts?: Record<string, unknown>
  reason?: string
  status: ScriptRecord["status"]
}

function invocation(tokens: string[]): ScriptInvocation | undefined {
  const manager = basename(tokens[0] ?? "")
  if (!MANAGERS.has(manager)) return
  let cursor = 1
  let ambiguous = false
  const skipOptions = () => {
    while (tokens[cursor]?.startsWith("-")) {
      const option = tokens[cursor++]!
      if (/^(?:--(?:cwd|prefix|workspace|workspaces|filter)|-F|-C)(?:=|$)/.test(option))
        ambiguous = true
      if (["--cwd", "--prefix", "--workspace", "--filter", "-F", "-C"].includes(option)) cursor++
    }
  }
  skipOptions()
  const subcommand = tokens[cursor]
  if (manager === "bun" && subcommand !== "run") return
  if (subcommand === "run" || subcommand === "run-script") {
    cursor++
    skipOptions()
  }
  const script =
    subcommand === "run" || subcommand === "run-script"
      ? tokens[cursor]
      : ["test", "start", "stop", "restart"].includes(subcommand ?? "")
        ? subcommand
        : undefined
  if (
    !script ||
    script.startsWith("-") ||
    /[/$`*?{}<>]/.test(script) ||
    /\.[cm]?[jt]sx?$/.test(script)
  )
    return
  return {
    manager,
    script,
    arguments: tokens.slice(cursor + 1),
    ...(ambiguous
      ? { unresolved: "runtime directory or workspace selection is not resolved" }
      : {}),
  }
}

/** The directory the host runs the shell command in. A relative workdir resolves
 *  against the session directory, as the host does. Another workdir is followed to
 *  its real path, because package managers search parent manifests physically. A
 *  workdir that is not an existing directory is undefined, so another directory's
 *  manifest is never reported as the target. */
async function shellWorkdir(
  request: PermissionRequest,
  directory: string,
): Promise<string | undefined> {
  const input = request.metadata.toolInput
  if (typeof input !== "object" || input === null || Array.isArray(input)) return directory
  const workdir = (input as Record<string, unknown>).workdir
  if (workdir === undefined || (typeof workdir === "string" && workdir.trim() === ""))
    return directory
  if (typeof workdir !== "string" || workdir.includes("\0")) return
  const resolved = resolve(directory, workdir)
  if (resolved === resolve(directory)) return directory
  try {
    const real = await realpath(resolved)
    return (await stat(real)).isDirectory() ? real : undefined
  } catch {
    return
  }
}

/** Read manifest definitions and literal local calls; never execute package code. */
export async function enrichPackageScriptEvidence(
  request: PermissionRequest,
  directory: string,
  worktree: string,
  maxChars: number,
): Promise<{ text: string }> {
  if (request.permission !== "bash") return { text: "" }
  const records: ScriptRecord[] = []
  const active = new Set<string>()
  const calls = (tokens: string[]) => {
    const managerIndex = tokens.findIndex((token) => MANAGERS.has(basename(token)))
    const prefix = managerIndex < 0 ? tokens : tokens.slice(0, managerIndex)
    if (
      prefix.some((token) =>
        [
          "ssh",
          "chroot",
          "docker",
          "podman",
          "kubectl",
          "nsenter",
          "sudo",
          "su",
          "runuser",
          "systemd-run",
        ].includes(basename(token)),
      )
    )
      return []
    const redirected = prefix.some((token) => token === "-C" || token.startsWith("--chdir"))
    const commands = effectiveCommands({
      tokens: tokens.map((value) => ({ raw: value, value })),
    }).map((command) => command.map((token) => token.value))
    const changesDirectory =
      redirected || commands.some((command) => ["cd", "pushd", "popd"].includes(command[0] ?? ""))
    return commands.flatMap((command) => {
      const call = invocation(command)
      return call
        ? [
            {
              ...call,
              ...(changesDirectory
                ? { unresolved: "wrapped script working directory is unresolved" }
                : {}),
            },
          ]
        : []
    })
  }
  const manifests = new Map<string, Promise<ManifestEvidence>>()
  const manifest = (cwd: string): Promise<ManifestEvidence> => {
    const existing = manifests.get(cwd)
    if (existing) return existing
    const pending = (async (): Promise<ManifestEvidence> => {
      let cursor = cwd
      for (let depth = 0; depth < 8; depth++) {
        const path = join(cursor, "package.json")
        const exists = await lstat(path)
          .then(() => true)
          .catch(() => false)
        if (exists) {
          const file = await includeEvidenceFile(
            path,
            cwd,
            directory,
            worktree,
            Math.min(64_000, Math.max(maxChars, 8_000)),
          )
          if (file.status !== "included" || file.content === undefined)
            return {
              path,
              status: file.status,
              reason: file.reason ?? "manifest content was not fully available",
            }
          try {
            const json: unknown = JSON.parse(file.content)
            const scripts =
              typeof json === "object" && json !== null && "scripts" in json
                ? json.scripts
                : undefined
            return {
              path,
              status: "included" as const,
              ...(typeof scripts === "object" && scripts !== null && !Array.isArray(scripts)
                ? { scripts: scripts as Record<string, unknown> }
                : {}),
            }
          } catch {
            return { path, status: "unavailable" as const, reason: "manifest is not valid JSON" }
          }
        }
        const parent = dirname(cursor)
        if (parent === cursor) break
        cursor = parent
      }
      return {
        path: join(cwd, "package.json"),
        status: "unavailable" as const,
        reason: "no manifest found in the bounded parent search",
      }
    })()
    manifests.set(cwd, pending)
    return pending
  }
  const visit = async (
    call: ScriptInvocation,
    cwd: string | undefined,
    depth: number,
    phase = "requested",
  ) => {
    if (records.length >= MAX_SCRIPT_RECORDS) return
    const base = { manager: call.manager, script: call.script, arguments: call.arguments, phase }
    if (cwd === undefined || call.unresolved) {
      records.push({
        ...base,
        status: "unavailable",
        reason: call.unresolved ?? "script working directory is unresolved",
      })
      return
    }
    const pkg = await manifest(cwd)
    if (
      !pkg.scripts ||
      !Object.hasOwn(pkg.scripts, call.script) ||
      typeof pkg.scripts[call.script] !== "string"
    ) {
      records.push({
        ...base,
        directory: cwd,
        manifest: pkg.path,
        status: pkg.status === "included" ? "unavailable" : pkg.status,
        reason: pkg.reason ?? "requested manifest script is not defined",
      })
      return
    }
    const key = `${pkg.path}\0${call.script}`
    if (active.has(key) || depth > MAX_SCRIPT_DEPTH) {
      records.push({
        ...base,
        directory: cwd,
        manifest: pkg.path,
        status: active.has(key) ? "cycle" : "truncated",
        reason: "script expansion reached a cycle or depth limit",
      })
      return
    }
    active.add(key)
    const command = pkg.scripts[call.script] as string
    const pkgDirectory = dirname(pkg.path)
    const record: ScriptRecord = {
      ...base,
      directory: pkgDirectory,
      manifest: pkg.path,
      command,
      status: "included",
    }
    records.push(record)
    // Defined lifecycle hooks are evidence of possible execution, not a claim
    // that runtime flags or configuration necessarily enable them.
    if (phase === "requested") {
      for (const prefix of ["pre", "post"]) {
        const name = prefix + call.script
        if (Object.hasOwn(pkg.scripts, name))
          await visit(
            { manager: call.manager, script: name, arguments: [] },
            pkgDirectory,
            depth + 1,
            `conditional-${prefix}`,
          )
      }
    }
    if (records.length < MAX_SCRIPT_RECORDS) {
      const local = await enrichLocalScriptEvidence(
        { ...request, metadata: { command }, patterns: [command] },
        pkgDirectory,
        worktree,
        Math.min(maxChars, 8_000),
      )
      if (local.text) record.referencedCode = local.text
      for (const segment of shellCommandSegmentsWithDirectory(command, pkgDirectory)) {
        for (const child of calls(segment.tokens)) await visit(child, segment.directory, depth + 1)
      }
    }
    active.delete(key)
  }
  // The workdir only selects the starting manifest; reads stay within the approved roots.
  const workdir = await shellWorkdir(request, directory)
  for (const segment of shellCommandSegmentsWithDirectory(
    sourceCommand(request),
    workdir ?? directory,
  )) {
    for (const call of calls(segment.tokens))
      await visit(call, workdir === undefined ? undefined : segment.directory, 0)
  }
  if (records.length === 0) return { text: "" }
  const serialize = () =>
    JSON.stringify(
      {
        coverage:
          "manifest definitions and literal local calls only; imported code and runtime configuration may add effects",
        status:
          records.length >= MAX_SCRIPT_RECORDS ||
          records.some((record) => record.status !== "included")
            ? "partial"
            : "included",
        ...(records.length >= MAX_SCRIPT_RECORDS ? { expansionLimitReached: true } : {}),
        records,
      },
      null,
      2,
    )
  let text = serialize()
  // Drop whole records before shortening a record, retaining explicit gaps.
  while (text.length > maxChars && records.length > 1) {
    records.pop()
    records[0]!.status = "truncated"
    records[0]!.reason = "additional script evidence exceeded the character budget"
    text = serialize()
  }
  if (text.length > maxChars) {
    const first = records[0]!
    delete first.referencedCode
    if (first.command !== undefined)
      first.command = first.command.slice(0, Math.max(0, maxChars - 1_000))
    first.status = "truncated"
    first.reason = "script evidence exceeded the character budget"
    text = serialize()
  }
  if (text.length > maxChars)
    text = JSON.stringify({
      status: "truncated",
      reason: "script evidence exceeded the character budget",
    })
  return { text: `PACKAGE_SCRIPT_ANALYSIS\n${text}` }
}
