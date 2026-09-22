import type { ReviewAttempt } from "../../core/review-attempt.ts"
import { isSystemOneReviewerModel } from "../../config.ts"
import { SystemOneReviewerBackend } from "../../system-one/backend.ts"
import type { ReviewEnvelope, ReviewExecutionResult, ReviewerConfig } from "../../types.ts"
import type { RuntimeContext } from "../types.ts"
import { V1ReviewerBackend } from "./reviewer-backend.ts"

export interface V1ReviewBackend {
  owns(sessionID: string): boolean
  review(envelope: ReviewEnvelope, attempt: ReviewAttempt): Promise<ReviewExecutionResult>
  waitForIdle(): Promise<void>
}

function escalationConfig(config: ReviewerConfig): ReviewerConfig | undefined {
  const escalation = config.escalationReviewer
  if (!escalation) return
  const base = { ...config }
  delete base.escalationReviewer
  return {
    ...base,
    ...escalation,
  }
}

export function createV1ReviewerBackend(
  ctx: RuntimeContext,
  config: ReviewerConfig,
  log: (message: string, details?: unknown) => void,
  recordReviewerMs: (envelope: ReviewEnvelope, ms: number) => void,
): V1ReviewBackend {
  if (!isSystemOneReviewerModel(config.model)) {
    return new V1ReviewerBackend(ctx, config, log, recordReviewerMs)
  }
  const secondaryConfig = escalationConfig(config)
  const secondary = secondaryConfig
    ? new V1ReviewerBackend(ctx, secondaryConfig, log, recordReviewerMs)
    : undefined
  const primary = new SystemOneReviewerBackend(
    config,
    secondary ? (envelope, attempt) => secondary.review(envelope, attempt) : undefined,
    secondaryConfig?.model,
    undefined,
    recordReviewerMs,
  )
  return {
    owns: (sessionID) => secondary?.owns(sessionID) ?? false,
    review: (envelope, attempt) => primary.review(envelope, attempt),
    waitForIdle: async () => {
      await Promise.all([primary.waitForIdle(), secondary?.waitForIdle()])
    },
  }
}
