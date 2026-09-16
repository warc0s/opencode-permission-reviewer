import type {
  PermissionRequest,
  ReviewEnvelope,
  ReviewExecutionResult,
  ReviewerConfig,
} from "../types.ts"
import { emergencyBrakeReason } from "../emergency-brake.ts"
import { evaluatePolicy } from "../policy/policy-engine.ts"
import { applyEscalationDisposition } from "../escalation.ts"

export interface ReviewEnginePorts {
  collect(request: PermissionRequest): Promise<ReviewEnvelope>
  review(envelope: ReviewEnvelope): Promise<ReviewExecutionResult>
  active(): boolean
  auxiliarySession(sessionID: string): boolean
  observe(envelope: ReviewEnvelope): void
}

/** Evaluate policy and evidence without applying a permission or publishing UI. */
export async function evaluateReview(
  request: PermissionRequest,
  config: ReviewerConfig,
  ports: ReviewEnginePorts,
): Promise<ReviewExecutionResult> {
  const superseded = (): ReviewExecutionResult => ({
    kind: "escalate",
    reason: "Request already answered manually; automatic review superseded.",
    decisionSource: "manual-superseded",
  })
  const deny = (reason: string, emergency: boolean): ReviewExecutionResult => ({
    kind: "deny",
    reason,
    decision: {
      version: 2,
      outcome: "deny",
      risk_level: emergency ? "critical" : "high",
      user_authorization: "unknown",
      scope_alignment: "unknown",
      evidence_completeness: "unknown",
      rationale: reason,
      confidence: 1,
    },
    decisionSource: emergency ? "emergency-brake" : "deterministic-policy",
  })
  if (!ports.active()) return superseded()
  if (ports.auxiliarySession(request.sessionID)) {
    return deny("Automatic reviewer sessions may not request additional permissions.", true)
  }
  const brake = emergencyBrakeReason(request)
  if (brake) return deny(brake, true)
  const envelope = await ports.collect(request)
  if (envelope.preflightDenial) return deny(envelope.preflightDenial, false)
  if (!ports.active()) return superseded()
  const trace = evaluatePolicy(envelope.capability, envelope.actor, config, config.policyRules)
  envelope.policyTrace = trace
  ports.observe(envelope)
  if (config.enforcementMode === "enforce" && trace.finalRoute !== "review") {
    if (trace.finalRoute === "deny") {
      return deny(
        `Declarative policy route: deny. ${trace.matchedRules.map((m) => m.reason).join("; ")}`,
        false,
      )
    }
    if (trace.finalRoute === "manual") {
      return applyEscalationDisposition(
        {
          kind: "escalate",
          reason: `Declarative policy route: manual. ${trace.matchedRules.map((m) => m.reason).join("; ")}`,
          decisionSource: "deterministic-policy",
        },
        config,
        "general",
      )
    }
  }
  if (!ports.active()) return superseded()
  let result = await ports.review(envelope)
  if (!ports.active()) return superseded()
  if (result.kind === "allow") {
    const degraded = config.configDegraded
    const reason =
      degraded !== undefined && degraded.length > 0
        ? `Automatic approval is disabled: the reviewer configuration is degraded (${degraded.join("; ")}). Fix the trusted config to restore auto-approval.`
        : envelope.actionEvidenceComplete === false
          ? "Automatic approval is blocked: a material part of the pending action was elided or truncated in the reviewer evidence, so the model judged an incomplete view of the action."
          : undefined
    if (reason !== undefined) {
      result = applyEscalationDisposition(
        {
          kind: "escalate",
          reason,
          ...(result.decision === undefined ? {} : { decision: result.decision }),
          ...(result.reviewSessionID === undefined
            ? {}
            : { reviewSessionID: result.reviewSessionID }),
          decisionSource: "deterministic-policy",
        },
        config,
        "general",
      )
    }
  }
  return result.kind === "escalate" && result.escalationDisposition === undefined
    ? applyEscalationDisposition(result, config, "general")
    : result
}
