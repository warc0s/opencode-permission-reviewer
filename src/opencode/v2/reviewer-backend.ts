import { randomBytes } from "node:crypto"
import { rm, unlink } from "node:fs/promises"
import { join } from "node:path"
import type { OpenCodeClient } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import { z } from "zod"
import type { ReviewAttempt } from "../../core/review-attempt.ts"
import type {
  ReviewDecision,
  ReviewEnvelope,
  ReviewExecutionResult,
  ReviewerConfig,
} from "../../types.ts"
import { buildEvidenceResult } from "../../context.ts"
import { buildReviewerPrompt, DEFAULT_TENANT_POLICY, REVIEWER_SYSTEM_PROMPT } from "../../policy.ts"
import { enforceDecision, parseDecision, parseDecisionFromText } from "../../decision.ts"
import { applyEscalationDisposition } from "../../escalation.ts"
import { splitModel } from "../../config.ts"
import { createIsolatedLocation } from "./isolated-location.ts"

type Context = Parameters<Plugin.Plugin["setup"]>[0]
const TOOL = "permission_reviewer_result"
const resultSchema = z
  .object({
    version: z.literal(2),
    outcome: z.enum(["allow", "deny", "escalate"]),
    risk_level: z.enum(["low", "medium", "high", "critical"]),
    user_authorization: z.enum(["high", "medium", "low", "unknown"]),
    scope_alignment: z.enum(["aligned", "partial", "misaligned", "unknown"]),
    evidence_completeness: z.enum(["sufficient", "partial", "insufficient", "unknown"]),
    rationale: z.string().min(3).max(2000),
    confidence: z.number().min(0).max(1),
    script_analysis: z.string().min(20).max(1500).optional(),
  })
  .strict()

interface PendingGeneration {
  attempt: ReviewAttempt
  prompt: string
  structured: boolean
  results: ReviewDecision[]
  closing?: boolean
}

/** Owns auxiliary sessions and host hooks, never operational permission replies. */
export class V2ReviewerBackend {
  private readonly sessions = new Map<string, PendingGeneration>()
  private readonly jobs = new Set<Promise<ReviewExecutionResult>>()
  constructor(
    private readonly ctx: Context,
    private readonly config: ReviewerConfig,
  ) {}

  owns(sessionID: string): boolean {
    return this.sessions.has(sessionID)
  }

  async register(ctx: Context = this.ctx): Promise<() => Promise<void>> {
    const registrations: Array<{ dispose(): Promise<void> }> = []
    registrations.push(
      await ctx.tool.transform((editor) =>
        editor.add({
          name: TOOL,
          description:
            "Return exactly one final permission review decision matching the required schema.",
          options: { codemode: false, permission: TOOL },
          input: resultSchema,
          execute: async (input, execution) => {
            const pending = this.sessions.get(execution.sessionID)
            if (!pending?.attempt.active() || pending.closing || !pending.structured)
              throw new Error("Not an active structured reviewer session")
            const decision = parseDecision(input)
            if (!decision) throw new Error("Invalid review decision")
            pending.results.push(decision)
            if (pending.results.length > 1)
              throw new Error("Multiple review decisions are ambiguous")
            return { content: "Decision captured. Finish without further actions." }
          },
        }),
      ),
    )
    registrations.push(
      await ctx.session.hook("context", (event) => {
        const pending = this.sessions.get(event.sessionID)
        if (!pending) {
          delete event.tools[TOOL]
          return
        }
        if (pending.closing || !pending.attempt.active()) throw new Error("Review no longer active")
        event.system = [
          {
            type: "text",
            text:
              REVIEWER_SYSTEM_PROMPT +
              (pending.structured
                ? `\nReturn the decision using ${TOOL} exactly once, then stop.`
                : ""),
          },
        ]
        event.messages = [{ role: "user", content: [{ type: "text", text: pending.prompt }] }]
        const definition = event.tools[TOOL]
        event.tools =
          pending.structured && pending.results.length === 0 && definition
            ? { [TOOL]: definition }
            : {}
      }),
    )
    registrations.push(
      await ctx.tool.hook("execute.before", (event) => {
        const pending = this.sessions.get(event.sessionID)
        if (pending && (pending.closing || event.tool !== TOOL)) {
          throw new Error("Operational tools are disabled in reviewer sessions")
        }
      }),
    )
    return async () => {
      await Promise.all(registrations.map((registration) => registration.dispose()))
    }
  }

