import type {
  EscalationDisposition,
  ReviewExecutionResult,
  ReviewerConfig,
  ReviewOutcome,
} from "./types.ts"

/**
 * Categories that can be hardened independently of the global escalation mode
 * via `riskPolicy.onInvalidDecision` / `riskPolicy.onReviewerFailure`.
 * `general` covers every other escalate path (LLM escalate, gates, policy
 * manual, context failures, …).
 */
export type EscalationCategory = "general" | "invalid-decision" | "reviewer-failure"

/**
 * Resolve the effective disposition for an internal escalate.
 *
 * Precedence is monotonic (restrictive wins):
 * 1. `escalationMode: "deny"` hardens every escalate globally.
 * 2. Category knobs can harden only their own case when mode is `manual`.
 * 3. Nothing can relax a more restrictive setting.
 *
 * `manual-superseded` is never converted: the request is already closed.
 */
export function resolveEscalationDisposition(
  result: ReviewExecutionResult,
  config: ReviewerConfig,
  category: EscalationCategory = "general",
): EscalationDisposition {
  if (result.decisionSource === "manual-superseded") return "manual"
  if (result.kind !== "escalate") return "manual"

  if (config.escalationMode === "deny") return "deny"

  if (category === "invalid-decision" && config.riskPolicy.onInvalidDecision === "deny") {
    return "deny"
  }
  if (category === "reviewer-failure" && config.riskPolicy.onReviewerFailure === "deny") {
    return "deny"
  }
  return "manual"
}

/**
 * Single enforcement boundary: convert an internal escalate into the effective
 * disposition used for UI, reply, and audit. Allow/deny and manual-superseded
 * pass through unchanged.
 *
 * When converting escalate → deny, the original reason is preserved so the
 * primary agent still receives actionable feedback. The original structured
 * decision (if any) is kept as-is — never rewritten into a synthetic deny —
 * so audit can distinguish a real LLM escalate from a fail-safe without a
 * structured decision. `reviewerOutcome` is only set when a structured
 * decision actually existed.
 */
export function applyEscalationDisposition(
  result: ReviewExecutionResult,
  config: ReviewerConfig,
  category: EscalationCategory = "general",
): ReviewExecutionResult {
  if (result.decisionSource === "manual-superseded") return result
  if (result.kind !== "escalate") return result

  const disposition = resolveEscalationDisposition(result, config, category)
  const reviewerOutcome = resolveReviewerOutcome(result)

  if (disposition === "manual") {
    return {
      ...result,
      ...(reviewerOutcome === undefined ? {} : { reviewerOutcome }),
      escalationDisposition: "manual",
    }
  }

  return {
    kind: "deny",
    reason: result.reason,
    ...(result.decision === undefined ? {} : { decision: result.decision }),
    ...(result.reviewSessionID === undefined ? {} : { reviewSessionID: result.reviewSessionID }),
    ...(result.decisionSource === undefined ? {} : { decisionSource: result.decisionSource }),
    ...(reviewerOutcome === undefined ? {} : { reviewerOutcome }),
    ...(result.reviewerModel === undefined ? {} : { reviewerModel: result.reviewerModel }),
    ...(result.reviewerEscalatedFrom === undefined
      ? {}
      : { reviewerEscalatedFrom: result.reviewerEscalatedFrom }),
    escalationDisposition: "deny",
  }
}

/**
 * Structured reviewer outcome only when one actually existed. Never invent
 * `escalate` for timeouts, invalid output, policy-manual routes, or other
 * fail-safes that never produced a valid decision.
 */
function resolveReviewerOutcome(result: ReviewExecutionResult): ReviewOutcome | undefined {
  if (result.reviewerOutcome !== undefined) return result.reviewerOutcome
  if (result.decision !== undefined) return result.decision.outcome
  return undefined
}
