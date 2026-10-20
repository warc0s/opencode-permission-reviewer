import type { OpenCodeClient } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import type { ReviewAttempt } from "../../core/review-attempt.ts"
import { isSystemOneReviewerModel } from "../../config.ts"
import { createSystemOneInvoker, SystemOneReviewerBackend, type SystemOneInvoke } from "../../system-one/backend.ts"
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
  dispose(): Promise<void>
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
  const liquid = config.model === "liquid-ai/d1" || config.model === "liquid-ai/d1-ultra"
  const invoke: SystemOneInvoke | undefined = liquid
    ? async (state, signal) => {
        if (process.env.LIQUID_API_KEY?.trim()) {
          return createSystemOneInvoker(config)(state, signal)
        }
        // Resolve only the operator-selected Liquid integration, never credential files.
        let key: string | undefined
        try {
          const provider = await context.provider.get({ providerID: "liquid" })
          const integrationID = provider.data.integrationID
          if (integrationID) {
            const connection = await context.integration.connection.active(integrationID)
            const credential = connection
              ? await context.integration.connection.resolve(connection)
              : undefined
            if (credential?.type === "key") key = credential.key
          }
        } catch {
          // Provider errors may contain sensitive details; use a fixed diagnostic.
          throw new Error("Unable to resolve the saved Liquid API key")
        }
        if (!key?.trim()) throw new Error("No saved Liquid API key or LIQUID_API_KEY available")
        if (signal.aborted) throw new Error("Liquid credential resolution was cancelled")
        return createSystemOneInvoker(config, undefined, key)(state, signal)
      }
    : undefined
  const primary = new SystemOneReviewerBackend(config, undefined, secondaryConfig?.model, invoke)
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
    dispose: async () => {
      await Promise.all([primary.waitForIdle(), secondary?.dispose()])
    },
  }
}
