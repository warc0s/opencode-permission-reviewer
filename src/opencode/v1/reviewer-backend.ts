import type { ReviewEnvelope, ReviewExecutionResult, ReviewerConfig } from "../../types.ts"
import type { RuntimeContext, ClientResponse } from "../types.ts"
import type { ReviewAttempt } from "../../core/review-attempt.ts"
import { buildEvidenceResult } from "../../context.ts"
import {
  DECISION_SCHEMA,
  enforceDecision,
  parseDecision,
  parseDecisionFromText,
} from "../../decision.ts"
import { DEFAULT_TENANT_POLICY, REVIEWER_SYSTEM_PROMPT, buildReviewerPrompt } from "../../policy.ts"
import { splitModel } from "../../config.ts"
import { redactSecrets } from "../../redact.ts"
import { extractStructured, extractText, responseData, withTimeout } from "../transport.ts"
import { applyEscalationDisposition } from "../../escalation.ts"
import { formatFailureReason } from "../../failure-reason.ts"

/**
 * Corrective instruction appended to a text-mode parse-failure retry. Text mode
 * has no host-side schema enforcement, so instead of loosening the strict
 * fail-closed extractor (which could auto-approve a draft decision the model
 * later reversed in prose) the coordinator re-prompts once with this note and
 * parses the retry with the same extractor.
 */
const TEXT_MODE_RETRY_NOTE =
  "Your previous response could not be parsed as a decision. Respond again with " +
  "exactly one JSON object conforming to the schema and nothing else - no prose, " +
  "no Markdown code fences, no commentary, and no copy of the schema."

/** Owns isolated reviewer sessions, model calls, and their bounded cleanup. */
export class V1ReviewerBackend {
  private readonly reviewerSessions = new Set<string>()
  private readonly jobs = new Set<Promise<ReviewExecutionResult>>()
  private isolatedReviewerDirectory: string | undefined
  private readonly metadataCallTimeoutMs: number
  constructor(
    private readonly ctx: RuntimeContext,
    private readonly config: ReviewerConfig,
    private readonly log: (message: string, details?: unknown) => void,
    private readonly recordReviewerMs: (envelope: ReviewEnvelope, ms: number) => void,
  ) {
    this.metadataCallTimeoutMs = Math.min(config.timeoutMs, 10_000)
  }

  owns(sessionID: string): boolean {
    return this.reviewerSessions.has(sessionID)
  }

