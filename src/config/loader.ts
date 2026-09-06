import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseJsoncStrict } from "./jsonc.ts"
import { resolveConfig, DEFAULT_CONFIG, DEFAULT_RISK_POLICY } from "../config.ts"
import type { PolicyRule, ReviewerConfig } from "../types.ts"

interface ConfigLayer {
  raw: Record<string, unknown>
  /** Set when the file exists but could not be interpreted; a silently
   *  unreadable trusted layer must be visible, not indistinguishable from an
   *  absent one. */
  warning?: string
}

/** Read a JSONC config file. A missing file is the common case and yields an
 *  empty record with no warning; an unreadable or malformed file also yields
 *  an empty record (the plugin must keep working) but carries a warning. */
function readConfigLayer(path: string): ConfigLayer {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return { raw: {} }
  }
  try {
    return { raw: parseJsoncStrict(text) }
  } catch (error) {
    return {
      raw: {},
      warning: `permission-reviewer config at ${path} is malformed and was ignored (${error instanceof Error ? error.message : String(error)})`,
    }
  }
}

/** Optional override used by unit tests so a developer's personal global config
 *  cannot leak into loader assertions. Production always uses the real path. */
let globalConfigPathOverride: string | undefined

/** Path to the global user config. Exposed for testability. */
export function globalConfigPath(): string {
  return (
    globalConfigPathOverride ?? join(homedir(), ".config", "opencode", "permission-reviewer.jsonc")
  )
}

/** Test-only: redirect (or clear) the global config path. */
export function setGlobalConfigPathForTests(path: string | undefined): void {
  globalConfigPathOverride = path
}

/** Path to the project-local config. Exposed for testability. */
export function projectConfigPath(directory: string): string {
  return join(directory, ".opencode", "permission-reviewer.jsonc")
}

/** Fields managed by the trust boundary. For these, the boundary's output is
 *  final: the project layer may only tighten them against the trusted
 *  baseline (which already includes inline), and a later inline value must not
 *  undo that tightening. For every other field the documented precedence
 *  applies and inline (trusted, most specific) wins over the project. */
const TRUST_BOUNDARY_KEYS = new Set([
  "confidenceThreshold",
  "audit",
  "auditPath",
  "model",
  "policy",
  "repositoryTrust",
  "actorProfiles",
  "enforcementMode",
  "riskPolicy",
  "escalationMode",
  "policyRules",
])

/** Load and merge config from global, project, and inline sources.
 *
 * Precedence (lowest to highest): builtin defaults → global → project → inline,
 * with one deliberate exception: security-sensitive fields cross a trust
 * boundary where the untrusted project layer can only TIGHTEN the trusted
 * baseline (see mergeWithTrustBoundary), and that hardening survives even
 * when inline set the same field.
 *
 * When no global or project files exist (the common case), the result is
 * byte-identical to calling `resolveConfig(inlineOptions)` directly. */
export function loadResolvedConfig(
  inlineOptions: Record<string, unknown> | undefined,
  directory?: string,
): ReviewerConfig {
  const globalLayer = readConfigLayer(globalConfigPath())
  const projectLayer: ConfigLayer =
    directory !== undefined ? readConfigLayer(projectConfigPath(directory)) : { raw: {} }
  for (const layer of [globalLayer, projectLayer]) {
    if (layer.warning !== undefined) console.warn(layer.warning)
  }

  // The trusted baseline is seeded with builtin defaults (so clamping always
  // has a floor) and includes inline, which participates as a trusted source
  // the project layer is clamped against.
  const trusted: Record<string, unknown> = {
    ...DEFAULT_CONFIG,
    ...globalLayer.raw,
    ...(inlineOptions ?? {}),
  }
  const merged = mergeWithTrustBoundary(trusted, projectLayer.raw)
  // Inline keeps documented precedence over the project layer for every
  // non-security field (the boundary's own keys are exempt: re-applying inline
  // there could undo project hardening clamped against it).
  const out: Record<string, unknown> = { ...merged }
  for (const [key, value] of Object.entries(inlineOptions ?? {})) {
    if (!TRUST_BOUNDARY_KEYS.has(key)) out[key] = value
  }
  return resolveConfig(out)
}

