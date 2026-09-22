import { createHash, randomUUID } from "node:crypto"
import type {
  DecisionSource,
  PermissionRequest,
  ReviewDecision,
  ReviewEnvelope,
  ReviewExecutionResult,
  ReviewAuditRecord,
  ReviewerConfig,
} from "../types.ts"
import { DECISION_SCHEMA_VERSION } from "../decision.ts"
import { REVIEWER_PROMPT_VERSION } from "../policy.ts"
import { isSystemOneReviewerModel, reviewBudgetMs } from "../config.ts"
import { evaluateReview } from "./review-engine.ts"
import { ReviewAttempt } from "./review-attempt.ts"
import { ReviewLimiter } from "./review-limiter.ts"
import { createV1ContextReader } from "../opencode/v1/context-reader.ts"
import { createV1ReviewerBackend, type V1ReviewBackend } from "../opencode/v1/backend-factory.ts"
import { createUiStatus, type ReviewUiStatus } from "../ui-protocol.ts"
import type { RuntimeContext } from "../opencode/types.ts"
import { isAlreadyResolvedError, withTimeout } from "../opencode/transport.ts"
import type { EvidenceProvider } from "../evidence/provider.ts"
import { assembleEvidence, defaultEvidenceProviders } from "../context/evidence-assembler.ts"
import type { AskDecisionSource } from "../context/ask-decisions.ts"
import { applyEscalationDisposition } from "../escalation.ts"
import { formatFailureReason } from "../failure-reason.ts"
import packageInfo from "../../package.json"
import { ScriptAnalysisRegistry } from "../verified-ssh-script.ts"

