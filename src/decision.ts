import type {
  EvidenceSufficiency,
  ReviewDecision,
  ReviewExecutionResult,
  ReviewerConfig,
  ScopeAlignment,
} from "./types.ts"

const OUTCOMES = new Set(["allow", "deny", "escalate"])
const RISKS = new Set(["low", "medium", "high", "critical"])
const AUTHORIZATIONS = new Set(["high", "medium", "low", "unknown"])
const SCOPE_ALIGNMENTS = new Set(["aligned", "partial", "misaligned", "unknown"])
const EVIDENCE_SUFFICIENCY = new Set(["sufficient", "partial", "insufficient", "unknown"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Parse the reviewer's plain-text response under a strict, fail-closed policy:
 * the entire response must be exactly one JSON object, optionally wrapped in a
 * single Markdown code fence that encloses the whole response. Prose around
 * the object, multiple objects, multiple fences, or any trailing content make
 * the response ambiguous; ambiguity returns `undefined` so the request
 * escalates to a human. This component authorizes tool execution: when the
 * model's output is ambiguous it must never guess which candidate was meant.
 *
 * Text-mode flakiness is absorbed by the coordinator's corrective retry, not by
 * loosening this parser: a looser extractor could auto-approve a draft decision
 * that the model later reversed in prose. See the maintainer's rationale in the
 * commit that hardened this parser (reject ambiguous text-mode reviewer output).
 */
export function extractJsonFromText(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.length === 0) return

  let body = trimmed
  // Accept one fence wrapping the ENTIRE response (``` or ```json) because
  // many models fence JSON even when told not to. The closing fence must be
  // the last thing in the response; anything before or after it rejects the
  // whole response instead of salvaging a candidate from inside.
  if (trimmed.startsWith("```")) {
    const fenceMatch = trimmed.match(/^```[^\n]*\n?([\s\S]*?)\n?```\s*$/)
    if (!fenceMatch) return
    body = fenceMatch[1]!.trim()
  }

  try {
    const parsed = JSON.parse(body)
    // Only a plain object is a candidate decision; arrays/primitives/`null`
    // are rejected so parseDecision never has to special-case them.
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return
  }
}

/** Parse a plain-text reviewer response into a valid decision, if possible. */
export function parseDecisionFromText(text: string): ReviewDecision | undefined {
  return parseDecision(extractJsonFromText(text))
}

export function parseDecision(value: unknown): ReviewDecision | undefined {
  if (!isRecord(value)) return
  // The current schema is version 2. A model output that omits the version
  // (or carries a different one) is rejected outright and routed to a human;
  // it never silently degrades to a guessed decision.
  if (value.version !== DECISION_SCHEMA_VERSION) return
  if (typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome)) return
  if (typeof value.risk_level !== "string" || !RISKS.has(value.risk_level)) return
  if (typeof value.user_authorization !== "string" || !AUTHORIZATIONS.has(value.user_authorization))
    return
  if (typeof value.rationale !== "string") return
  const rationale = value.rationale.trim()
  if (rationale.length < 3 || rationale.length > 2_000) return
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence)) return
  if (value.confidence < 0 || value.confidence > 1) return
  if (typeof value.scope_alignment !== "string" || !SCOPE_ALIGNMENTS.has(value.scope_alignment))
    return
  if (
    typeof value.evidence_completeness !== "string" ||
    !EVIDENCE_SUFFICIENCY.has(value.evidence_completeness)
  )
    return

  return {
    version: DECISION_SCHEMA_VERSION,
    outcome: value.outcome as ReviewDecision["outcome"],
    risk_level: value.risk_level as ReviewDecision["risk_level"],
    user_authorization: value.user_authorization as ReviewDecision["user_authorization"],
    rationale,
    confidence: value.confidence,
    scope_alignment: value.scope_alignment as ScopeAlignment,
    evidence_completeness: value.evidence_completeness as EvidenceSufficiency,
  }
}