/** Whether the key is present in the layer (a `null`/wrong-type value must be
 *  handled as a present-but-invalid override, never silently forwarded). */
function hasKey(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Merge the trusted baseline with the untrusted project layer. Project config
 *  can only TIGHTEN security-sensitive fields, never weaken them. A project
 *  value of the wrong type (including `null`) is dropped so it can never fall
 *  through to `resolveConfig`'s defaults and reset a trusted restriction. */
function mergeWithTrustBoundary(
  trusted: Record<string, unknown>,
  project: Record<string, unknown>,
): Record<string, unknown> {
  const clamped = { ...project }

  // confidenceThreshold: project can raise but not lower it; non-numeric
  // values (including null) are ignored so they cannot reset the threshold.
  if (hasKey(clamped, "confidenceThreshold")) {
    if (
      typeof clamped.confidenceThreshold !== "number" ||
      !Number.isFinite(clamped.confidenceThreshold)
    ) {
      delete clamped.confidenceThreshold
    } else if (
      typeof trusted.confidenceThreshold === "number" &&
      clamped.confidenceThreshold < trusted.confidenceThreshold
    ) {
      clamped.confidenceThreshold = trusted.confidenceThreshold
    }
  }

  // audit: project can enable but not disable.
  if (clamped.audit === false && trusted.audit !== false) {
    delete clamped.audit
  }

  // auditPath: only trusted global/inline config may choose the audit
  // destination. A repository must never be able to redirect or silence the
  // audit trail by pointing it at /dev/null or a path it controls.
  delete clamped.auditPath

  // model and policy: the reviewer destination and the tenant policy text are
  // trusted decisions. A repository must not choose where code/context is sent
  // for review, nor rewrite the policy the reviewer enforces.
  delete clamped.model
  delete clamped.policy

  // repositoryTrust: the project layer may only declare its own repository
  // untrusted; it cannot grant "trusted" or reset a trusted "untrusted".
  if (clamped.repositoryTrust !== "untrusted") {
    delete clamped.repositoryTrust
  }

  // actorProfiles: name→profile mappings are a trust delegation (which agent
  // gets which capability profile). Only trusted global/inline config may
  // grant them; otherwise a repository could promote its own agent to a
  // higher-privilege profile ("build" → "operator"). trustedProjects opt-in is
  // a future item; until then the project layer cannot define mappings at all.
  delete clamped.actorProfiles

  // enforcementMode: project cannot enable OR disable enforcement — only
  // global/inline can. A project "enforce" is deleted (can't enable), and a
  // project "observe" when the trusted baseline is "enforce" is also deleted
  // (can't downgrade from a global enforcement setting).
  if (clamped.enforcementMode !== undefined) {
    if (clamped.enforcementMode === "enforce" || trusted.enforcementMode === "enforce") {
      delete clamped.enforcementMode
    }
  }

  // riskPolicy: project can narrow allow cells and harden failure knobs, never
  // relax a trusted deny or widen an allow cell. A non-object value (including
  // null) is ignored entirely so it cannot wipe the trusted matrix.
  if (hasKey(clamped, "riskPolicy")) {
    if (isPlainObject(clamped.riskPolicy)) {
      const trustedPolicy = isPlainObject(trusted.riskPolicy)
        ? trusted.riskPolicy
        : (DEFAULT_RISK_POLICY as unknown as Record<string, unknown>)
      clamped.riskPolicy = clampRiskPolicy(clamped.riskPolicy, trustedPolicy)
    } else {
      delete clamped.riskPolicy
    }
  }

  // escalationMode: project can only harden manual → deny, never relax deny →
  // manual. Invalid values are dropped so they cannot override a trusted deny
  // through resolveConfig's "anything but deny → manual" fallback.
  if (clamped.escalationMode !== undefined) {
    if (clamped.escalationMode !== "manual" && clamped.escalationMode !== "deny") {
      delete clamped.escalationMode
    } else if (clamped.escalationMode === "manual" && trusted.escalationMode === "deny") {
      delete clamped.escalationMode
    }
  }

  // policyRules: the project layer ADDS rules (which can only tighten — its
  // allow rules are filtered by the engine), it never erases trusted
  // global/inline deny/manual rules. Combine instead of replace so a repo
  // cannot weaken policy by declaring an empty or narrower rule set. Project
  // rules are also re-tagged source:"project" so they cannot spoof
  // source:"inline" to bypass the project-allow filter.
  if (Array.isArray(clamped.policyRules)) {
    const projectRules = (clamped.policyRules as Array<Record<string, unknown>>).map((rule) => ({
      ...rule,
      source: "project" as PolicyRule["source"],
    }))
    const trustedRules = Array.isArray(trusted.policyRules) ? trusted.policyRules : []
    clamped.policyRules = [...trustedRules, ...projectRules]
  } else if (Array.isArray(trusted.policyRules)) {
    // Project omitted policyRules entirely: preserve the trusted rules.
    clamped.policyRules = trusted.policyRules
  }

  return { ...trusted, ...clamped }
}

/** Ensure project riskPolicy can only tighten the trusted baseline. */
function clampRiskPolicy(
  project: Record<string, unknown>,
  trusted: Record<string, unknown>,
): Record<string, unknown> {
  const projectAllow =
    typeof project.allow === "object" && project.allow !== null
      ? (project.allow as Record<string, unknown>)
      : undefined
  const trustedAllow =
    typeof trusted.allow === "object" && trusted.allow !== null
      ? (trusted.allow as Record<string, unknown>)
      : {}
  const clampedAllow: Record<string, unknown> = {}
  for (const risk of ["low", "medium", "high", "critical"] as const) {
    const trustedCell = Array.isArray(trustedAllow[risk]) ? (trustedAllow[risk] as unknown[]) : []
    if (projectAllow === undefined) {
      // Project omitted allow entirely: keep the trusted cells.
      clampedAllow[risk] = trustedCell
      continue
    }
    const projectCell = Array.isArray(projectAllow[risk]) ? (projectAllow[risk] as unknown[]) : []
    // Intersection: project can only remove, never add. Missing project cell →
    // empty intersection (most restrictive) when the project provided an allow
    // object at all.
    clampedAllow[risk] = trustedCell.filter((auth) => projectCell.includes(auth))
  }

  // Start from trusted so partial project objects cannot wipe failure knobs.
  const out: Record<string, unknown> = {
    ...trusted,
    allow: clampedAllow,
  }

  // Failure knobs: project may harden manual → deny only.
  if (project.onInvalidDecision === "deny" || trusted.onInvalidDecision === "deny") {
    out.onInvalidDecision = "deny"
  } else if (project.onInvalidDecision === "manual" || project.onInvalidDecision === undefined) {
    out.onInvalidDecision = trusted.onInvalidDecision ?? "manual"
  }

  if (project.onReviewerFailure === "deny" || trusted.onReviewerFailure === "deny") {
    out.onReviewerFailure = "deny"
  } else if (project.onReviewerFailure === "manual" || project.onReviewerFailure === undefined) {
    out.onReviewerFailure = trusted.onReviewerFailure ?? "manual"
  }

  // minimumConfidence: project can raise but not lower.
  const trustedMin =
    typeof trusted.minimumConfidence === "number" && Number.isFinite(trusted.minimumConfidence)
      ? trusted.minimumConfidence
      : DEFAULT_RISK_POLICY.minimumConfidence
  if (typeof project.minimumConfidence === "number" && Number.isFinite(project.minimumConfidence)) {
    out.minimumConfidence = Math.max(trustedMin, project.minimumConfidence)
  } else {
    out.minimumConfidence = trustedMin
  }

  return out
}
