import { createHash, randomUUID } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import type { OpenCodeEvent } from "@opencode/client"
import { loadResolvedConfig } from "../../config/loader.ts"
import { reviewBudgetMs } from "../../config.ts"
import { createAuditWriter } from "../../audit.ts"
import { applyEscalationDisposition } from "../../escalation.ts"
import { formatFailureReason } from "../../failure-reason.ts"
import { assembleEvidence, defaultEvidenceProviders } from "../../context/evidence-assembler.ts"
import { ReviewAttempt } from "../../core/review-attempt.ts"
import { evaluateReview } from "../../core/review-engine.ts"
import { createUiStatus, type ReviewUiStatus } from "../../ui-protocol.ts"
import { ReviewerRpc } from "../../ui/rpc.ts"
import type { ReviewEnvelope, ReviewExecutionResult } from "../../types.ts"
import { connectV2Host } from "./connection.ts"
import { createV2ContextReader } from "./context-reader.ts"
import { normalizeV2Permission } from "./permission-codec.ts"
import { V2ReviewerBackend } from "./reviewer-backend.ts"
import { withTimeout } from "../transport.ts"
import { V2AskDecisions } from "./event-codec.ts"
import { REVIEWER_PROMPT_VERSION } from "../../policy.ts"
import { satisfies } from "semver"
import packageInfo from "../../../package.json"
import { SUPPORTED_V2_RANGE } from "../host-guard.ts"
import { ScriptAnalysisRegistry } from "../../verified-ssh-script.ts"

type Context = Parameters<Plugin.Plugin["setup"]>[0]

export async function setup(ctx: Context): Promise<() => Promise<void>> {
  return setupWithServices(ctx, {
    loadConfig: loadResolvedConfig,
    connect: connectV2Host,
    createBackend: (context, config) => new V2ReviewerBackend(context, config),
  })
}