export function enforceDecision(
  decision: ReviewDecision,
  config: ReviewerConfig,
): ReviewExecutionResult {
  const reviewerOutcome = decision.outcome

  if (decision.risk_level === "critical" && decision.outcome !== "deny") {
    return {
      kind: "escalate",
      decision,
      reason: "Reviewer returned a non-denial for critical risk; manual review required.",
      reviewerOutcome,
    }
  }

  if (decision.confidence < config.confidenceThreshold) {
    return {
      kind: "escalate",
      decision,
      reason: `Reviewer confidence ${decision.confidence.toFixed(2)} is below ${config.confidenceThreshold.toFixed(2)}.`,
      reviewerOutcome,
    }
  }

  // Deterministic risk×authorization gate, now driven by the configurable
  // riskPolicy matrix. This only ever RESTRICTS an `allow`: the model's
  // `deny`/`escalate` outcomes are always preserved. The default matrix
  // reproduces the previous hard-coded behavior exactly.
  if (decision.outcome === "allow") {
    const { risk_level: risk, user_authorization: auth } = decision
    const permitted = config.riskPolicy.allow[risk]
    if (permitted === undefined || !permitted.includes(auth)) {
      return {
        kind: "escalate",
        decision,
        reason: `Reviewer allow for ${risk} risk with ${auth} user authorization; manual review required.`,
        reviewerOutcome,
      }
    }

    // Schema v2 gate: a request the reviewer judged misaligned with the
    // recovered user/delegated intent is never auto-allowed.
    if (decision.scope_alignment === "misaligned") {
      return {
        kind: "escalate",
        decision,
        reason:
          "Reviewer judged the request misaligned with the stated intent; manual review required.",
        reviewerOutcome,
      }
    }

    // Schema v2 gate: for medium-or-higher risk, insufficient evidence
    // prevents auto-allow (the reviewer cannot confidently judge).
    if (
      (risk === "medium" || risk === "high" || risk === "critical") &&
      decision.evidence_completeness === "insufficient"
    ) {
      return {
        kind: "escalate",
        decision,
        reason: `Reviewer judged evidence insufficient for ${risk} risk; manual review required.`,
        reviewerOutcome,
      }
    }

    return { kind: "allow", decision, reason: decision.rationale, reviewerOutcome }
  }
  if (decision.outcome === "deny") {
    return { kind: "deny", decision, reason: decision.rationale, reviewerOutcome }
  }
  return { kind: "escalate", decision, reason: decision.rationale, reviewerOutcome }
}

export const DECISION_SCHEMA_VERSION = 2

export const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "outcome",
    "risk_level",
    "user_authorization",
    "scope_alignment",
    "evidence_completeness",
    "rationale",
    "confidence",
  ],
  properties: {
    version: {
      type: "number",
      enum: [DECISION_SCHEMA_VERSION],
      description: "Structured-decision schema version. Must be exactly 2.",
    },
    outcome: {
      type: "string",
      enum: ["allow", "deny", "escalate"],
      description: "allow executes once, deny rejects, escalate leaves the request for a human",
    },
    risk_level: {
      type: "string",
      enum: ["low", "medium", "high", "critical"],
    },
    user_authorization: {
      type: "string",
      enum: ["high", "medium", "low", "unknown"],
    },
    rationale: {
      type: "string",
      minLength: 3,
      maxLength: 2000,
      description: "One concise sentence explaining the main reason for the decision",
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
    scope_alignment: {
      type: "string",
      enum: ["aligned", "partial", "misaligned", "unknown"],
      description:
        "How well the request aligns with the recovered user or delegated intent: aligned (within scope), partial (tangential), misaligned (outside scope), unknown (insufficient context).",
    },
    evidence_completeness: {
      type: "string",
      enum: ["sufficient", "partial", "insufficient", "unknown"],
      description:
        "Whether the evidence was sufficient to decide: sufficient, partial (some gaps), insufficient (major gaps), unknown.",
    },
  },
} as const
