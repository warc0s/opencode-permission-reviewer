import type {
  ActorProfile,
  EscalationDisposition,
  PermissionRequest,
  ReviewDecision,
} from "./types.ts"

export const UI_COMMAND_PREFIX = "opencode-permission-reviewer.status."
// Time to wait for the server's first "reviewing" ack after permission.asked.
// Short enough to surface a broken publish path, long enough to survive a busy
// event bus without flipping the panel to "manual" before the review starts.
export const UI_START_GRACE_MS = 15_000
export const UI_WATCHDOG_GRACE_MS = 5_000

export type ReviewUiPhase = "reviewing" | "approved" | "denied" | "manual" | "unknown"

export interface ReviewUiStatus {
  version: 1
  requestID: string
  sessionID: string
  phase: ReviewUiPhase
  permission: string
  action: string
  model: string
  variant: string
  emittedAt: number
  timeoutMs: number
  reason?: string
  decision?: ReviewDecision
  /**
   * When phase is `denied` and this is `"deny"`, the block came from fail-closed
   * escalation disposition rather than an explicit reviewer/policy deny.
   */
  escalationDisposition?: EscalationDisposition
  /** Resolved actor (absent on the initial "reviewing" phase, before context
   *  collection completes). */
  actorName?: string
  actorProfile?: ActorProfile
}

function boundedText(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim()
  if (compact.length <= max) return compact
  return `${compact.slice(0, Math.max(0, max - 1))}…`
}

export function permissionAction(request: PermissionRequest): string {
  const metadata = request.metadata
  const candidates = [
    metadata.command,
    metadata.filepath,
    metadata.url,
    metadata.query,
    metadata.path,
    request.patterns.join(", "),
  ]
  const detail = candidates.find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  )
  const prefix = request.permission === "bash" && detail ? "$ " : ""
  return boundedText(`${prefix}${detail ?? request.permission}`, 500)
}

export function createUiStatus(
  request: PermissionRequest,
  phase: ReviewUiPhase,
  options: {
    model: string
    variant: string
    timeoutMs: number
    reason?: string
    decision?: ReviewDecision
    escalationDisposition?: EscalationDisposition
    emittedAt?: number
    actorName?: string
    actorProfile?: ActorProfile
  },
): ReviewUiStatus {
  return {
    version: 1,
    requestID: request.id,
    sessionID: request.sessionID,
    phase,
    permission: request.permission,
    action: permissionAction(request),
    model: boundedText(options.model, 200),
    variant: boundedText(options.variant, 100),
    emittedAt: options.emittedAt ?? Date.now(),
    timeoutMs: options.timeoutMs,
    ...(options.reason === undefined ? {} : { reason: boundedText(options.reason, 2_000) }),
    ...(options.decision === undefined ? {} : { decision: options.decision }),
    ...(options.escalationDisposition === undefined
      ? {}
      : { escalationDisposition: options.escalationDisposition }),
    ...(options.actorName === undefined ? {} : { actorName: boundedText(options.actorName, 100) }),
    ...(options.actorProfile === undefined ? {} : { actorProfile: options.actorProfile }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isDecision(value: unknown): value is ReviewDecision {
  if (!isRecord(value)) return false
  return (
    (value.outcome === "allow" || value.outcome === "deny" || value.outcome === "escalate") &&
    (value.risk_level === "low" ||
      value.risk_level === "medium" ||
      value.risk_level === "high" ||
      value.risk_level === "critical") &&
    (value.user_authorization === "high" ||
      value.user_authorization === "medium" ||
      value.user_authorization === "low" ||
      value.user_authorization === "unknown") &&
    typeof value.rationale === "string" &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1
  )
}

export function parseUiStatus(value: unknown): ReviewUiStatus | undefined {
  if (!isRecord(value) || value.version !== 1) return
  if (typeof value.requestID !== "string" || typeof value.sessionID !== "string") return
  if (
    value.phase !== "reviewing" &&
    value.phase !== "approved" &&
    value.phase !== "denied" &&
    value.phase !== "manual" &&
    value.phase !== "unknown"
  ) {
    return
  }
  if (typeof value.permission !== "string" || typeof value.action !== "string") return
  if (typeof value.model !== "string" || typeof value.variant !== "string") return
  if (typeof value.emittedAt !== "number" || !Number.isFinite(value.emittedAt)) return
  if (
    typeof value.timeoutMs !== "number" ||
    !Number.isFinite(value.timeoutMs) ||
    value.timeoutMs < 0
  )
    return
  if (value.reason !== undefined && typeof value.reason !== "string") return
  if (value.decision !== undefined && !isDecision(value.decision)) return
  if (
    value.escalationDisposition !== undefined &&
    value.escalationDisposition !== "manual" &&
    value.escalationDisposition !== "deny"
  ) {
    return
  }
  if (value.actorName !== undefined && typeof value.actorName !== "string") return
  if (
    value.actorProfile !== undefined &&
    value.actorProfile !== "read-only" &&
    value.actorProfile !== "validation" &&
    value.actorProfile !== "workspace" &&
    value.actorProfile !== "operator" &&
    value.actorProfile !== "reviewer" &&
    value.actorProfile !== "unknown"
  ) {
    return
  }

  return value as unknown as ReviewUiStatus
}

export function encodeUiStatus(status: ReviewUiStatus): string {
  return `${UI_COMMAND_PREFIX}${Buffer.from(JSON.stringify(status), "utf8").toString("base64url")}`
}

export function decodeUiStatus(command: string): ReviewUiStatus | undefined {
  if (!command.startsWith(UI_COMMAND_PREFIX)) return
  const encoded = command.slice(UI_COMMAND_PREFIX.length)
  if (!encoded || encoded.length > 16_000) return
  try {
    return parseUiStatus(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")))
  } catch {
    return
  }
}