/** Host effects are injectable without changing the plugin entry contract. */
export async function setupWithServices(
  ctx: Context,
  services: {
    loadConfig: typeof loadResolvedConfig
    connect: typeof connectV2Host
    createBackend(
      context: Context,
      config: ReturnType<typeof loadResolvedConfig>,
    ): Pick<V2ReviewerBackend, "owns" | "review" | "waitForIdle">
  },
): Promise<() => Promise<void>> {
  if (!satisfies(ctx.app.version, SUPPORTED_V2_RANGE))
    throw new Error(
      `Unsupported OpenCode V2 host ${ctx.app.version}; supported range is ${SUPPORTED_V2_RANGE}`,
    )
  const directory = ctx.location.directory
  const config = services.loadConfig(ctx.options, directory, "unknown")
  const generation = randomUUID()
  const identity = randomUUID()
  const backend = services.createBackend(ctx, config)
  const scriptRegistry = new ScriptAnalysisRegistry()
  const askDecisions = config.askDecisions ? new V2AskDecisions() : undefined
  const requests = new Map<
    string,
    { attempt: ReviewAttempt; sessionID: string; work?: Promise<void> }
  >()
  const tools = new Map<string, { input: unknown }>()
  const notifications = new Set<Promise<unknown>>()
  const notify = (operation: () => Promise<unknown>) => {
    if (notifications.size >= 256) {
      log("Review notification capacity exhausted; notification omitted")
      return
    }
    const pending = Promise.resolve()
      .then(operation)
      .catch((error) => log("Review notification failed", String(error)))
      .finally(() => notifications.delete(pending))
    notifications.add(pending)
  }
  const statuses = new Map<string, ReviewUiStatus>()
  let revision = 0
  let disposed = false
  let cleanupStarted = false
  let eventStreamHealthy = true
  let connectionState: "not-probed" | "verified" | "failed" = "not-probed"
  const subscription = new AbortController()
  const log = (message: string, details?: unknown) =>
    console.error(`[opencode-permission-reviewer] ${message}`, details ?? "")
  const audit = createAuditWriter(config, log)
  const effectiveConfigHash = createHash("sha256").update(JSON.stringify(config)).digest("hex")
  const registrations: Array<{ dispose(): Promise<void> }> = []
  const rpc = await ctx.rpc.register(ReviewerRpc, {
    identity: async () => identity,
    status: async () => ({
      host: "v2",
      hostVersion: ctx.app.version,
      generation,
      directory,
      adapter: "permission.evaluate",
      backend: "v2-isolated-session",
      active: !disposed,
      pending: requests.size,
      revision,
      outputFormat: config.outputFormat,
      model: config.model,
      variant: config.variant,
      configDegraded: config.configDegraded ?? [],
      effectiveConfigHash,
      connection: connectionState,
      eventConnection: eventStreamHealthy ? "connected" : "unavailable",
      capabilities: { structuredTool: true, text: true, retention: true, nativeJsonSchema: false },
    }),
    snapshot: async () => ({ generation, revision, directory, reviews: [...statuses.values()] }),
  })
  registrations.push(rpc)
  const publish = async (status: ReviewUiStatus) => {
    statuses.set(status.requestID, status)
    if (statuses.size > 256) {
      const removable = [...statuses.keys()].find((id) => !requests.has(id))
      if (removable) statuses.delete(removable)
    }
    revision++
    await withTimeout(
      rpc.events.emit("review.updated", { generation, revision, directory, status }),
      1000,
    ).catch((error) => {
      if (config.debug) log("UI event publication failed", String(error))
    })
  }
  const key = (sessionID: string, messageID: string, id: string) =>
    `${sessionID}:${messageID}:${id}`
  registrations.push(
    await ctx.tool.hook("execute.before", (event) => {
      if (tools.size >= 512) tools.delete(tools.keys().next().value!)
      // Retain the event object so subsequent hooks' input replacement is visible.
      tools.set(key(event.sessionID, event.messageID, event.id), event)
    }),
  )
  registrations.push(
    await ctx.tool.hook("execute.after", (event) => {
      tools.delete(key(event.sessionID, event.messageID, event.id))
    }),
  )
  const eventTask = (async () => {
    for await (const event of ctx.event.subscribe({ signal: subscription.signal })) {
      // The setup context is typed by the oldest supported host SDK while
      // reviewer events use the client library; the fields read here are
      // stable across the supported range.
      askDecisions?.observe(event as unknown as OpenCodeEvent, directory)
      if ("location" in event && event.location?.directory !== directory) continue
      if (event.type !== "session.execution.interrupted" && event.type !== "session.deleted")
        continue
      const data = (event as unknown as { data?: { sessionID?: string } }).data
      for (const request of requests.values()) {
        if (request.sessionID === data?.sessionID) request.attempt.close("cancelled")
      }
    }
  })()
    .catch((error) => {
      if (!subscription.signal.aborted) log("Host event subscription failed", String(error))
    })
    .finally(() => {
      eventStreamHealthy = false
      if (!disposed) for (const { attempt } of requests.values()) attempt.close("cancelled")
    })
  const permissionRegistration = await ctx.permission.hook("evaluate", async (input) => {
    if (input.effect !== "ask") return
    if (disposed || !eventStreamHealthy) {
      input.effect = "deny"
      input.message = disposed
        ? "Reviewer is shutting down"
        : "Reviewer host event connection is unavailable"
      return
    }
    if (requests.size >= 32) {
      const reviewID = randomUUID()
      input.effect = "deny"
      input.message = "Reviewer concurrency limit reached"
      if (audit)
        notify(() =>
          audit({
            schemaVersion: 3,
            reviewID,
            requestID: reviewID,
            hostGeneration: "v2",
            hostVersion: ctx.app.version,
            generation,
            directory,
            sessionID: input.sessionID,
            nativeAction: input.action,
            permission: input.action,
            outcome: "deny",
            reason: "Reviewer concurrency limit reached",
            timestamp: new Date().toISOString(),
            durationMs: 0,
            application: "evaluation-returned",
            decisionSource: "failure-safe",
          }),
        )
      return
    }
    const budget = reviewBudgetMs(config)
    const attempt = new ReviewAttempt(generation, budget)
    const pending: { attempt: ReviewAttempt; sessionID: string; work?: Promise<void> } = {
      attempt,
      sessionID: input.sessionID,
    }
    requests.set(attempt.id, pending)
    const work = (async () => {
      let normalized: ReturnType<typeof normalizeV2Permission> | undefined
      let envelope: ReviewEnvelope | undefined
      let result: ReviewExecutionResult
      let actionSnapshot: string | undefined
      const snapshotAction = () =>
        JSON.stringify({
          sessionID: input.sessionID,
          action: input.action,
          agent: input.agent,
          resources: input.resources,
          metadata: input.metadata,
          source: input.source,
          exact: input.source
            ? tools.get(key(input.sessionID, input.source.messageID, input.source.id))?.input
            : undefined,
        })
      try {
        const source = input.source
        const exact = source
          ? tools.get(key(input.sessionID, source.messageID, source.id))?.input
          : undefined
        actionSnapshot = snapshotAction()
        if (actionSnapshot.length > 1_000_000)
          throw new Error("Pending action exceeds the evidence size limit")
        normalized = normalizeV2Permission(
          input,
          { reviewID: attempt.id, generation, directory, hostVersion: ctx.app.version },
          exact,
        )
        const request = normalized.request
        await publish(
          createUiStatus(request, "reviewing", {
            model: config.model,
            variant: config.variant,
            timeoutMs: budget,
          }),
        )
        const session = await attempt.wait(ctx.session.get({ sessionID: input.sessionID }))
        if (session.location.directory !== directory)
          throw new Error("Permission belongs to another location")
        const client = await attempt
          .wait(services.connect(directory, identity, ctx.app.version, attempt.signal))
          .catch((error: unknown) => {
            connectionState = "failed"
            throw error
          })
        connectionState = "verified"
        result = await attempt.wait(
          evaluateReview(request, config, {
            active: () => !disposed && attempt.active(generation),
            auxiliarySession: (id) => backend.owns(id),
            collect: async () => {
              envelope = await assembleEvidence(request, defaultEvidenceProviders(), {
                client: createV2ContextReader(client, attempt.signal),
                directory,
                worktree: ctx.location.project.directory,
                config,
                scriptRegistry,
                ...(askDecisions ? { askDecisions } : {}),
              })
              envelope.actionEvidenceComplete =
                envelope.actionEvidenceComplete !== false && normalized!.actionEvidenceComplete
              return envelope
            },
            review: (evidence) => backend.review(evidence, attempt, client),
            observe: () => {},
          }),
        )
      } catch (error) {
        result = applyEscalationDisposition(
          {
            kind: "escalate",
            reason: formatFailureReason("permission review hook", error),
            decisionSource: "failure-safe",
          },
          config,
          "general",
        )
      }
      try {
        if (actionSnapshot !== undefined && snapshotAction() !== actionSnapshot)
          result = {
            kind: "deny",
            reason: "Pending action changed during its review",
            decisionSource: "failure-safe",
          }
      } catch {
        result = {
          kind: "deny",
          reason: "Pending action could not be revalidated",
          decisionSource: "failure-safe",
        }
      }
      const active = !disposed && attempt.active(generation)
      if (!active)
        result = {
          kind: "deny",
          reason: "Review was cancelled or its total deadline expired",
          decisionSource: "failure-safe",
        }
      // The hook owns this evaluation; there is no published permission ID to reply to.
      input.effect = result.kind === "allow" ? "allow" : result.kind === "deny" ? "deny" : "ask"
      if (input.effect === "allow" && envelope?.actionEvidenceComplete !== false)
        scriptRegistry.rememberApproved(envelope?.verifiedScript, result.decision)
      if (input.effect !== "allow") input.message = result.reason
      attempt.close("finished")
      // No awaited I/O between the terminal mutation and returning the hook.
      // Presentation and audit cannot extend the window for a stale approval.
      if (normalized)
        notify(() =>
          publish(
            createUiStatus(
              normalized!.request,
              result.kind === "allow" ? "approved" : result.kind === "deny" ? "denied" : "manual",
              {
                model: config.model,
                variant: config.variant,
                timeoutMs: budget,
                reason: result.reason,
                ...(result.decision ? { decision: result.decision } : {}),
              },
            ),
          ),
        )
      if (audit)
        notify(() =>
          audit({
            schemaVersion: 3,
            decisionSchemaVersion: 2,
            pluginVersion: packageInfo.version,
            promptVersion: REVIEWER_PROMPT_VERSION,
            reviewerModel: config.model,
            effectiveConfigHash,
            ...(normalized
              ? {
                  actionFingerprint:
                    "v2:" +
                    createHash("sha256")
                      .update(
                        JSON.stringify({
                          action: input.action,
                          resources: normalized.request.patterns,
                          metadata: normalized.request.metadata,
                        }),
                      )
                      .digest("hex"),
                }
              : {}),
            reviewID: attempt.id,
            requestID: attempt.id,
            hostGeneration: "v2",
            hostVersion: ctx.app.version,
            generation,
            directory,
            nativeAction: input.action,
            sessionID: input.sessionID,
            permission: normalized?.request.permission ?? input.action,
            timestamp: new Date().toISOString(),
            durationMs: Date.now() - attempt.startedAt,
            outcome: result.kind,
            reason: result.reason,
            decisionSource: result.decisionSource ?? "failure-safe",
            ...(result.decision
              ? {
                  reviewerOutcome: result.decision.outcome,
                  riskLevel: result.decision.risk_level,
                  userAuthorization: result.decision.user_authorization,
                  scopeAlignment: result.decision.scope_alignment,
                  confidence: result.decision.confidence,
                }
              : {}),
            ...(result.escalationDisposition
              ? { escalationDisposition: result.escalationDisposition }
              : {}),
            ...(envelope?.policyTrace ? { policyTrace: envelope.policyTrace } : {}),
            ...(envelope?.evidenceCompleteness
              ? {
                  evidenceCompleteness: envelope.evidenceCompleteness.overall,
                  warnings: envelope.evidenceCompleteness.reasons,
                }
              : {}),
            ...(envelope?.sshAudit.length ? { ssh: envelope.sshAudit } : {}),
            ...(envelope?.verifiedScript
              ? {
                  verifiedScript: {
                    sha256: envelope.verifiedScript.sha256,
                    status: envelope.verifiedScript.status,
                    ...(envelope.verifiedScript.bytes === undefined
                      ? {}
                      : { bytes: envelope.verifiedScript.bytes }),
                  },
                }
              : {}),
            ...(envelope?.askDecisions
              ? {
                  askDecisions: envelope.askDecisions
                    .slice(-5)
                    .map(({ at, question, answer }) => ({ at, question, answer })),
                }
              : {}),
            ...(envelope?.actor
              ? {
                  rootSessionID: envelope.actor.rootSessionID.value,
                  actor: {
                    ...(envelope.actor.agentName.value
                      ? { name: envelope.actor.agentName.value }
                      : {}),
                    profile: envelope.actor.profile.value,
                    identityCompleteness: envelope.actor.identityCompleteness,
                    identitySource: envelope.actor.agentName.source,
                    confidence: envelope.actor.agentName.confidence,
                    delegationDepth: envelope.actor.delegationDepth.value,
                  },
                }
              : {}),
            application: !active
              ? "cancelled"
              : input.effect === "ask"
                ? "human-pending"
                : "evaluation-returned",
            ...(result.reviewSessionID ? { reviewerSessionID: result.reviewSessionID } : {}),
            ...(envelope?.timings ? { timings: envelope.timings } : {}),
          }),
        )
    })().finally(() => {
      attempt.close("cancelled")
      requests.delete(attempt.id)
    })
    pending.work = work
    await work
  })
  registrations.push(permissionRegistration)
  return async () => {
    if (cleanupStarted) return
    cleanupStarted = true
    disposed = true
    subscription.abort()
    await Promise.allSettled(
      registrations
        .splice(0)
        .reverse()
        .map((registration) => Promise.resolve().then(() => registration.dispose())),
    )
    for (const { attempt } of requests.values()) attempt.close("cancelled")
    await Promise.allSettled([...requests.values()].map((request) => request.work))
    await withTimeout(Promise.allSettled([...notifications]), 2000).catch((error) =>
      log("Review notifications did not finish before shutdown", String(error)),
    )
    await withTimeout(backend.waitForIdle(), 12_000).catch((error) =>
      log("Reviewer shutdown cleanup timed out", String(error)),
    )
    await eventTask
    tools.clear()
    statuses.clear()
  }
}
