import { TypeSafeClient } from "@typesafe-ai/sdk"
import type { ReviewAttempt } from "../core/review-attempt.ts"
import { buildEvidenceResult } from "../context.ts"
import { applyEscalationDisposition } from "../escalation.ts"
import { formatFailureReason } from "../failure-reason.ts"
import { DEFAULT_TENANT_POLICY, REVIEWER_SYSTEM_PROMPT } from "../policy.ts"
import { redactSecrets } from "../redact.ts"
import { splitModel } from "../config.ts"
import type { ReviewEnvelope, ReviewExecutionResult, ReviewerConfig } from "../types.ts"
import {
  enforceParsedSystemOneReview,
  parseSystemOneReview,
  SYSTEM_ONE_QUESTIONS,
  type SystemOneState,
} from "./review.ts"

export type ReasoningEscalation = (
  envelope: ReviewEnvelope,
  attempt: ReviewAttempt,
) => Promise<ReviewExecutionResult>

export type SystemOneInvoke = (state: SystemOneState, signal: AbortSignal) => Promise<unknown>

const SYSTEM_ONE_RETRY = {
  maxRetries: 2,
  backoffInitialMs: 400,
  backoffMaxMs: 800,
  httpStatuses: new Set([503]),
  respectRetryAfter: false,
  apiConnectionError: false,
  apiTimeoutError: false,
}

function reconcileReasoningEscalation(result: ReviewExecutionResult): ReviewExecutionResult {
  if (result.kind !== "allow" || result.decision?.evidence_completeness === "sufficient") {
    return result
  }
  const reviewerOutcome = result.decision?.outcome ?? result.reviewerOutcome
  return {
    ...result,
    kind: "escalate",
    reason:
      "The reasoning reviewer did not find sufficient evidence to override the System One escalation.",
    ...(reviewerOutcome === undefined ? {} : { reviewerOutcome }),
  }
}

export function createSystemOneInvoker(
  config: ReviewerConfig,
  fetchImpl?: TypeSafeClient["fetch"],
): SystemOneInvoke {
  const { providerID, modelID } = splitModel(config.model)
  const keyName =
    providerID === "opencode"
      ? "OPENCODE_API_KEY"
      : providerID === "commandcode"
        ? "CMD_API_KEY"
        : "TYPESAFE_API_KEY"
  const apiKey = process.env[keyName]?.trim()
  if (!apiKey) throw new Error(`Missing ${keyName} for System One reviewer ${config.model}`)
  const client = new TypeSafeClient({
    apiKey,
    ...(providerID === "opencode"
      ? { baseURL: "https://opencode.ai/zen" }
      : providerID === "commandcode"
        ? { baseURL: "https://api.commandcode.ai/provider" }
        : {}),
    defaultModel: modelID,
    logLevel: "off",
    timeout: config.timeoutMs,
    retry: SYSTEM_ONE_RETRY,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  })
  return async (state, signal) => {
    const deadline = AbortSignal.timeout(config.timeoutMs)
    const boundedSignal = AbortSignal.any([signal, deadline])
    const { data } = await client
      .systemOne(
        { model: modelID, state, questions: SYSTEM_ONE_QUESTIONS },
        { signal: boundedSignal, timeout: config.timeoutMs },
      )
      .withResponse()
    return data
  }
}

/** Calls Jev directly and delegates only valid but difficult decisions. */
export class SystemOneReviewerBackend {
  private readonly jobs = new Set<Promise<ReviewExecutionResult>>()

  constructor(
    private readonly config: ReviewerConfig,
    private readonly escalation?: ReasoningEscalation,
    private readonly escalationModel?: string,
    private readonly invoke?: SystemOneInvoke,
    private readonly recordReviewerMs?: (envelope: ReviewEnvelope, ms: number) => void,
  ) {}

  owns(): boolean {
    return false
  }

  review(
    envelope: ReviewEnvelope,
    attempt: ReviewAttempt,
    escalation: ReasoningEscalation | undefined = this.escalation,
  ): Promise<ReviewExecutionResult> {
    const job = this.runReview(envelope, attempt, escalation).finally(() => this.jobs.delete(job))
    this.jobs.add(job)
    return job
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.jobs])
  }

  private async runReview(
    envelope: ReviewEnvelope,
    attempt: ReviewAttempt,
    escalation: ReasoningEscalation | undefined,
  ): Promise<ReviewExecutionResult> {
    const started = performance.now()
    try {
      const evidence = buildEvidenceResult(envelope, this.config)
      envelope.actionEvidenceComplete =
        envelope.actionEvidenceComplete !== false && evidence.actionEvidenceComplete
      const state: SystemOneState = {
        trustedPolicy: {
          reviewer: REVIEWER_SYSTEM_PROMPT,
          tenant: redactSecrets(this.config.policy ?? DEFAULT_TENANT_POLICY),
        },
        untrustedEvidence: evidence.text,
      }
      const response = await attempt.wait(
        (this.invoke ?? createSystemOneInvoker(this.config))(state, attempt.signal),
      )
      const parsed = parseSystemOneReview(response, this.config)
      if (!parsed) {
        return applyEscalationDisposition(
          {
            kind: "escalate",
            reason: "System One reviewer returned a missing, invalid, or ambiguous decision.",
            decisionSource: "failure-safe",
            reviewerModel: this.config.model,
          },
          this.config,
          "invalid-decision",
        )
      }

      const enforced = enforceParsedSystemOneReview(parsed, this.config)
      if (enforced.kind !== "escalate") {
        return {
          ...enforced,
          decisionSource: "system-one-reviewer",
          reviewerModel: this.config.model,
        }
      }

      if (escalation && this.escalationModel && parsed.reasoningRecommended) {
        const secondary = reconcileReasoningEscalation(await escalation(envelope, attempt))
        return {
          ...secondary,
          reviewerModel: secondary.reviewerModel ?? this.escalationModel,
          reviewerEscalatedFrom: { model: this.config.model, reason: enforced.reason },
        }
      }

      return applyEscalationDisposition(
        {
          ...enforced,
          decisionSource: "system-one-reviewer",
          reviewerModel: this.config.model,
        },
        this.config,
        "general",
      )
    } catch (error) {
      return applyEscalationDisposition(
        {
          kind: "escalate",
          reason: formatFailureReason("System One reviewer", error),
          decisionSource: "failure-safe",
          reviewerModel: this.config.model,
        },
        this.config,
        "reviewer-failure",
      )
    } finally {
      const elapsed = performance.now() - started
      envelope.timings = { ...envelope.timings, reviewerMs: elapsed }
      this.recordReviewerMs?.(envelope, elapsed)
    }
  }
}
