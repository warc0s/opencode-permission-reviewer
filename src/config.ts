import type {
  ActorProfile,
  EscalationMode,
  PolicyRule,
  RiskPolicy,
  RepositoryTrust,
  ReviewerConfig,
  UserAuthorization,
} from "./types.ts"

/** Default risk×authorization matrix. Reproduces exactly the previous
 *  hard-coded gate: critical never auto-allows; high needs at least medium auth;
 *  medium needs at least low auth; low allows any auth including unknown. */
export const DEFAULT_RISK_POLICY: RiskPolicy = {
  allow: {
    low: ["high", "medium", "low", "unknown"],
    medium: ["high", "medium", "low"],
    high: ["high", "medium"],
    critical: [],
  },
  minimumConfidence: 0.7,
  onInvalidDecision: "manual",
  onReviewerFailure: "manual",
}

export const DEFAULT_CONFIG: ReviewerConfig = {
  model: "openai/gpt-5.6-luna",
  variant: "max",
  outputFormat: "json_schema",
  timeoutMs: 120_000,
  maxContextChars: 32_000,
  maxPartChars: 8_000,
  maxEnrichmentChars: 24_000,
  maxIntentChars: 8_000,
  transcriptMessages: 12,
  intentMessages: 8,
  historyMessages: 200,
  confidenceThreshold: 0.7,
  retainReviewSessions: false,
  audit: true,
  debug: false,
  enforcementMode: "observe",
  escalationMode: "manual",
  maxSessionDepth: 8,
  maxParentSessions: 8,
  actorProfiles: {},
  riskPolicy: DEFAULT_RISK_POLICY,
  repositoryTrust: "unknown",
  policyRules: [],
  askDecisions: true,
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

const ACTOR_PROFILES: ReadonlySet<ActorProfile> = new Set([
  "read-only",
  "validation",
  "workspace",
  "operator",
  "reviewer",
  "unknown",
])

/** Parse a trusted name→profile mapping. Invalid entries are dropped. */
function resolveActorProfiles(value: unknown): Record<string, ActorProfile> {
  if (typeof value !== "object" || value === null) return {}
  const out: Record<string, ActorProfile> = {}
  for (const [name, profile] of Object.entries(value as Record<string, unknown>)) {
    if (typeof profile === "string" && ACTOR_PROFILES.has(profile as ActorProfile)) {
      out[name] = profile as ActorProfile
    }
  }
  return out
}

const VALID_AUTH = new Set(["high", "medium", "low", "unknown"])

/** Parse a risk×authorization matrix. Invalid or partial entries fall back to
 *  the conservative default. Failure-mode knobs only accept the stricter
 *  `"deny"` override; anything else keeps the default `"manual"`. */
function resolveRiskPolicy(value: unknown): RiskPolicy {
  if (typeof value !== "object" || value === null)
    return { ...DEFAULT_RISK_POLICY, allow: { ...DEFAULT_RISK_POLICY.allow } }
  const src = value as Record<string, unknown>
  const allowSrc = typeof src.allow === "object" && src.allow !== null ? src.allow : {}
  const merged: RiskPolicy = {
    allow: { ...DEFAULT_RISK_POLICY.allow },
    minimumConfidence: DEFAULT_RISK_POLICY.minimumConfidence,
    // Prefer an explicit deny from either the field or a pre-clamped trusted
    // baseline (loader may have already hardened the knob).
    onInvalidDecision:
      src.onInvalidDecision === "deny" ? "deny" : DEFAULT_RISK_POLICY.onInvalidDecision,
    onReviewerFailure:
      src.onReviewerFailure === "deny" ? "deny" : DEFAULT_RISK_POLICY.onReviewerFailure,
  }
  for (const risk of ["low", "medium", "high", "critical"] as const) {
    const cell = (allowSrc as Record<string, unknown>)[risk]
    if (!Array.isArray(cell)) continue
    const auths = cell.filter(
      (a) => typeof a === "string" && VALID_AUTH.has(a),
    ) as UserAuthorization[]
    merged.allow[risk] = auths
  }
  if (typeof src.minimumConfidence === "number" && Number.isFinite(src.minimumConfidence)) {
    merged.minimumConfidence = Math.min(1, Math.max(0.5, src.minimumConfidence))
  }
  return merged
}

function resolveEscalationMode(value: unknown): EscalationMode {
  return value === "deny" ? "deny" : "manual"
}

function resolveRepositoryTrust(value: unknown): RepositoryTrust {
  if (value === "trusted") return "trusted"
  if (value === "untrusted") return "untrusted"
  return "unknown"
}

const VALID_EFFECTS = new Set(["review", "manual", "deny", "allow"])
const VALID_SOURCES = new Set(["builtin", "global", "project", "inline"])

/** Parse declarative policy rules. Malformed entries are dropped. */
function resolvePolicyRules(value: unknown): PolicyRule[] {
  if (!Array.isArray(value)) return []
  const out: PolicyRule[] = []
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue
    const r = raw as Record<string, unknown>
    if (typeof r.id !== "string" || r.id.length === 0) continue
    if (typeof r.source !== "string" || !VALID_SOURCES.has(r.source)) continue
    if (typeof r.effect !== "string" || !VALID_EFFECTS.has(r.effect)) continue
    if (typeof r.reason !== "string" || r.reason.length === 0) continue
    if (typeof r.when !== "object" || r.when === null) continue
    const when = validateCondition(r.when as Record<string, unknown>)
    if (when === null) continue
    out.push({
      id: r.id,
      source: r.source as PolicyRule["source"],
      when,
      effect: r.effect as PolicyRule["effect"],
      reason: r.reason,
    })
  }
  return out
}
/** Validate a policy condition's sub-fields; return null if malformed (so a bad
 *  rule is dropped rather than crashing the engine at match time). */
