import { createHash } from "node:crypto"
import type {
  ActorContext,
  CapabilityAssessment,
  DecisionSource,
  EvidenceCompleteness,
  PermissionRequest,
  PolicyTrace,
  ReviewDecision,
  ReviewEnvelope,
  ReviewExecutionResult,
  ReviewAuditRecord,
  ReviewerConfig,
} from "../types.ts"
import { buildEvidence } from "../context.ts"
import {
  DECISION_SCHEMA,
  DECISION_SCHEMA_VERSION,
  enforceDecision,
  parseDecision,
  parseDecisionFromText,
} from "../decision.ts"
import {
  DEFAULT_TENANT_POLICY,
  REVIEWER_PROMPT_VERSION,
  REVIEWER_SYSTEM_PROMPT,
  buildReviewerPrompt,
} from "../policy.ts"
import { emergencyBrakeReason } from "../emergency-brake.ts"
import { evaluatePolicy } from "../policy/policy-engine.ts"
import { splitModel } from "../config.ts"
import { createUiStatus, type ReviewUiStatus } from "../ui-protocol.ts"
import type { SshAuditSummary } from "../ssh-evidence.ts"
import { redactSecrets } from "../redact.ts"
import type { RuntimeContext } from "../opencode/types.ts"
import type { ClientResponse } from "../opencode/types.ts"
import {
  extractStructured,
  extractText,
  isAlreadyResolvedError,
  responseData,
  withTimeout,
} from "../opencode/transport.ts"
import type { EvidenceProvider } from "../evidence/provider.ts"
import { assembleEvidence, defaultEvidenceProviders } from "../context/evidence-assembler.ts"
import { applyEscalationDisposition, type EscalationCategory } from "../escalation.ts"

type Logger = (message: string, details?: unknown) => void

/**
 * Corrective instruction appended to a text-mode parse-failure retry. Text mode
 * has no host-side schema enforcement, so instead of loosening the strict
 * fail-closed extractor (which could auto-approve a draft decision the model
 * later reversed in prose) the coordinator re-prompts once with this note and
 * parses the retry with the same extractor.
 */
const TEXT_MODE_RETRY_NOTE =
  "Your previous response could not be parsed as a decision. Respond again with " +
  "exactly one JSON object conforming to the schema and nothing else — no prose, " +
  "no Markdown code fences, no commentary, and no copy of the schema."

/** Stable hash of the canonical request so audit records for the same action
 *  correlate across runs. Patterns are sorted so event order does not matter.
 *  The per-invocation tool call/message IDs are deliberately excluded: two
 *  identical commands in different sessions or runs must produce the same hash. */
function actionHash(request: PermissionRequest): string {
  const canonical = JSON.stringify({
    permission: request.permission,
    patterns: [...request.patterns].sort(),
    metadata: request.metadata,
  })
  return createHash("sha256").update(canonical).digest("hex")
}

/**
 * Owns the review lifecycle for permission requests: orchestration, the
 * supersede state machine, and the model call. The adapter (transport) and the
 * evidence providers are injected so this class stays focused on ordering and
 * races.
 */
export class ReviewCoordinator {
  private readonly pending = new Map<string, Promise<unknown>>()
  private readonly reviewerSessions = new Set<string>()
  private readonly sshAuditByRequest = new Map<string, SshAuditSummary[]>()
  // Bridge for the resolved actor context, mirroring sshAuditByRequest: the
  // envelope holds it for the reviewer prompt, audit() runs after the model
  // call and reads the per-request bridge so both paths observe the same actor.
  private readonly actorByRequest = new Map<string, ActorContext>()
  // Bridge for the capability assessment: same lifecycle as the actor/sshAudit
  // bridges (set in collectEnvelope, read in audit(), cleared in process).
  private readonly capabilityByRequest = new Map<string, CapabilityAssessment>()
  // Bridge for the policy trace (same lifecycle as the other bridges).
  private readonly policyTraceByRequest = new Map<string, PolicyTrace>()
  // Per-phase timings captured during the review (context/enrichment from the
  // assembler, reviewer/reply from the coordinator). audit() runs last and reads
  // the per-request map so deterministic paths simply omit a phase they skipped.
  private readonly timingsByRequest = new Map<
    string,
    { contextMs?: number; enrichmentMs?: number; reviewerMs?: number; replyMs?: number }
  >()
  // Overall evidence completeness resolved during context assembly.
  private readonly evidenceCompletenessByRequest = new Map<string, EvidenceCompleteness>()
  /**
   * Request IDs that a human (or any other reply source) resolved while the
   * automatic review was still in flight. The in-flight review must then give
   * up silently: no `emit`, no `reply`. OpenCode resolves a request on a
   * first-writer basis, so a late programmatic reply returns 404
   * PermissionNotFoundError — we treat that the same way.
   */
  private readonly resolvedManually = new Set<string>()
  private readonly log: Logger
  private readonly providers: EvidenceProvider[]