type Logger = (message: string, details?: unknown) => void

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
  private readonly generation = randomUUID()
  private readonly attempts = new Map<string, ReviewAttempt>()
  private stopped = false
  private readonly limiter = new ReviewLimiter()
  private readonly pending = new Map<string, Promise<unknown>>()
  private readonly backend: V1ReviewBackend
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
  private readonly scriptRegistry = new ScriptAnalysisRegistry()
  /** Live ask-decision capture (enrichment-only; undefined when disabled). */
  private readonly askDecisions: AskDecisionSource | undefined
  /** Bound for metadata SDK calls (session create, tool listing, replies,
   *  status publishing): a hung call must never leave a review pending
   *  forever; the reviewer prompt keeps its own full timeout budget. */
  private readonly metadataCallTimeoutMs: number

  constructor(
    private readonly ctx: RuntimeContext,
    private readonly config: ReviewerConfig,
    logger?: Logger,
    providers?: EvidenceProvider[],
    askDecisions?: AskDecisionSource,
  ) {
    this.log = logger ?? (() => {})
    this.backend = createV1ReviewerBackend(ctx, config, this.log, (envelope, ms) =>
      this.recordReviewerMs(envelope, ms),
    )
    this.providers = providers ?? defaultEvidenceProviders()
    this.askDecisions = askDecisions
    this.metadataCallTimeoutMs = Math.min(this.config.timeoutMs, 10_000)
  }

  pendingCount(): number {
    return this.pending.size
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.pending.values()])
  }

  async dispose(): Promise<void> {
    this.stopped = true
    for (const attempt of this.attempts.values()) attempt.close("cancelled")
    await withTimeout(Promise.all([this.waitForIdle(), this.backend.waitForIdle()]), 12_000).catch(
      (error) => this.log("Reviewer shutdown timed out", String(error)),
    )
  }

  handle(request: PermissionRequest): void {
    if (this.stopped) return
    if (this.pending.has(request.id)) return

    const task = this.process(request)
      .catch((error) => {
        this.log("review failed; the attempt recorded its failure disposition", {
          requestID: request.id,
          error: error instanceof Error ? error.message : String(error),
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
    const attempt = new ReviewAttempt(this.generation, reviewBudgetMs(this.config))
    this.attempts.set(request.id, attempt)
    let release: (() => void) | undefined
    try {
      release = await this.limiter.acquire(attempt.signal)
      const result = await attempt.wait(this.processRequest(request))
      await this.audit(request, result, startedAt)
      return result
    } catch (error) {
      if (this.isSuperseded(request)) {
        const result = this.supersedeResult()
        await this.audit(request, result, startedAt)
        return result
      }
      const disposed = applyEscalationDisposition(
        {
          kind: "escalate",
          reason: formatFailureReason("review coordination", error),
          decisionSource: "failure-safe",
        },
        this.config,
        "general",
      )
      try {
        if (attempt.application === "unknown" || !attempt.active())
          await this.emit(request, "unknown", disposed.reason)
        else await this.applyDisposition(request, disposed)
      } catch (applicationError) {
        this.log("failure disposition could not be confirmed", String(applicationError))
      }
      await this.audit(request, disposed, startedAt)
      throw error
    } finally {
      attempt.close("finished")
      this.attempts.delete(request.id)
      release?.()
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
    return this.stopped || this.resolvedManually.has(request.id)
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
    extras?: Pick<
      ReviewExecutionResult,
      "reviewerOutcome" | "escalationDisposition" | "reviewerModel"
    >,
  ): Promise<ReviewExecutionResult | undefined> {
    if (this.isSuperseded(request)) return this.supersedeResult()
    const accepted = await this.safeReply(request, "reject", reason)
    if (!accepted) return this.supersedeResult()
    // Publish the terminal phase only after OpenCode accepted the reply: the
    // UI must not claim a denial that the server never recorded.
    await this.emit(
      request,
      "denied",
      reason,
      decision,
      extras?.escalationDisposition,
      extras?.reviewerModel,
    )
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
      const accepted = await this.safeReply(request, "once")
      if (!accepted) return this.supersedeResult()
      // Publish the terminal phase only after OpenCode accepted the reply: the
      // UI must not claim an approval that the server never recorded.
      await this.emit(
        request,
        "approved",
        result.reason,
        result.decision,
        result.escalationDisposition,
        result.reviewerModel,
      )
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
        ...(result.reviewerModel === undefined ? {} : { reviewerModel: result.reviewerModel }),
      })
      if (superseded) return superseded
      return result
    }

    // Escalate → leave for human. Do not reply.
    if (this.isSuperseded(request)) return this.supersedeResult()
    await this.emit(
      request,
      "manual",
      result.reason,
      result.decision,
      result.escalationDisposition,
      result.reviewerModel,
    )
    this.log("review escalated to user", { requestID: request.id, reason: result.reason })
    return result
  }

  private async processRequest(request: PermissionRequest): Promise<ReviewExecutionResult> {
    const attempt = this.attempts.get(request.id)!
    await this.emit(request, "reviewing")
    const result = await evaluateReview(request, this.config, {
      collect: (pending) => this.collectEnvelope(pending),
      review: (envelope) => this.runReviewer(envelope),
      active: () => attempt.active() && !this.isSuperseded(request),
      auxiliarySession: (sessionID) => this.backend.owns(sessionID),
      observe: (envelope) => {
        if (envelope.policyTrace !== undefined) {
          this.remember(request.id, { policyTrace: envelope.policyTrace })
        }
      },
    })
    if (!attempt.active()) return this.supersedeResult()
    const applied = await this.applyDisposition(request, result)
    if (applied.kind === "allow")
      this.scriptRegistry.rememberApproved(
        this.attempts.get(request.id)?.evidence.verifiedScript,
        applied.decision,
      )
    return applied
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

    // While our reply is in transport, its event can precede its acknowledgement.
    // Only the transport can distinguish our accepted reply from a competing
    // human reply. Before that phase, a terminal event supersedes the review.
    if (typeof properties.requestID === "string" && this.pending.has(properties.requestID)) {
      const attempt = this.attempts.get(properties.requestID)
      if (attempt?.application === "unknown" || attempt?.application === "reply-accepted") return
      this.resolvedManually.add(properties.requestID)
      attempt?.close("cancelled")
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
      client: createV1ContextReader(this.ctx.client, this.attempts.get(request.id)?.signal),
      directory: this.ctx.directory,
      worktree: this.ctx.worktree,
      config: this.config,
      scriptRegistry: this.scriptRegistry,
      ...(this.askDecisions === undefined ? {} : { askDecisions: this.askDecisions }),
    })
    if (!this.attempts.get(request.id)?.active()) return envelope
    // Bridge the ssh audit summary from the envelope to the audit() call. The
    // envelope carries sshAudit for the reviewer prompt; audit() runs after the
    // model call and reads the per-request bridge so both the success and the
    // error-path audits observe the same ssh summary.
    this.remember(request.id, { sshAudit: envelope.sshAudit })
    if (envelope.actor !== undefined) this.remember(request.id, { actor: envelope.actor })
    if (envelope.capability !== undefined) {
      this.remember(request.id, { capability: envelope.capability })
    }
    if (envelope.timings !== undefined) this.remember(request.id, { timings: envelope.timings })
    if (envelope.evidenceCompleteness !== undefined) {
      this.remember(request.id, { evidenceCompleteness: envelope.evidenceCompleteness })
    }
    if (envelope.verifiedScript !== undefined)
      this.remember(request.id, { verifiedScript: envelope.verifiedScript })
    if (envelope.askDecisions !== undefined && envelope.askDecisions.length > 0) {
      this.remember(request.id, { askDecisions: envelope.askDecisions })
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
    const ssh = this.attempts.get(request.id)?.evidence.sshAudit
    const actor = this.attempts.get(request.id)?.evidence.actor
    const capability = this.attempts.get(request.id)?.evidence.capability
    const policyTrace = this.attempts.get(request.id)?.evidence.policyTrace
    const timings = this.attempts.get(request.id)?.evidence.timings
    const evidence = this.attempts.get(request.id)?.evidence.evidenceCompleteness
    const verifiedScript = this.attempts.get(request.id)?.evidence.verifiedScript
    const askDecisions = this.attempts.get(request.id)?.evidence.askDecisions
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
      schemaVersion: 3,
      reviewID: this.attempts.get(request.id)!.id,
      hostRequestID: request.id,
      hostGeneration: "v1",
      hostVersion: this.ctx.hostVersion ?? "unknown",
      generation: this.generation,
      directory: this.ctx.directory,
      nativeAction: request.permission,
      pluginVersion: packageInfo.version,
      effectiveConfigHash: createHash("sha256").update(JSON.stringify(this.config)).digest("hex"),
      actionFingerprint: "v1:" + actionHash(request),
      application: this.isSuperseded(request)
        ? "superseded"
        : (this.attempts.get(request.id)?.application ?? "unknown"),
      decisionSchemaVersion: DECISION_SCHEMA_VERSION,
      promptVersion: REVIEWER_PROMPT_VERSION,
      decisionSource,
      actionHash: actionHash(request),
      reviewerModel: result.reviewerModel ?? this.config.model,
      ...(result.reviewerEscalatedFrom === undefined
        ? {}
        : { reviewerEscalatedFrom: result.reviewerEscalatedFrom }),
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
      ...(verifiedScript === undefined
        ? {}
        : {
            verifiedScript: {
              sha256: verifiedScript.sha256,
              status: verifiedScript.status,
              ...(verifiedScript.bytes === undefined ? {} : { bytes: verifiedScript.bytes }),
            },
          }),
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
              ...(capability.credentialRead.value === true ? { credentialRead: true } : {}),
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
      ...(askDecisions === undefined
        ? {}
        : {
            askDecisions: askDecisions
              .slice(-5)
              .map((d) => ({ at: d.at, question: d.question, answer: d.answer })),
          }),
    }
    await this.ctx.writeAudit(record).catch((error) => {
      this.log("failed to write review audit", {
        requestID: request.id,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  private runReviewer(envelope: ReviewEnvelope): Promise<ReviewExecutionResult> {
    return this.backend.review(envelope, this.attempts.get(envelope.request.id)!)
  }

  private remember(requestID: string, evidence: ReviewAttempt["evidence"]): void {
    const attempt = this.attempts.get(requestID)
    if (attempt?.active()) Object.assign(attempt.evidence, evidence)
  }

  /** Fold the reviewer phase's elapsed time into the request's timing record. */
  private recordReviewerMs(envelope: ReviewEnvelope, reviewerMs: number): void {
    if (!this.attempts.get(envelope.request.id)?.active()) return
    const currentTimings = this.attempts.get(envelope.request.id)?.evidence.timings ?? {}
    this.remember(envelope.request.id, { timings: { ...currentTimings, reviewerMs } })
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
    const attempt = this.attempts.get(request.id)
    if (!attempt?.active()) return false
    attempt.application = "unknown"
    const response = await withTimeout(
      this.ctx.permissionReply({
        path: { requestID: request.id },
        body: {
          reply,
          ...(message === undefined ? {} : { message: `[Automatic permission review] ${message}` }),
        },
        query: { directory: this.ctx.directory },
      }),
      this.metadataCallTimeoutMs,
    )
    const replyMs = performance.now() - replyStart
    const currentTimings = this.attempts.get(request.id)?.evidence.timings ?? {}
    this.remember(request.id, { timings: { ...currentTimings, replyMs } })
    if (response.error !== undefined) {
      if (isAlreadyResolvedError(response.error)) {
        attempt.application = "superseded"
        this.resolvedManually.add(request.id)
        this.log("review reply rejected because the request was already resolved", {
          requestID: request.id,
          error: response.error,
        })
        return false
      }
      throw new Error(`permission.reply failed: ${JSON.stringify(response.error)}`)
    }
    attempt.application = "reply-accepted"
    return true
  }

  private async emit(
    request: PermissionRequest,
    phase: ReviewUiStatus["phase"],
    reason?: string,
    decision?: ReviewDecision,
    escalationDisposition?: ReviewExecutionResult["escalationDisposition"],
    reviewerModel?: string,
  ): Promise<void> {
    if (!this.ctx.publishUiStatus) return
    const actor = this.attempts.get(request.id)?.evidence.actor
    const status = createUiStatus(request, phase, {
      model: reviewerModel ?? this.config.model,
      variant:
        reviewerModel && reviewerModel !== this.config.model
          ? (this.config.escalationReviewer?.variant ?? this.config.variant)
          : isSystemOneReviewerModel(this.config.model)
            ? "system-one"
            : this.config.variant,
      timeoutMs: reviewBudgetMs(this.config),
      ...(reason === undefined ? {} : { reason }),
      ...(decision === undefined ? {} : { decision }),
      ...(escalationDisposition === undefined ? {} : { escalationDisposition }),
      ...(actor?.agentName.value === undefined ? {} : { actorName: actor.agentName.value }),
      ...(actor === undefined ? {} : { actorProfile: actor.profile.value }),
    })
    // Status publishing is best-effort: a TUI failure must not fail the review,
    // and a hung publish must not stall the review pipeline either.
    try {
      const response = await withTimeout(
        this.ctx.publishUiStatus(status),
        Math.min(this.metadataCallTimeoutMs, 5_000),
      )
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