  review(envelope: ReviewEnvelope, attempt: ReviewAttempt): Promise<ReviewExecutionResult> {
    const job = this.runReview(envelope, attempt).finally(() => this.jobs.delete(job))
    this.jobs.add(job)
    return job
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.jobs])
  }

  /**
   * Resolve (and create once) the scratch directory reviewer sessions run in.
   * The directory has no AGENTS.md/CLAUDE.md and no project config, so the
   * host only loads the user's trusted global instructions for the reviewer
   * session. Returns undefined when the directory cannot be created so the
   * caller fails into the configured reviewer-error disposition.
   */
  private async reviewerSessionDirectory(): Promise<string | undefined> {
    if (this.isolatedReviewerDirectory !== undefined) return this.isolatedReviewerDirectory
    try {
      const { mkdir } = await import("node:fs/promises")
      const { expandHome } = await import("../../audit.ts")
      const base =
        this.ctx.reviewerDirectoryBase ?? "~/.local/share/opencode/permission-reviewer-isolated"
      const directory = expandHome(base)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      this.isolatedReviewerDirectory = directory
      return directory
    } catch (error) {
      this.log("could not create the isolated reviewer directory", {
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  /** Create an instruction-isolated session or fail into the configured error route. */
  private async createReviewerSession(
    envelope: ReviewEnvelope,
    isolated: string | undefined,
    signal: AbortSignal,
  ): Promise<{ id: string; directory: string }> {
    if (isolated === undefined) throw new Error("reviewer isolation unavailable")
    const title = `[permission-review] ${envelope.request.permission}: ${redactSecrets(
      envelope.request.patterns.join(", "),
    ).slice(0, 120)}`
    const create = async (directory: string) => {
      signal.throwIfAborted()
      const created = responseData(
        await withTimeout(
          this.ctx.client.session.create({
            signal,
            body: {
              title,
            },
            query: { directory },
          }),
          this.metadataCallTimeoutMs,
        ),
        "session.create",
      )
      if (typeof created.id !== "string")
        throw new Error("session.create returned an invalid session ID")
      return created.id
    }

    return { id: await create(isolated), directory: isolated }
  }

  private async runReview(
    envelope: ReviewEnvelope,
    attempt: ReviewAttempt,
  ): Promise<ReviewExecutionResult> {
    const { providerID, modelID } = splitModel(this.config.model)
    const model = { providerID, modelID }
    let reviewSessionID: string | undefined
    let sessionDirectory: string | undefined

    try {
      // Never review inside the project if instruction isolation fails.
      const isolated = await this.reviewerSessionDirectory()
      const created = await this.createReviewerSession(envelope, isolated, attempt.signal)
      sessionDirectory = created.directory
      reviewSessionID = created.id
      this.reviewerSessions.add(reviewSessionID)

      const toolIDs = responseData(
        await withTimeout(
          this.ctx.client.tool.ids({
            query: { directory: sessionDirectory },
            signal: attempt.signal,
          }),
          this.metadataCallTimeoutMs,
        ),
        "tool.ids",
      )
      // Deny every named tool AND everything else via the wildcard: the host
      // turns each entry into a session permission rule, and session rules
      // take precedence over agent-config allows. A plain name list is not
      // enough - MCP tools (registered outside the tool registry) and the MCP
      // resource tools would keep executing under host-configured allows. The
      // wildcard key covers unknown operational tools, including MCP tools.
      // The host filters StructuredOutput through the same permission rules.
      const tools: Record<string, boolean> = { "*": false }
      for (const id of toolIDs) tools[id] = false
      if (this.config.outputFormat === "json_schema") {
        delete tools.StructuredOutput
        tools.StructuredOutput = true
      }
      const policy = this.config.policy ?? DEFAULT_TENANT_POLICY
      const evidence = buildEvidenceResult(envelope, this.config)
      envelope.actionEvidenceComplete =
        envelope.actionEvidenceComplete !== false && evidence.actionEvidenceComplete
      const prompt = buildReviewerPrompt(policy, evidence.text, this.config.outputFormat)

      const first = await this.promptReviewer(
        reviewSessionID,
        sessionDirectory,
        model,
        tools,
        prompt,
        attempt,
      )
      let reviewerMs = first.ms
      // Record the elapsed time as soon as the reviewer returns, so a response
      // that turns out to be invalid (no data / transport error) still carries
      // reviewerMs in the audit before responseData throws below.
      this.recordReviewerMs(envelope, reviewerMs)
      const data = responseData(first.response, "session.prompt")
      const parsed =
        this.config.outputFormat === "text"
          ? parseDecisionFromText(extractText(data) ?? "")
          : parseDecision(extractStructured(data))

      // Text mode has no host-side schema enforcement or retry (unlike
      // json_schema's `retryCount: 2`), so a single flaky response would
      // escalate. Re-prompt once with a corrective note. The retry still goes
      // through the same strict extractor and enforceDecision invariants, so it
      // can never approve anything the first parse would not; it only reduces
      // spurious escalations from weaker models. Structured mode is left alone
      // because OpenCode already retries it.
      if (!parsed && this.config.outputFormat === "text") {
        const retry = await this.promptReviewer(
          reviewSessionID,
          sessionDirectory,
          model,
          tools,
          prompt,
          attempt,
          TEXT_MODE_RETRY_NOTE,
        )
        reviewerMs += retry.ms
        this.recordReviewerMs(envelope, reviewerMs)
        const retryData = responseData(retry.response, "session.prompt")
        const retryParsed = parseDecisionFromText(extractText(retryData) ?? "")
        // The retry output is authoritative for the escalation decision: if it
        // parsed, use it; otherwise fall through to the manual-review path.
        if (retryParsed !== undefined) {
          return {
            ...enforceDecision(retryParsed, this.config),
            reviewSessionID,
            decisionSource: "llm-reviewer",
          }
        }
      }

      if (!parsed) {
        return applyEscalationDisposition(
          {
            kind: "escalate",
            reason:
              this.config.outputFormat === "text"
                ? "Reviewer returned missing, invalid, or unparseable text output."
                : "Reviewer returned missing or invalid structured output.",
            reviewSessionID,
            decisionSource: "failure-safe",
          },
          this.config,
          "invalid-decision",
        )
      }
      return {
        ...enforceDecision(parsed, this.config),
        reviewSessionID,
        decisionSource: "llm-reviewer",
      }
    } catch (error) {
      return applyEscalationDisposition(
        {
          kind: "escalate",
          reason: formatFailureReason("reviewer backend", error),
          ...(reviewSessionID === undefined ? {} : { reviewSessionID }),
          decisionSource: "failure-safe",
        },
        this.config,
        "reviewer-failure",
      )
    } finally {
      if (reviewSessionID !== undefined) {
        if (this.ctx.client.session.abort) {
          await withTimeout(
            this.ctx.client.session.abort({
              path: { id: reviewSessionID },
              query: { directory: sessionDirectory },
            }),
            5000,
          ).catch(() => {})
        }
        this.reviewerSessions.delete(reviewSessionID)
        if (!this.config.retainReviewSessions && this.ctx.client.session.delete) {
          await withTimeout(
            this.ctx.client.session.delete({
              path: { id: reviewSessionID },
              query: { directory: sessionDirectory ?? this.ctx.directory },
            }),
            Math.min(this.config.timeoutMs, 5_000),
          ).catch(() => {})
        }
      }
    }
  }

  /**
   * Issue a single reviewer prompt in the review session and return the raw
   * response plus its elapsed time. `responseData` is applied by the caller so
   * the caller can record the elapsed time even when the response is invalid.
   * The role/safety rules live in the system prompt so they carry system-level
   * priority over the untrusted evidence; the per-request part (and an optional
   * corrective retry note) is appended as user content.
   */
  private async promptReviewer(
    reviewSessionID: string,
    sessionDirectory: string,
    model: { providerID: string; modelID: string },
    tools: Record<string, boolean>,
    prompt: string,
    attempt: ReviewAttempt,
    retryNote?: string,
  ): Promise<{ response: ClientResponse<Record<string, unknown>>; ms: number }> {
    const start = performance.now()
    attempt.signal.throwIfAborted()
    const response = await attempt.wait(
      withTimeout(
        this.ctx.client.session.prompt({
          signal: attempt.signal,
          path: { id: reviewSessionID },
          query: { directory: sessionDirectory },
          body: {
            model,
            variant: this.config.variant,
            tools,
            system: REVIEWER_SYSTEM_PROMPT,
            format:
              this.config.outputFormat === "text"
                ? { type: "text" }
                : {
                    type: "json_schema",
                    schema: DECISION_SCHEMA,
                    retryCount: 2,
                  },
            parts:
              retryNote === undefined
                ? [{ type: "text", text: prompt }]
                : [
                    { type: "text", text: prompt },
                    { type: "text", text: retryNote },
                  ],
          },
        }),
        this.config.timeoutMs,
      ),
    )
    return { response, ms: performance.now() - start }
  }
}