  constructor(
    private readonly ctx: RuntimeContext,
    private readonly config: ReviewerConfig,
    logger?: Logger,
    providers?: EvidenceProvider[],
  ) {
    this.log = logger ?? (() => {})
    this.providers = providers ?? defaultEvidenceProviders()
  }

  pendingCount(): number {
    return this.pending.size
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.pending.values()])
  }

  handle(request: PermissionRequest): void {
    if (this.pending.has(request.id)) return

    const task = this.process(request)
      .catch(async (error) => {
        // If the request was answered manually while we were gathering context
        // (or racing with the model), do not resurrect it as "manual" — that
        // would re-prompt the user for a request the server has already closed.
        if (this.isSuperseded(request)) return
        const reason = error instanceof Error ? error.message : String(error)
        const disposed = applyEscalationDisposition(
          {
            kind: "escalate",
            reason,
            decisionSource: "failure-safe",
          },
          this.config,
          "general",
        )
        await this.applyDisposition(request, disposed)
        this.log("review failed; leaving request for manual approval or fail-closed deny", {
          requestID: request.id,
          error: reason,
          kind: disposed.kind,
        })
      })
      .finally(() => {
        this.pending.delete(request.id)
        // Prune so the set cannot grow unboundedly across a long session.
        this.resolvedManually.delete(request.id)
      })
    this.pending.set(request.id, task)
  }

  async process(request: PermissionRequest): Promise<ReviewExecutionResult> {
    const startedAt = Date.now()
    try {
      const result = await this.processRequest(request)
      await this.audit(request, result, startedAt)
      return result
    } catch (error) {
      const disposed = applyEscalationDisposition(
        {
          kind: "escalate",
          reason: error instanceof Error ? error.message : String(error),
          decisionSource: "failure-safe",
        },
        this.config,
        "general",
      )
      await this.audit(request, disposed, startedAt)
      throw error
    } finally {
      this.sshAuditByRequest.delete(request.id)
      this.actorByRequest.delete(request.id)
      this.capabilityByRequest.delete(request.id)
      this.policyTraceByRequest.delete(request.id)
      this.timingsByRequest.delete(request.id)
      this.evidenceCompletenessByRequest.delete(request.id)
    }
  }

  private supersedeResult(): ReviewExecutionResult {
    return {
      kind: "escalate",
      reason: "Request already answered manually; automatic review superseded.",
      decisionSource: "manual-superseded",
    }
  }

  private isSuperseded(request: PermissionRequest): boolean {
    return this.resolvedManually.has(request.id)
  }

  /**
   * Reject a request with `reject` while honoring supersede. Returns `undefined`
   * when the rejection was applied, or the supersede result when the request had
   * already been answered manually (so the caller returns it unchanged).
   */
  private async denyAndReply(
    request: PermissionRequest,
    reason: string,
    decision?: ReviewDecision,
    extras?: Pick<ReviewExecutionResult, "reviewerOutcome" | "escalationDisposition">,
  ): Promise<ReviewExecutionResult | undefined> {
    if (this.isSuperseded(request)) return this.supersedeResult()
    await this.emit(request, "denied", reason, decision, extras?.escalationDisposition)
    if (this.isSuperseded(request)) return this.supersedeResult()
    const accepted = await this.safeReply(request, "reject", reason)
    if (!accepted) return this.supersedeResult()
    return undefined
  }

  /**
   * Apply a fully disposed result (allow / deny / escalate) to UI + reply.
   * This is the single side-effect boundary after logical disposition.
   */
  private async applyDisposition(
    request: PermissionRequest,
    result: ReviewExecutionResult,
  ): Promise<ReviewExecutionResult> {
    if (this.isSuperseded(request)) return this.supersedeResult()

    if (result.kind === "allow") {
      await this.emit(
        request,
        "approved",
        result.reason,
        result.decision,
        result.escalationDisposition,
      )
      const accepted = await this.safeReply(request, "once")
      if (!accepted) return this.supersedeResult()
      return result
    }

    if (result.kind === "deny") {
      const superseded = await this.denyAndReply(request, result.reason, result.decision, {
        ...(result.reviewerOutcome === undefined
          ? {}
          : { reviewerOutcome: result.reviewerOutcome }),
        ...(result.escalationDisposition === undefined
          ? {}
          : { escalationDisposition: result.escalationDisposition }),
      })
      if (superseded) return superseded
      return result
    }

    // Escalate → leave for human. Do not reply.
    if (this.isSuperseded(request)) return this.supersedeResult()
    await this.emit(request, "manual", result.reason, result.decision, result.escalationDisposition)
    this.log("review escalated to user", { requestID: request.id, reason: result.reason })
    return result
  }

  private disposeEscalate(
    result: ReviewExecutionResult,
    category: EscalationCategory = "general",
  ): ReviewExecutionResult {
    return applyEscalationDisposition(result, this.config, category)
  }

  private async processRequest(request: PermissionRequest): Promise<ReviewExecutionResult> {
    await this.emit(request, "reviewing")

    if (this.reviewerSessions.has(request.sessionID)) {
      const reason = "Automatic reviewer sessions may not request additional permissions."
      const decision: ReviewDecision = {
        version: 2,
        outcome: "deny",
        risk_level: "critical",
        user_authorization: "unknown",
        scope_alignment: "unknown",
        evidence_completeness: "unknown",
        rationale: reason,
        confidence: 1,
      }
      return await this.applyDisposition(request, {
        kind: "deny",
        reason,
        decision,
        decisionSource: "emergency-brake",
      })
    }

    const brake = emergencyBrakeReason(request)
    if (brake) {
      const decision: ReviewDecision = {
        version: 2,
        outcome: "deny",
        risk_level: "critical",
        user_authorization: "unknown",
        scope_alignment: "unknown",
        evidence_completeness: "unknown",
        rationale: brake,
        confidence: 1,
      }
      return await this.applyDisposition(request, {
        kind: "deny",
        reason: brake,
        decision,
        decisionSource: "emergency-brake",
      })
    }

    const envelope = await this.collectEnvelope(request)
    if (envelope.preflightDenial) {
      const decision: ReviewDecision = {
        version: 2,
        outcome: "deny",
        risk_level: "high",
        user_authorization: "unknown",
        scope_alignment: "unknown",
        evidence_completeness: "unknown",
        rationale: envelope.preflightDenial,
        confidence: 1,
      }
      return await this.applyDisposition(request, {
        kind: "deny",
        reason: envelope.preflightDenial,
        decision,
        decisionSource: "deterministic-policy",
      })
    }
    // A manual reply arriving during context collection (transcript, git, ssh)
    // supersedes the review before we spend a model call on it.
    if (this.isSuperseded(request)) return this.supersedeResult()

    // Evaluate the declarative policy (deterministic rules, no LLM). In observe
    // mode this produces a trace for audit only; in enforce mode a manual/deny
    // route skips the LLM.
    const policyTrace = evaluatePolicy(
      envelope.capability,
      envelope.actor,
      this.config,
      this.config.policyRules,
    )
    this.policyTraceByRequest.set(request.id, policyTrace)
    envelope.policyTrace = policyTrace
    if (this.config.enforcementMode === "enforce") {
      if (policyTrace.finalRoute === "manual") {
        const reason = `Declarative policy route: manual. ${policyTrace.matchedRules.map((m) => m.reason).join("; ")}`
        const disposed = this.disposeEscalate({
          kind: "escalate",
          reason,
          decisionSource: "deterministic-policy",
        })
        return await this.applyDisposition(request, disposed)
      }
      if (policyTrace.finalRoute === "deny") {
        const reason = `Declarative policy route: deny. ${policyTrace.matchedRules.map((m) => m.reason).join("; ")}`
        const decision: ReviewDecision = {
          version: 2,
          outcome: "deny",
          risk_level: "high",
          user_authorization: "unknown",
          scope_alignment: "unknown",
          evidence_completeness: "unknown",
          rationale: reason,
          confidence: 1,
        }
        return await this.applyDisposition(request, {
          kind: "deny",
          reason,
          decision,
          decisionSource: "deterministic-policy",
        })
      }
    }

    if (this.isSuperseded(request)) return this.supersedeResult()
    const reviewed = await this.runReviewer(envelope)
    if (this.isSuperseded(request)) return this.supersedeResult()

    // runReviewer already applied category-specific knobs (invalid-decision /
    // reviewer-failure) and stamps escalationDisposition when it does. Remaining
    // escalate results (LLM escalate, gates) get the general disposition here.
    const disposed =
      reviewed.kind === "escalate" && reviewed.escalationDisposition === undefined
        ? this.disposeEscalate(reviewed, "general")
        : reviewed

    return await this.applyDisposition(request, disposed)
  }

  handlePermissionReply(event: unknown): void {
    if (typeof event !== "object" || event === null) return
    const record = event as Record<string, unknown>
    if (record.type !== "permission.replied") return
    const properties =
      typeof record.properties === "object" && record.properties !== null
        ? (record.properties as Record<string, unknown>)
        : undefined
    if (!properties || typeof properties.sessionID !== "string") return

    // Any terminal reply (once | always | reject) to a request we are still
    // reviewing means the in-flight review is now superseded. OpenCode always
    // carries requestID (verified against the SDK V2 contract), so we key off
    // it and never fall back to the session (which could cancel sibling reviews).
    if (typeof properties.requestID === "string" && this.pending.has(properties.requestID)) {
      this.resolvedManually.add(properties.requestID)
    }
  }

  /**
   * @deprecated No-op. Approvals no longer annotate tool results so they do not
   * contaminate the primary agent context. Kept for public API compatibility;
   * the plugin no longer registers a host hook that calls this. Rationale
   * remains in audit, TUI, and debug.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  annotateToolResult(callID: string, output: { output?: unknown; metadata?: unknown }): void {
    // Intentionally empty — asymmetric feedback: allow is silent to the agent.
  }

  private async collectEnvelope(request: PermissionRequest): Promise<ReviewEnvelope> {
    const envelope = await assembleEvidence(request, this.providers, {
      client: this.ctx.client,
      directory: this.ctx.directory,
      worktree: this.ctx.worktree,
      config: this.config,
    })
    // Bridge the ssh audit summary from the envelope to the audit() call. The
    // envelope carries sshAudit for the reviewer prompt; audit() runs after the
    // model call and reads the per-request bridge so both the success and the
    // error-path audits observe the same ssh summary.
    this.sshAuditByRequest.set(request.id, envelope.sshAudit)
    if (envelope.actor !== undefined) this.actorByRequest.set(request.id, envelope.actor)
    if (envelope.capability !== undefined) {
      this.capabilityByRequest.set(request.id, envelope.capability)
    }
    if (envelope.timings !== undefined) this.timingsByRequest.set(request.id, envelope.timings)
    if (envelope.evidenceCompleteness !== undefined) {
      this.evidenceCompletenessByRequest.set(request.id, envelope.evidenceCompleteness)
    }
    return envelope
  }

  private async audit(
    request: PermissionRequest,
    result: ReviewExecutionResult,
    startedAt: number,
  ): Promise<void> {
    if (!this.ctx.writeAudit) return
    const decision = result.decision
    const ssh = this.sshAuditByRequest.get(request.id)
    const actor = this.actorByRequest.get(request.id)
    const capability = this.capabilityByRequest.get(request.id)
    const policyTrace = this.policyTraceByRequest.get(request.id)
    const timings = this.timingsByRequest.get(request.id)
    const evidence = this.evidenceCompletenessByRequest.get(request.id)
    // Infer the source when a path did not set it explicitly (the process()
    // catch builds an escalate with no decision): a result still carrying a
    // reviewer decision is an LLM outcome; everything else without an explicit
    // source is a fail-safe escalation.
    const decisionSource: DecisionSource =
      result.decisionSource ?? (decision === undefined ? "failure-safe" : "llm-reviewer")
    const warnings: string[] = []
    if (evidence !== undefined) warnings.push(...evidence.reasons)
    if (capability !== undefined) warnings.push(...capability.analysisWarnings)
    const record: ReviewAuditRecord = {
      schemaVersion: 2,
      decisionSchemaVersion: DECISION_SCHEMA_VERSION,
      promptVersion: REVIEWER_PROMPT_VERSION,
      decisionSource,
      actionHash: actionHash(request),
      reviewerModel: this.config.model,
      timestamp: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedAt),
      requestID: request.id,
      sessionID: request.sessionID,
      permission: request.permission,
      outcome: result.kind,
      reason: result.reason,
      ...(warnings.length === 0 ? {} : { warnings }),
      ...(timings === undefined ? {} : { timings }),
      ...(evidence === undefined ? {} : { evidenceCompleteness: evidence.overall }),
      ...(result.reviewerOutcome === undefined ? {} : { reviewerOutcome: result.reviewerOutcome }),
      ...(result.escalationDisposition === undefined
        ? {}
        : { escalationDisposition: result.escalationDisposition }),
      ...(decision === undefined
        ? {}
        : {
            riskLevel: decision.risk_level,
            userAuthorization: decision.user_authorization,
            scopeAlignment: decision.scope_alignment,
            confidence: decision.confidence,
          }),
      ...(result.reviewSessionID === undefined
        ? {}
        : { reviewerSessionID: result.reviewSessionID }),
      ...(actor === undefined
        ? {}
        : {
            rootSessionID: actor.rootSessionID.value,
            actor: {
              ...(actor.agentName.value === undefined ? {} : { name: actor.agentName.value }),
              ...(actor.mode.value === undefined ? {} : { mode: actor.mode.value }),
              profile: actor.profile.value,
              identityCompleteness: actor.identityCompleteness,
              identitySource: actor.agentName.source,
              confidence: actor.agentName.confidence,
              delegationDepth: actor.delegationDepth.value,
            },
          }),
      ...(!ssh?.length ? {} : { ssh }),
      ...(capability === undefined
        ? {}
        : {
            capability: {
              actionClass: capability.actionClass.value,
              summary: capability.summary,
              parserCompleteness: capability.parserCompleteness,
              ...(capability.executesCode.value === true ? { executesCode: true } : {}),
              ...(capability.createsAdHocCode.value === true ? { createsAdHocCode: true } : {}),
              ...(capability.invokesPackageLifecycleScripts.value === true
                ? { invokesPackageLifecycleScripts: true }
                : {}),
              writeEffects: {
                ...(capability.writeEffects.temporaryWrite.value === true
                  ? { temporaryWrite: true }
                  : {}),
                ...(capability.writeEffects.workspaceWrite.value === true
                  ? { workspaceWrite: true }
                  : {}),
                ...(capability.writeEffects.externalWrite.value === true
                  ? { externalWrite: true }
                  : {}),
                ...(capability.writeEffects.deletion.value === true ? { deletion: true } : {}),
              },
              ...(capability.network.observed.value === true ? { networkObserved: true } : {}),
              ...(capability.process.privilegeEscalation.value === true
                ? { privilegeEscalation: true }
                : {}),
              ...(capability.process.persistence.value === true ? { persistence: true } : {}),
              ...(capability.remote.enabled.value === true ? { remoteEnabled: true } : {}),
              ...(capability.git.possible.value === true ? { gitMutation: true } : {}),
            },
          }),
      ...(policyTrace === undefined
        ? {}
        : {
            policyTrace: {
              effectivePolicyHash: policyTrace.effectivePolicyHash,
              matchedRules: policyTrace.matchedRules,
              finalRoute: policyTrace.finalRoute,
              mode: policyTrace.mode,
            },
          }),
    }
    await this.ctx.writeAudit(record).catch((error) => {
      this.log("failed to write review audit", {
        requestID: request.id,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  private async runReviewer(envelope: ReviewEnvelope): Promise<ReviewExecutionResult> {
    const { providerID, modelID } = splitModel(this.config.model)
    const model = { providerID, modelID }
    let reviewSessionID: string | undefined

    try {
      const created = responseData(
        await this.ctx.client.session.create({
          body: {
            parentID: envelope.request.sessionID,
            title: `[permission-review] ${envelope.request.permission}: ${redactSecrets(
              envelope.request.patterns.join(", "),
            ).slice(0, 120)}`,
          },
          query: { directory: this.ctx.directory },
        }),
        "session.create",
      )
      if (typeof created.id !== "string")
        throw new Error("session.create returned an invalid session ID")
      reviewSessionID = created.id
      this.reviewerSessions.add(reviewSessionID)

      const toolIDs = responseData(
        await this.ctx.client.tool.ids({ query: { directory: this.ctx.directory } }),
        "tool.ids",
      )
      const tools = Object.fromEntries(toolIDs.map((id) => [id, false]))
      const policy = this.config.policy ?? DEFAULT_TENANT_POLICY
      const prompt = buildReviewerPrompt(
        policy,
        buildEvidence(envelope, this.config),
        this.config.outputFormat,
      )

      const first = await this.promptReviewer(reviewSessionID, model, tools, prompt)
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
          model,
          tools,
          prompt,
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
          reason: error instanceof Error ? error.message : String(error),
          ...(reviewSessionID === undefined ? {} : { reviewSessionID }),
          decisionSource: "failure-safe",
        },
        this.config,
        "reviewer-failure",
      )
    } finally {
      if (reviewSessionID !== undefined) {
        this.reviewerSessions.delete(reviewSessionID)
        if (!this.config.retainReviewSessions && this.ctx.client.session.delete) {
          await withTimeout(
            this.ctx.client.session.delete({
              path: { id: reviewSessionID },
              query: { directory: this.ctx.directory },
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
    model: { providerID: string; modelID: string },
    tools: Record<string, boolean>,
    prompt: string,
    retryNote?: string,
  ): Promise<{ response: ClientResponse<Record<string, unknown>>; ms: number }> {
    const start = performance.now()
    const response = await withTimeout(
      this.ctx.client.session.prompt({
        path: { id: reviewSessionID },
        query: { directory: this.ctx.directory },
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
    )
    return { response, ms: performance.now() - start }
  }

  /** Fold the reviewer phase's elapsed time into the request's timing record. */
  private recordReviewerMs(envelope: ReviewEnvelope, reviewerMs: number): void {
    const currentTimings = this.timingsByRequest.get(envelope.request.id) ?? {}
    this.timingsByRequest.set(envelope.request.id, { ...currentTimings, reviewerMs })
  }

  /**
   * Send a permission reply. Returns `true` on success, `false` when the
   * request was already resolved by another source (human TUI, a duplicate
   * event, etc.) so the caller can treat itself as superseded. Other errors
   * (transport failure, malformed reply) are still thrown.
   */
  private async safeReply(
    request: PermissionRequest,
    reply: "once" | "reject",
    message?: string,
  ): Promise<boolean> {
    const replyStart = performance.now()
    const response = await this.ctx.permissionReply({
      path: { requestID: request.id },
      body: {
        reply,
        ...(message === undefined ? {} : { message: `[Automatic permission review] ${message}` }),
      },
      query: { directory: this.ctx.directory },
    })
    const replyMs = performance.now() - replyStart
    const currentTimings = this.timingsByRequest.get(request.id) ?? {}
    this.timingsByRequest.set(request.id, { ...currentTimings, replyMs })
    if (response.error !== undefined) {
      if (isAlreadyResolvedError(response.error)) {
        this.resolvedManually.add(request.id)
        this.log("review reply rejected because the request was already resolved", {
          requestID: request.id,
          error: response.error,
        })
        return false
      }
      throw new Error(`permission.reply failed: ${JSON.stringify(response.error)}`)
    }
    return true
  }

  private async emit(
    request: PermissionRequest,
    phase: ReviewUiStatus["phase"],
    reason?: string,
    decision?: ReviewDecision,
    escalationDisposition?: ReviewExecutionResult["escalationDisposition"],
  ): Promise<void> {
    if (!this.ctx.publishUiStatus) return
    const actor = this.actorByRequest.get(request.id)
    const status = createUiStatus(request, phase, {
      model: this.config.model,
      variant: this.config.variant,
      timeoutMs: this.config.timeoutMs,
      ...(reason === undefined ? {} : { reason }),
      ...(decision === undefined ? {} : { decision }),
      ...(escalationDisposition === undefined ? {} : { escalationDisposition }),
      ...(actor?.agentName.value === undefined ? {} : { actorName: actor.agentName.value }),
      ...(actor === undefined ? {} : { actorProfile: actor.profile.value }),
    })
    // Status publishing is best-effort: a TUI failure must not fail the review.
    try {
      const response = await this.ctx.publishUiStatus(status)
      // Both publish paths resolve with `{ data, error }`; a failure arrives as
      // an `error` field rather than a rejection (the raw fallback can reject
      // too, caught below).
      if (
        response &&
        typeof response === "object" &&
        "error" in response &&
        (response as { error?: unknown }).error !== undefined
      ) {
        this.log("failed to publish reviewer UI status", {
          requestID: request.id,
          phase,
          error: JSON.stringify((response as { error: unknown }).error),
        })
      }
    } catch (error) {
      this.log("failed to publish reviewer UI status", {
        requestID: request.id,
        phase,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
