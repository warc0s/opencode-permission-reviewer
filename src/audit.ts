import { appendFile, mkdir } from "node:fs/promises"
import { closeSync, openSync, readSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"
import type { ReviewAuditRecord, ReviewerConfig } from "./types.ts"
import { redactSecrets } from "./redact.ts"

export const DEFAULT_AUDIT_PATH = "~/.local/share/opencode/permission-reviewer-audit.jsonl"

export function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2))
  return resolve(path)
}

/** Resolve the audit path the way the writer does. */
export function resolveAuditPath(config: ReviewerConfig): string {
  return expandHome(config.auditPath ?? DEFAULT_AUDIT_PATH)
}

/** The required identity/decision fields every audit record must carry. Used
 *  by the report reader to flag truncated or malformed lines. */
const REQUIRED_AUDIT_FIELDS = [
  "timestamp",
  "requestID",
  "sessionID",
  "permission",
  "outcome",
  "reason",
] as const

export interface AuditMissingFields {
  lineNo: number
  missing: string[]
}

export interface AuditSummary {
  path: string
  exists: boolean
  /** True when only the bounded tail (most recent 64 MiB) was summarized:
   *  line counts and timestamps then describe that window, not the file. */
  truncated: boolean
  totalLines: number
  validRecords: number
  invalidLines: number
  bySchemaVersion: Record<string, number>
  byOutcome: Record<string, number>
  byRiskLevel: Record<string, number>
  byDecisionSource: Record<string, number>
  byPermission: Record<string, number>
  unknownActorNames: Array<{ name: string; count: number }>
  missingRequiredFields: AuditMissingFields[]
  firstTimestamp?: string
  lastTimestamp?: string
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1
}

/** Cap on how much of an audit file the summary reader will pull into memory:
 *  the file is append-only and grows without bound, and the report only needs
 *  the most recent records. When the cap is hit the reader summarizes the tail
 *  (newest records) and flags the truncation. */
const AUDIT_READ_CAP_BYTES = 64 * 1024 * 1024

/** Read the (bounded) tail of an audit file synchronously without loading the
 *  whole file. Never throws: any failure to stat/open/read returns undefined
 *  and the caller reports the file as unreadable. */
function readTail(path: string): { text: string; truncated: boolean } | undefined {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return undefined
  }
  const truncated = size > AUDIT_READ_CAP_BYTES
  const length = truncated ? AUDIT_READ_CAP_BYTES : size
  let fd: number | undefined
  try {
    fd = openSync(path, "r")
    const buffer = Buffer.alloc(length)
    const offset = truncated ? size - length : 0
    readSync(fd, buffer, 0, length, offset)
    let text = buffer.toString("utf8")
    if (truncated) {
      // Drop a possibly partial first line so every summarized line is whole.
      text = text.replace(/^[^\n]*\n/, "")
    }
    return { text, truncated }
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSyncSafe(fd)
  }
}

function closeSyncSafe(fd: number): void {
  try {
    closeSync(fd)
  } catch {
    // Best effort; the read already succeeded or failed on its own.
  }
}

/** Read an append-only JSONL audit file and summarize it. Never throws: a
 *  missing/unreadable file returns an empty summary with `exists: false`, and
 *  malformed records (wrong shapes, null actors, bad JSON) are counted as
 *  invalid lines instead of aborting the report. */
