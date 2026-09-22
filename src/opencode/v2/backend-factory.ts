import type { OpenCodeClient } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import type { ReviewAttempt } from "../../core/review-attempt.ts"
import { isSystemOneReviewerModel } from "../../config.ts"
import { SystemOneReviewerBackend } from "../../system-one/backend.ts"
import type { ReviewEnvelope, ReviewExecutionResult, ReviewerConfig } from "../../types.ts"
import { V2ReviewerBackend } from "./reviewer-backend.ts"

type Context = Parameters<Plugin.Plugin["setup"]>[0]

export interface V2ReviewBackend {
  owns(sessionID: string): boolean
  review(
    envelope: ReviewEnvelope,
    attempt: ReviewAttempt,
    client: OpenCodeClient,
  ): Promise<ReviewExecutionResult>
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

export function createV2ReviewerBackend(context: Context, config: ReviewerConfig): V2ReviewBackend {
  if (!isSystemOneReviewerModel(config.model)) return new V2ReviewerBackend(context, config)
  const secondaryConfig = escalationConfig(config)
  const secondary = secondaryConfig ? new V2ReviewerBackend(context, secondaryConfig) : undefined
  const primary = new SystemOneReviewerBackend(config, undefined, secondaryConfig?.model)
  return {
    owns: (sessionID) => secondary?.owns(sessionID) ?? false,
    review: (envelope, attempt, client) =>
      primary.review(
        envelope,
        attempt,
        secondary ? (value, current) => secondary.review(value, current, client) : undefined,
      ),
    waitForIdle: async () => {
      await Promise.all([primary.waitForIdle(), secondary?.waitForIdle()])
    },
  }
}
