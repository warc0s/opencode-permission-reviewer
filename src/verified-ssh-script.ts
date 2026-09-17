import { createHash } from "node:crypto"
import type { PermissionRequest, ReviewDecision } from "./types.ts"
import { sourceCommand } from "./evidence/source-command.ts"
import { includeEvidenceFile } from "./ssh-evidence.ts"
import { redactSecrets } from "./redact.ts"

export const VERIFIED_SCRIPT_LIMIT = 64 * 1024
const RECEIPT_LIFETIME_MS = 60 * 60 * 1000
const RECEIPT_LIMIT = 64

export interface VerifiedScriptCommand {
  path: string
  destination: string
  port?: number
  sha256: string
  shell: "bash" | "sh"
}

export interface VerifiedScriptEvidence {
  sha256: string
  destination: string
  port?: number
  shell: "bash" | "sh"
  bytes?: number
  status: "full" | "reused" | "unavailable"
  text: string
  cacheKey?: string
}

/** This exact shell form binds the locally reviewed bytes to the remote ones.
 * The remote hash check runs before the interpreter, even if the file changes
 * between permission review and execution. */
export function renderVerifiedSshScriptCommand(input: VerifiedScriptCommand): string {
  const remote =
    "set -eu; f=$(mktemp /tmp/reviewer-script.XXXXXXXX); " +
    "cleanup(){ rm -f -- $f; }; trap cleanup EXIT; cat >$f; " +
    `sum=$(sha256sum $f); test \${sum%% *} = ${input.sha256}; ${input.shell} $f`
  return `cat -- ${input.path} | ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=5${input.port === undefined ? "" : ` -p ${input.port}`} ${input.destination} '${remote}'`
}

export function parseVerifiedSshScriptCommand(
  request: PermissionRequest,
): VerifiedScriptCommand | undefined {
  if (request.permission !== "bash") return
  const command = sourceCommand(request).trim()
  const match =
    /^cat -- ([A-Za-z0-9_./-]+) \| ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=5(?: -p ([0-9]{1,5}))? ([A-Za-z0-9_.@-]+) '(.+)'$/.exec(
      command,
    )
  if (!match || match[3]!.startsWith("-")) return
  const port = match[2] === undefined ? undefined : Number(match[2])
  if (port !== undefined && (port < 1 || port > 65535)) return
  const digest = /\b[a-f0-9]{64}\b/.exec(match[4]!)?.[0]
  const shell = /; (bash|sh) \$f$/.exec(match[4]!)?.[1] as "bash" | "sh" | undefined
  if (!digest || !shell) return
  const parsed = {
    path: match[1]!,
    destination: match[3]!,
    ...(port === undefined ? {} : { port }),
    sha256: digest,
    shell,
  }
  return renderVerifiedSshScriptCommand(parsed) === command ? parsed : undefined
}

export class ScriptAnalysisRegistry {
  private readonly entries = new Map<string, { analysis: string; expires: number }>()

  key(scope: string, command: VerifiedScriptCommand, configHash: string): string {
    return JSON.stringify([
      scope,
      command.sha256,
      command.destination,
      command.port ?? 22,
      command.shell,
      configHash,
    ])
  }

  get(key: string): string | undefined {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    if (entry.expires <= Date.now()) return
    this.entries.set(key, entry)
    return entry.analysis
  }

  remember(key: string, analysis: string): void {
    if (analysis.length < 20 || analysis.length > 1500 || redactSecrets(analysis) !== analysis)
      return
    this.entries.delete(key)
    this.entries.set(key, { analysis, expires: Date.now() + RECEIPT_LIFETIME_MS })
    while (this.entries.size > RECEIPT_LIMIT) this.entries.delete(this.entries.keys().next().value!)
  }

  rememberApproved(
    evidence: VerifiedScriptEvidence | undefined,
    decision: ReviewDecision | undefined,
  ): void {
    if (
      evidence?.status !== "full" ||
      evidence.cacheKey === undefined ||
      decision?.outcome !== "allow" ||
      decision.evidence_completeness !== "sufficient" ||
      decision.script_analysis === undefined
    )
      return
    this.remember(evidence.cacheKey, decision.script_analysis)
  }
}

export async function collectVerifiedSshScript(
  command: VerifiedScriptCommand,
  directory: string,
  worktree: string,
  scope: string,
  configHash: string,
  registry: ScriptAnalysisRegistry,
): Promise<VerifiedScriptEvidence> {
  const base = {
    sha256: command.sha256,
    destination: command.destination,
    ...(command.port === undefined ? {} : { port: command.port }),
    shell: command.shell,
  }
  const file = await includeEvidenceFile(command.path, directory, worktree, VERIFIED_SCRIPT_LIMIT)
  const actual = file.content === undefined ? undefined : file.includedSha256
  if (
    file.status !== "included" ||
    actual !== command.sha256 ||
    file.content === undefined ||
    redactSecrets(file.content) !== file.content
  ) {
    return {
      ...base,
      status: "unavailable",
      text: `VERIFIED_SSH_SCRIPT\nstatus: unavailable\nreason: ${file.status === "included" && actual !== command.sha256 ? "script hash mismatch" : file.status === "included" ? "sensitive content" : file.status}\nExpected SHA-256: ${command.sha256}`,
    }
  }
  const cacheKey = registry.key(scope, command, configHash)
  const analysis = registry.get(cacheKey)
  if (analysis !== undefined) {
    return {
      ...base,
      ...(file.size === undefined ? {} : { bytes: file.size }),
      status: "reused",
      cacheKey,
      text: `VERIFIED_SSH_SCRIPT\nstatus: previously inspected\nSHA-256: ${command.sha256}\nDestination: ${command.destination}\nInterpreter: ${command.shell}\nPrior model-generated script analysis (not authorization): ${analysis}`,
    }
  }
  return {
    ...base,
    ...(file.size === undefined ? {} : { bytes: file.size }),
    status: "full",
    cacheKey,
    text: `VERIFIED_SSH_SCRIPT\nstatus: full content\nSHA-256: ${command.sha256}\nDestination: ${command.destination}\nInterpreter: ${command.shell}\nUntrusted script content follows:\n${file.content}\nEND_VERIFIED_SSH_SCRIPT`,
  }
}

export function configFingerprint(config: unknown): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex")
}