export function readAuditSummary(path: string): AuditSummary {
  const summary: AuditSummary = {
    path,
    exists: false,
    truncated: false,
    totalLines: 0,
    validRecords: 0,
    invalidLines: 0,
    bySchemaVersion: {},
    byOutcome: {},
    byRiskLevel: {},
    byDecisionSource: {},
    byPermission: {},
    unknownActorNames: [],
    missingRequiredFields: [],
  }
  const read = readTail(path)
  if (read === undefined) return summary
  summary.exists = true
  summary.truncated = read.truncated
  const lines = read.text.split("\n").filter((line) => line.trim().length > 0)
  // When the cap was hit only the tail was read; line counts then describe
  // the summarized window, not the whole file.
  summary.totalLines = lines.length
  const actorCounts = new Map<string, number>()
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    let parsed: unknown
    try {
      parsed = JSON.parse(lines[i]!)
    } catch {
      summary.invalidLines++
      continue
    }
    // A bare primitive or null/array is not an audit record; count it as an
    // invalid line instead of throwing on the property accesses below.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      summary.invalidLines++
      continue
    }
    const record = parsed as Record<string, unknown>
    summary.validRecords++
    bump(summary.bySchemaVersion, String(record.schemaVersion ?? 1))
    if (typeof record.outcome === "string") bump(summary.byOutcome, record.outcome)
    bump(summary.byRiskLevel, typeof record.riskLevel === "string" ? record.riskLevel : "(none)")
    if (typeof record.decisionSource === "string")
      bump(summary.byDecisionSource, record.decisionSource)
    if (typeof record.permission === "string") bump(summary.byPermission, record.permission)
    if (typeof record.timestamp === "string") {
      if (summary.firstTimestamp === undefined || record.timestamp < summary.firstTimestamp) {
        summary.firstTimestamp = record.timestamp
      }
      if (summary.lastTimestamp === undefined || record.timestamp > summary.lastTimestamp) {
        summary.lastTimestamp = record.timestamp
      }
    }
    const missing = REQUIRED_AUDIT_FIELDS.filter((f) => record[f] === undefined)
    if (missing.length > 0) summary.missingRequiredFields.push({ lineNo, missing })
    const actor =
      typeof record.actor === "object" && record.actor !== null
        ? (record.actor as { name?: string; profile?: string })
        : undefined
    const isUnknown =
      actor === undefined ||
      actor.profile === undefined ||
      actor.profile === "unknown" ||
      actor.name === undefined ||
      actor.name === ""
    if (isUnknown) {
      const rawName = actor?.name ?? (record.actor === undefined ? "(no actor field)" : "(unnamed)")
      // A hostile or corrupted record can put anything in `name`; coerce to a
      // string before it reaches the localeCompare below.
      const name = typeof rawName === "string" ? rawName : JSON.stringify(rawName)
      actorCounts.set(name, (actorCounts.get(name) ?? 0) + 1)
    }
  }
  summary.unknownActorNames = [...actorCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return summary
}

function boundedReason(reason: string): string {
  const normalized = reason.replace(/[\r\n]+/g, " ").trim()
  return normalized.length <= 2_000 ? normalized : `${normalized.slice(0, 2_000)}…`
}

export function createAuditWriter(
  config: ReviewerConfig,
  logger?: (message: string, details?: unknown) => void,
): ((record: ReviewAuditRecord) => Promise<void>) | undefined {
  if (!config.audit) return
  const path = expandHome(config.auditPath ?? DEFAULT_AUDIT_PATH)
  let ready: Promise<void> | undefined
  return async (record) => {
    ready ??= mkdir(dirname(path), { recursive: true }).then(() => {})
    await ready
    // Redact the free-text fields (the reason carries transport error messages
    // and provider responses that never passed through the evidence
    // pipeline's redaction). Structural identifiers are left intact: running
    // the redactor over the whole serialized line would also match key names
    // like "sessionID" and corrupt the record's correlation fields.
    const sanitized: ReviewAuditRecord = {
      ...record,
      reason: redactSecrets(boundedReason(record.reason)),
      ...(record.warnings === undefined
        ? {}
        : { warnings: record.warnings.map((warning) => redactSecrets(warning)) }),
      ...(record.policyTrace === undefined
        ? {}
        : {
            policyTrace: {
              ...record.policyTrace,
              // Rule reasons are admin-authored prose; redact them like any
              // other free text without touching the structural fields.
              matchedRules: record.policyTrace.matchedRules.map((match) => ({
                ...match,
                reason: redactSecrets(match.reason),
              })),
            },
          }),
      ...(record.askDecisions === undefined
        ? {}
        : {
            askDecisions: record.askDecisions.map((decision) => ({
              ...decision,
              question: redactSecrets(decision.question),
              answer: redactSecrets(decision.answer),
            })),
          }),
    }
    await appendFile(path, `${JSON.stringify(sanitized)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    }).catch((error) => {
      logger?.("failed to append audit record", {
        path,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }
}