  review(
    envelope: ReviewEnvelope,
    attempt: ReviewAttempt,
    client: OpenCodeClient,
  ): Promise<ReviewExecutionResult> {
    if (this.sessions.size >= 64) throw new Error("Reviewer session cleanup capacity exhausted")
    const job = this.runReview(envelope, attempt, client).finally(() => this.jobs.delete(job))
    this.jobs.add(job)
    return job
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.jobs])
  }

  private async runReview(
    envelope: ReviewEnvelope,
    attempt: ReviewAttempt,
    client: OpenCodeClient,
  ): Promise<ReviewExecutionResult> {
    const { providerID, modelID } = splitModel(this.config.model)
    const id = `ses_${randomBytes(16).toString("hex")}`
    let directory: string | undefined
    let release: (() => void) | undefined
    let dispose: (() => Promise<void>) | undefined
    let createIssued = false
    try {
      const isolated = await createIsolatedLocation(async (context) => {
        dispose = await this.register(context)
        return dispose
      })
      directory = isolated.directory
      release = isolated.release
      await attempt.wait(
        client.plugin.awaitActivation({ location: { directory } }, { signal: attempt.signal }),
      )
      if (!dispose) throw new Error("Reviewer isolation hooks did not activate")
      const catalog = await attempt.wait(
        client.model.list({ location: { directory } }, { signal: attempt.signal }),
      )
      const model = catalog.data.find(
        (item) => item.providerID === providerID && item.id === modelID,
      )
      if (!model) throw new Error("Reviewer model is unavailable")
      if (
        this.config.variant &&
        !model.variants?.some((variant) => variant.id === this.config.variant)
      ) {
        throw new Error("Reviewer variant is unavailable")
      }
      if (this.config.outputFormat === "json_schema" && !model.capabilities.tools) {
        throw new Error("Reviewer model does not support structured tool output")
      }
      const evidence = buildEvidenceResult(envelope, this.config)
      envelope.actionEvidenceComplete =
        envelope.actionEvidenceComplete !== false && evidence.actionEvidenceComplete
      const pending: PendingGeneration = {
        attempt,
        prompt: buildReviewerPrompt(
          this.config.policy ?? DEFAULT_TENANT_POLICY,
          evidence.text,
          this.config.outputFormat,
        ),
        structured: this.config.outputFormat === "json_schema",
        results: [],
      }
      this.sessions.set(id, pending)
      createIssued = true
      const created = await attempt.wait(
        client.session.create(
          {
            id,
            title: "Permission review",
            location: { directory },
            model: {
              id: modelID,
              providerID,
              ...(this.config.variant ? { variant: this.config.variant } : {}),
            },
            permissions: [
              { action: "*", resource: "*", effect: "deny" },
              ...(pending.structured
                ? [{ action: TOOL, resource: "*", effect: "allow" as const }]
                : []),
            ],
          },
          { signal: attempt.signal },
        ),
      )
      if (created.id !== id || created.location.directory !== directory)
        throw new Error("Reviewer session identity or isolation location does not match")
      const tries = pending.structured ? 3 : 2
      for (let index = 0; index < tries; index++) {
        pending.results = []
        const signal = AbortSignal.any([attempt.signal, AbortSignal.timeout(this.config.timeoutMs)])
        const admitted = await attempt.wait(
          client.session.prompt({ sessionID: id, text: pending.prompt }, { signal }),
        )
        await attempt.wait(client.session.wait({ sessionID: id }, { signal }))
        if (!attempt.active()) throw new Error("Review no longer active")
        const messages = await attempt.wait(client.session.context({ sessionID: id }, { signal }))
        // This session is exclusively owned by this attempt, with sequential prompts.
        const userIndex = messages.findIndex((message) => message.id === admitted.id)
        const response = messages
          .slice(userIndex < 0 ? messages.length : userIndex + 1)
          .filter((message) => message.type === "assistant")
        const toolMessages = response
          .map((message) => message.content.filter((part) => part.type === "tool"))
          .filter((parts) => parts.length > 0)
        const toolParts = toolMessages.flat()
        const finalTool = toolParts.at(-1)
        const boundedSchemaRetries =
          toolMessages.every((parts) => parts.length === 1) &&
          toolParts.length <= 3 &&
          toolParts
            .slice(0, -1)
            .every((part) => part.name === TOOL && part.state.status === "error")
        const ambiguous =
          pending.results.length > 1 ||
          (pending.results.length === 1 &&
            (userIndex < 0 ||
              !boundedSchemaRetries ||
              finalTool?.name !== TOOL ||
              finalTool?.state.status !== "completed"))
        const parsed = pending.structured
          ? pending.results.length === 1 && !ambiguous
            ? pending.results[0]
            : undefined
          : parseDecisionFromText(
              response
                .flatMap((message) =>
                  message.content.filter((part) => part.type === "text").map((part) => part.text),
                )
                .join("\n"),
            )
        if (ambiguous) break
        if (parsed)
          return {
            ...enforceDecision(parsed, this.config),
            reviewSessionID: id,
            decisionSource: "llm-reviewer",
          }
        pending.prompt +=
          "\nThe prior response was invalid. Return exactly one valid decision using the requested format."
      }
      return applyEscalationDisposition(
        {
          kind: "escalate",
          reason: "Reviewer returned missing, invalid, or ambiguous output.",
          reviewSessionID: id,
          decisionSource: "failure-safe",
        },
        this.config,
        "invalid-decision",
      )
    } catch (error) {
      return applyEscalationDisposition(
        {
          kind: "escalate",
          reason: error instanceof Error ? error.message : String(error),
          reviewSessionID: id,
          decisionSource: "failure-safe",
        },
        this.config,
        "reviewer-failure",
      )
    } finally {
      // Keep the tool guard until interruption and deletion have settled.
      const pending = this.sessions.get(id)
      if (pending) pending.closing = true
      let cleanupConfirmed = !createIssued
      try {
        if (createIssued) {
          for (let retry = 0; retry < 2 && !cleanupConfirmed; retry++) {
            try {
              await client.session.interrupt(
                { sessionID: id },
                { signal: AbortSignal.timeout(2000) },
              )
              if (this.config.retainReviewSessions) cleanupConfirmed = true
            } catch (error) {
              if ((error as { _tag?: string })?._tag === "SessionNotFoundError")
                cleanupConfirmed = true
            }
            if (!this.config.retainReviewSessions && !cleanupConfirmed) {
              try {
                await client.session.remove(
                  { sessionID: id },
                  { signal: AbortSignal.timeout(2000) },
                )
              } catch {
                // A lost response is not proof that deletion failed or succeeded.
              }
              try {
                await client.session.get({ sessionID: id }, { signal: AbortSignal.timeout(2000) })
              } catch (error) {
                cleanupConfirmed = (error as { _tag?: string })?._tag === "SessionNotFoundError"
              }
            }
          }
          if (!cleanupConfirmed)
            // Cleanup uncertainty must override a provisional allow; the controller fails closed.
            // eslint-disable-next-line no-unsafe-finally
            throw new Error(
              "Reviewer cleanup could not be confirmed; isolation guards remain active",
            )
        }
      } finally {
        if (cleanupConfirmed) this.sessions.delete(id)
        try {
          if (cleanupConfirmed) await dispose?.()
        } finally {
          if (cleanupConfirmed) release?.()
          if (directory && cleanupConfirmed) {
            if (!this.config.retainReviewSessions)
              await rm(directory, { recursive: true, force: true })
            else
              await Promise.all(
                ["index.js", "package.json", "opencode.json"].map((file) =>
                  unlink(join(directory!, file)),
                ),
              )
          }
        }
      }
    }
  }
}
