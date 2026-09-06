import { createHash } from "node:crypto"
import type {
  ActorContext,
  CapabilityAssessment,
  PolicyCondition,
  PolicyRule,
  PolicyTrace,
  ReviewerConfig,
} from "../types.ts"

/*
 * Declarative policy engine (Layer B).
 *
 * Evaluates capability + actor facts against a rule set and produces a
 * PolicyTrace. The engine is pure logic — it never calls the LLM, never modifies
 * the request, and never throws. Match semantics are MOST-RESTRICTIVE: when
 * multiple rules match, the most restrictive effect wins (deny > manual > review
 * > allow). This prevents rule ordering from becoming a silent attack surface.
 *
 * In observe mode the trace is computed and audited but the coordinator always
 * proceeds to the reviewer LLM. In enforce mode a manual/deny finalRoute skips
 * the LLM entirely. Universal invariants (the emergency brake) always run before
 * this engine and are never weakened by policy rules.
 *
 * Default rules ship EMPTY so observe mode produces zero behavior change. The
 * conservative profile templates exist as documentation and will be added as
 * built-in rules before enforce mode is publicly enabled.
 */

const EFFECT_SEVERITY: Record<PolicyRule["effect"], number> = {
  deny: 3,
  manual: 2,
  review: 1,
  allow: 0,
}

const EMPTY_TRACE_ROUTE = "review" as const

/**
 * Evaluate the declarative policy against capability and actor facts.
 * Never throws — returns a trace with an empty matchedRules list on any failure.
 */
export function evaluatePolicy(
  capability: CapabilityAssessment | undefined,
  actor: ActorContext | undefined,
  config: ReviewerConfig,
  rules: PolicyRule[] = [],
): PolicyTrace {
  const effectiveRules = filterProjectAllowRules(rules)
  const effectivePolicyHash = hashEffectivePolicy(effectiveRules, config)
  const matched: PolicyTrace["matchedRules"] = []

  for (const rule of effectiveRules) {
    if (matches(rule.when, capability, actor, config)) {
      matched.push({
        id: rule.id,
        source: rule.source,
        effect: rule.effect,
        reason: rule.reason,
      })
    }
  }

  // Most-restrictive resolution: deny > manual > review > allow. Seed from the
  // first match so a lone allow rule is not silently overridden by the review
  // default.
  let finalRoute: PolicyTrace["finalRoute"] = EMPTY_TRACE_ROUTE
  if (matched.length > 0) {
    let bestEffect = matched[0]!.effect as PolicyTrace["finalRoute"]
    let bestSev = EFFECT_SEVERITY[matched[0]!.effect as PolicyRule["effect"]] ?? 1
    for (let i = 1; i < matched.length; i += 1) {
      const sev = EFFECT_SEVERITY[matched[i]!.effect as PolicyRule["effect"]] ?? 1
      if (sev > bestSev) {
        bestEffect = matched[i]!.effect as PolicyTrace["finalRoute"]
        bestSev = sev
      }
    }
    finalRoute = bestEffect
  }

  return {
    effectivePolicyHash,
    matchedRules: matched,
    finalRoute,
    mode: config.enforcementMode,
  }
}

/** Project-sourced allow rules are rejected: project config cannot relax safety. */
export function filterProjectAllowRules(rules: PolicyRule[]): PolicyRule[] {
  return rules.filter((r) => !(r.source === "project" && r.effect === "allow"))
}