function validateCondition(value: Record<string, unknown>): PolicyRule["when"] | null {
  const out: Record<string, unknown> = {}
  if (value.actionClass !== undefined) {
    if (!isStringArray(value.actionClass)) return null
    out.actionClass = value.actionClass
  }
  if (value.actorProfile !== undefined) {
    if (!isStringArray(value.actorProfile)) return null
    out.actorProfile = value.actorProfile
  }
  if (value.repositoryTrust !== undefined) {
    if (!isStringArray(value.repositoryTrust)) return null
    out.repositoryTrust = value.repositoryTrust
  }
  for (const flag of [
    "writesWorkspace",
    "writesExternal",
    "writesTemporary",
    "deletion",
    "executesCode",
    "createsAdHocCode",
    "packageManagement",
    "gitMutation",
    "networkObserved",
    "privilegeEscalation",
    "remoteEnabled",
    "persistence",
  ]) {
    if (value[flag] !== undefined) {
      if (typeof value[flag] !== "boolean") return null
      out[flag] = value[flag]
    }
  }
  return out as PolicyRule["when"]
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
}

export function resolveConfig(options: Record<string, unknown> | undefined): ReviewerConfig {
  const source = options ?? {}
  const model =
    typeof source.model === "string" && source.model.includes("/")
      ? source.model
      : DEFAULT_CONFIG.model
  const variant =
    typeof source.variant === "string" && source.variant.length > 0
      ? source.variant
      : DEFAULT_CONFIG.variant
  const outputFormat = source.outputFormat === "text" ? "text" : "json_schema"
  const policy =
    typeof source.policy === "string" && source.policy.trim().length > 0
      ? source.policy.trim()
      : undefined
  const auditPath =
    typeof source.auditPath === "string" && source.auditPath.trim().length > 0
      ? source.auditPath.trim()
      : undefined

  return {
    model,
    variant,
    outputFormat,
    timeoutMs: boundedInteger(source.timeoutMs, DEFAULT_CONFIG.timeoutMs, 5_000, 600_000),
    maxContextChars: boundedInteger(
      source.maxContextChars,
      DEFAULT_CONFIG.maxContextChars,
      4_000,
      200_000,
    ),
    maxPartChars: boundedInteger(source.maxPartChars, DEFAULT_CONFIG.maxPartChars, 500, 50_000),
    maxEnrichmentChars: boundedInteger(
      source.maxEnrichmentChars,
      DEFAULT_CONFIG.maxEnrichmentChars,
      1_000,
      100_000,
    ),
    maxIntentChars: boundedInteger(
      source.maxIntentChars,
      DEFAULT_CONFIG.maxIntentChars,
      1_000,
      50_000,
    ),
    transcriptMessages: boundedInteger(
      source.transcriptMessages,
      DEFAULT_CONFIG.transcriptMessages,
      1,
      100,
    ),
    intentMessages: boundedInteger(source.intentMessages, DEFAULT_CONFIG.intentMessages, 1, 50),
    historyMessages: boundedInteger(
      source.historyMessages,
      DEFAULT_CONFIG.historyMessages,
      20,
      500,
    ),
    confidenceThreshold: boundedNumber(
      source.confidenceThreshold,
      DEFAULT_CONFIG.confidenceThreshold,
      0.5,
      1,
    ),
    retainReviewSessions:
      typeof source.retainReviewSessions === "boolean"
        ? source.retainReviewSessions
        : DEFAULT_CONFIG.retainReviewSessions,
    audit: typeof source.audit === "boolean" ? source.audit : DEFAULT_CONFIG.audit,
    ...(auditPath === undefined ? {} : { auditPath }),
    ...(policy === undefined ? {} : { policy }),
    debug: typeof source.debug === "boolean" ? source.debug : DEFAULT_CONFIG.debug,
    enforcementMode:
      source.enforcementMode === "enforce" ? "enforce" : DEFAULT_CONFIG.enforcementMode,
    escalationMode: resolveEscalationMode(source.escalationMode),
    maxSessionDepth: boundedInteger(source.maxSessionDepth, DEFAULT_CONFIG.maxSessionDepth, 1, 32),
    maxParentSessions: boundedInteger(
      source.maxParentSessions,
      DEFAULT_CONFIG.maxParentSessions,
      0,
      32,
    ),
    actorProfiles: resolveActorProfiles(source.actorProfiles),
    riskPolicy: resolveRiskPolicy(source.riskPolicy),
    repositoryTrust: resolveRepositoryTrust(source.repositoryTrust),
    policyRules: resolvePolicyRules(source.policyRules),
    askDecisions:
      typeof source.askDecisions === "boolean" ? source.askDecisions : DEFAULT_CONFIG.askDecisions,
  }
}

export function splitModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(`Invalid reviewer model "${model}"; expected provider/model`)
  }
  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  }
}