/** Whether every field of a condition matches the observed facts. */
function matches(
  cond: PolicyCondition,
  cap: CapabilityAssessment | undefined,
  actor: ActorContext | undefined,
  config: ReviewerConfig,
): boolean {
  if (cond.actionClass !== undefined) {
    if (!Array.isArray(cond.actionClass) || cap === undefined) return false
    if (!cond.actionClass.includes(cap.actionClass.value)) return false
  }
  if (cond.actorProfile !== undefined) {
    if (!Array.isArray(cond.actorProfile) || actor === undefined) return false
    if (!cond.actorProfile.includes(actor.profile.value)) return false
  }
  if (cond.writesWorkspace === true && cap?.writeEffects.workspaceWrite.value !== true) return false
  if (cond.writesExternal === true && cap?.writeEffects.externalWrite.value !== true) return false
  if (cond.writesTemporary === true && cap?.writeEffects.temporaryWrite.value !== true) return false
  if (cond.deletion === true && cap?.writeEffects.deletion.value !== true) return false
  if (cond.executesCode === true && cap?.executesCode.value !== true) return false
  if (cond.createsAdHocCode === true && cap?.createsAdHocCode.value !== true) return false
  // Capability facts, not the dominant action class, decide package-management
  // matches: a command can execute code AND drive a package lifecycle at once
  // (e.g. `bun install`), and requiring the single dominant class to be
  // "package-management" would make the condition unmatchable for exactly the
  // most dangerous variants.
  if (cond.packageManagement === true && cap?.invokesPackageLifecycleScripts.value !== true)
    return false
  if (cond.gitMutation === true && cap?.git.possible.value !== true) return false
  if (cond.networkObserved === true && cap?.network.observed.value !== true) return false
  if (cond.privilegeEscalation === true && cap?.process.privilegeEscalation.value !== true)
    return false
  if (cond.remoteEnabled === true && cap?.remote.enabled.value !== true) return false
  if (cond.persistence === true && cap?.process.persistence.value !== true) return false
  if (cond.repositoryTrust !== undefined) {
    if (!Array.isArray(cond.repositoryTrust)) return false
    if (!cond.repositoryTrust.includes(config.repositoryTrust)) return false
  }
  return true
}

/** Deterministic hash of the rule set for audit reproducibility. The engine
 *  uses this for the policy trace; exposing it lets diagnostics print the exact
 *  same hash a review would produce. */
export function hashRuleSet(rules: PolicyRule[]): string {
  const canonical = rules
    .map((r) => `${r.id}:${r.effect}:${JSON.stringify(r.when)}`)
    .sort()
    .join("|")
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16)
}

/** Hash of everything that deterministically shapes a policy outcome: the
 *  effective rules plus the decision-relevant config (confidence floor, risk
 *  matrix, repository trust). Two runs that would enforce different thresholds
 *  must not share the same "effective policy" identity. */
export function hashEffectivePolicy(rules: PolicyRule[], config: ReviewerConfig): string {
  const rulesCanonical = rules
    .map((r) => `${r.id}:${r.effect}:${JSON.stringify(r.when)}`)
    .sort()
    .join("|")
  const decisionConfig = JSON.stringify({
    confidenceThreshold: config.confidenceThreshold,
    minimumConfidence: config.riskPolicy.minimumConfidence,
    riskPolicyAllow: config.riskPolicy.allow,
    repositoryTrust: config.repositoryTrust,
  })
  return createHash("sha256")
    .update(`${rulesCanonical}#${decisionConfig}`)
    .digest("hex")
    .slice(0, 16)
}

/**
 * The conservative profile routing templates. These are NOT active by default
 * (observe mode ships with an empty rule set). They are documented here so the
 * engine can be tested against them and so enforce-mode users can opt into them.
 */
export const PROFILE_TEMPLATES: PolicyRule[] = [
  {
    id: "read-only-workspace-write",
    source: "builtin",
    when: { actorProfile: ["read-only"], writesWorkspace: true },
    effect: "manual",
    reason: "read-only actor attempting workspace write",
  },
  {
    id: "read-only-code-execution",
    source: "builtin",
    when: { actorProfile: ["read-only"], executesCode: true },
    effect: "manual",
    reason: "read-only actor attempting code execution",
  },
  {
    id: "any-actor-package-untrusted",
    source: "builtin",
    when: { packageManagement: true, repositoryTrust: ["untrusted", "unknown"] },
    effect: "manual",
    reason: "package management in an untrusted or unknown repository",
  },
  {
    id: "unknown-actor-remote-mutation",
    source: "builtin",
    when: { actorProfile: ["unknown"], remoteEnabled: true },
    effect: "manual",
    reason: "unknown actor attempting remote operation",
  },
  {
    id: "unknown-actor-external-write",
    source: "builtin",
    when: { actorProfile: ["unknown"], writesExternal: true },
    effect: "manual",
    reason: "unknown actor attempting external write",
  },
]
