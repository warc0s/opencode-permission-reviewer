import type {
  ActionPurpose,
  ActorContext,
  AskDecision,
  EvidenceCompleteness,
  IntentBlock,
  MessageWithParts,
  PermissionRequest,
  PolicyTrace,
  Provenanced,
  ReviewEnvelope,
  ReviewerConfig,
  SessionLineage,
} from "./types.ts"
import { redactSecrets } from "./redact.ts"

function truncate(value: string, max: number): string {
  // Redact secrets before measuring/truncating so a credential can never slip
  // through because its surrounding text was chopped at a budget boundary.
  const redacted = redactSecrets(value)
  if (redacted.length <= max) return redacted
  const omitted = redacted.length - max
  return `${redacted.slice(0, max)}\n<truncated characters="${omitted}" />`
}

function stableJson(value: unknown, max: number): string {
  try {
    const seen = new WeakSet<object>()
    const text = JSON.stringify(
      value,
      (_key, item) => {
        if (typeof item === "bigint") return item.toString()
        if (typeof item === "object" && item !== null) {
          if (seen.has(item)) return "[Circular]"
          seen.add(item)
        }
        return item
      },
      2,
    )
    return truncate(text ?? String(value), max)
  } catch {
    return truncate(String(value), max)
  }
}

function partSummary(part: Record<string, unknown>, maxPartChars: number): string | undefined {
  const type = typeof part.type === "string" ? part.type : "unknown"
  if (type === "text" || type === "reasoning") {
    const text = typeof part.text === "string" ? part.text : ""
    if (!text.trim()) return
    return `${type}: ${truncate(text, maxPartChars)}`
  }
  if (type === "tool") {
    const compact = {
      type,
      tool: part.tool,
      callID: part.callID,
      state: part.state,
    }
    return `tool: ${stableJson(compact, maxPartChars)}`
  }
  if (type === "file") {
    return `file: ${stableJson({ mime: part.mime, filename: part.filename, url: part.url }, 1_000)}`
  }
  if (type === "step-start" || type === "step-finish" || type === "snapshot") return
  return `${type}: ${stableJson(part, Math.min(maxPartChars, 2_000))}`
}

function messageSummary(message: MessageWithParts, maxPartChars: number): string | undefined {
  const role = typeof message.info.role === "string" ? message.info.role : "unknown"
  const id = typeof message.info.id === "string" ? message.info.id : "unknown"
  const parts = message.parts
    .map((part) => {
      if (
        role === "user" &&
        part.type === "text" &&
        typeof part.text === "string" &&
        isSyntheticControlMessage(part.text)
      ) {
        return
      }
      return partSummary(part, maxPartChars)
    })
    .filter((part): part is string => Boolean(part))
  if (parts.length === 0) return
  return `MESSAGE role=${role} id=${id}\n${parts.join("\n")}`
}

export function buildTranscript(messages: MessageWithParts[], config: ReviewerConfig): string {
  const selected = messages.slice(-config.transcriptMessages)
  const summaries = selected
    .map((message) => messageSummary(message, config.maxPartChars))
    .filter((summary): summary is string => Boolean(summary))
  return truncate(summaries.join("\n\n"), config.maxContextChars)
}

function isSyntheticControlMessage(text: string): boolean {
  const normalized = text.trim()
  return (
    /^Magic Compact:\s*Compaction in progress/i.test(normalized) ||
    /^You have \d+ weighted tokens left/i.test(normalized)
  )
}

function userIntentSummary(message: MessageWithParts, config: ReviewerConfig): string | undefined {
  if (message.info.role !== "user") return
  const texts = message.parts.flatMap((part) => {
    if (part.type !== "text" || typeof part.text !== "string") return []
    const text = part.text.trim()
    if (!text || isSyntheticControlMessage(text)) return []
    return [truncate(text, config.maxPartChars)]
  })
  if (texts.length === 0) return
  const id = typeof message.info.id === "string" ? message.info.id : "unknown"
  const time =
    typeof message.info.time === "object" &&
    message.info.time !== null &&
    typeof (message.info.time as Record<string, unknown>).created === "number"
      ? ` created=${(message.info.time as Record<string, unknown>).created}`
      : ""
  return `USER_INTENT id=${id}${time}\n${texts.join("\n")}`
}

function keepMostRecentBlocks(blocks: string[], maxChars: number): string {
  const selected: string[] = []
  let remaining = maxChars
  for (let index = blocks.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const block = blocks[index]!
    const separator = selected.length === 0 ? 0 : 2
    if (remaining <= separator) break
    const bounded = truncate(block, remaining - separator)
    selected.push(bounded)
    remaining -= bounded.length + separator
  }
  return selected.reverse().join("\n\n")
}

export function buildIntentHistory(messages: MessageWithParts[], config: ReviewerConfig): string {
  const seen = new Set<string>()
  const summaries = messages.flatMap((message) => {
    const summary = userIntentSummary(message, config)
    if (!summary) return []
    const fingerprint = summary.replace(/^USER_INTENT[^\n]*\n/, "")
    if (seen.has(fingerprint)) return []
    seen.add(fingerprint)
    return [summary]
  })
  return keepMostRecentBlocks(summaries.slice(-config.intentMessages), config.maxIntentChars)
}

export function buildEvidence(envelope: ReviewEnvelope, config: ReviewerConfig): string {
  const request: PermissionRequest = envelope.request
  // Omitted entirely when empty: absence of ask decisions carries no signal
  // for the reviewer (the transcript remains the fallback source).
  const askDecisions = renderAskDecisions(envelope.askDecisions)
  const evidence = [
    renderPolicySummary(envelope.policyTrace, config.maxPartChars * 2),
    `WORKING_DIRECTORY\n${envelope.directory}`,
    `WORKTREE\n${envelope.worktree}`,
    // Actor/lineage/intent sections precede PENDING_PERMISSION so the reviewer
    // judges the request knowing who is asking and why.
    ...actorEvidenceSections(envelope, config),
    renderActionPurpose(envelope.actionPurpose, config.maxPartChars * 2),
    `PENDING_PERMISSION\n${stableJson(
      {
        permission: request.permission,
        patterns: request.patterns,
        metadata: request.metadata,
        tool: request.tool,
      },
      config.maxPartChars * 2,
    )}`,
    envelope.enrichment || "ACTION_ENRICHMENT\n<none />",
    `REPOSITORY_CONTEXT\n${stableJson(
      { trust: config.repositoryTrust, directory: envelope.directory, worktree: envelope.worktree },
      config.maxPartChars * 2,
    )}`,
    `USER_INTENT_HISTORY\n${envelope.intentHistory || "<no user intent history available />"}`,
    ...(askDecisions === undefined ? [] : [`USER_ASK_DECISIONS\n${askDecisions}`]),
    `RECENT_TRANSCRIPT\n${envelope.transcript || "<no transcript available />"}`,
  ].join("\n\n")
  return truncate(
    evidence,
    config.maxContextChars +
      config.maxPartChars * 2 +
      config.maxEnrichmentChars +
      config.maxIntentChars,
  )
}

function renderActionPurpose(purpose: ActionPurpose | undefined, max: number): string {
  if (purpose === undefined) {
    return `ACTION_PURPOSE\n${stableJson({ source: "unavailable", confidence: "unknown" }, max)}`
  }
  return `ACTION_PURPOSE\n${stableJson(
    {
      source: purpose.source,
      confidence: purpose.confidence,
      ...(purpose.text === undefined ? {} : { text: purpose.text }),
    },
    max,
  )}`
}

/** Compact rendering of ask decisions, one line each (UTC time, question,
 *  answer). `undefined` when there is nothing to show so the whole section is
 *  omitted rather than padded with a placeholder. */
export function renderAskDecisions(decisions: AskDecision[] | undefined): string | undefined {
  if (decisions === undefined || decisions.length === 0) return
  const lines = []
  for (const decision of decisions) {
    const time = new Date(decision.at).toISOString().slice(11, 19)
    lines.push(`[${time}Z] Q: ${decision.question} A: ${decision.answer}`)
  }
  // Keep the most recent lines when the block would exceed the budget.
  const maxChars = 1_500
  while (lines.length > 1 && lines.join("\n").length > maxChars) lines.shift()
  const joined = lines.join("\n")
  return joined.length <= maxChars ? joined : joined.slice(0, maxChars)
}

// --- policy summary section -------------------------------------------------

function renderPolicySummary(trace: PolicyTrace | undefined, max: number): string {
  if (trace === undefined) return "EFFECTIVE_POLICY_SUMMARY\n<no policy evaluation available />"
  return `EFFECTIVE_POLICY_SUMMARY\n${stableJson(
    {
      hash: trace.effectivePolicyHash,
      route: trace.finalRoute,
      mode: trace.mode,
      matches: trace.matchedRules.map((m) => ({ id: m.id, effect: m.effect, reason: m.reason })),
    },
    max,
  )}`
}

// --- actor/lineage/intent prompt sections -----------------------------------

function provValue<T>(p: Provenanced<T> | undefined): T | "unavailable" {
  return p === undefined ? "unavailable" : p.value
}

function renderActor(actor: ActorContext, max: number): string {
  return stableJson(
    {
      agent: provValue(actor.agentName),
      mode: provValue(actor.mode),
      profile: provValue(actor.profile),
      identityCompleteness: actor.identityCompleteness,
      sessionID: actor.sessionID,
      parentSessionID: provValue(actor.parentSessionID),
      rootSessionID: provValue(actor.rootSessionID),
      delegationDepth: provValue(actor.delegationDepth),
    },
    max,
  )
}

function renderLineage(lineage: SessionLineage, max: number): string {
  return stableJson(
    {
      depth: lineage.depth,
      rootSessionID: lineage.rootSessionID,
      cycleDetected: lineage.cycleDetected,
      truncated: lineage.truncated,
      missingParents: lineage.missingParents,
      chain: lineage.nodes.map((n) => ({
        sessionID: n.sessionID,
        ...(n.actorName === undefined ? {} : { actor: n.actorName }),
        ...(n.mode === undefined ? {} : { mode: n.mode }),
      })),
    },
    max,
  )
}

function renderIntentBlocks(blocks: IntentBlock[], max: number): string {
  if (blocks.length === 0) return "<none />"
  return stableJson(
    blocks.map((b) => ({
      actor: b.actor,
      text: b.text,
      ...(b.createdAt === undefined ? {} : { createdAt: b.createdAt }),
    })),
    max,
  )
}

function renderCompleteness(c: EvidenceCompleteness, max: number): string {
  return stableJson(
    {
      overall: c.overall,
      actor: c.actor,
      lineage: c.lineage,
      directUserIntent: c.directUserIntent,
      delegatedTask: c.delegatedTask,
      purpose: c.purpose,
      capability: c.capability,
      ...(c.reasons.length === 0 ? {} : { reasons: c.reasons }),
    },
    max,
  )
}

/** Render the capability assessment as a compact JSON block for the reviewer. */
function renderCapability(cap: import("./types.ts").CapabilityAssessment, max: number): string {
  return stableJson(
    {
      actionClass: cap.actionClass.value,
      summary: cap.summary,
      executesCode: cap.executesCode.value,
      createsAdHocCode: cap.createsAdHocCode.value,
      invokesPackageLifecycleScripts: cap.invokesPackageLifecycleScripts.value,
      invokesExistingTestRunner: cap.invokesExistingTestRunner.value,
      writeEffects: {
        temporaryWrite: cap.writeEffects.temporaryWrite.value,
        workspaceWrite: cap.writeEffects.workspaceWrite.value,
        externalWrite: cap.writeEffects.externalWrite.value,
        deletion: cap.writeEffects.deletion.value,
      },
      network: {
        observed: cap.network.observed.value,
        ...(cap.network.destinations.length === 0
          ? {}
          : { destinations: cap.network.destinations }),
      },
      process: {
        childProcesses: cap.process.childProcesses.value,
        persistence: cap.process.persistence.value,
        privilegeEscalation: cap.process.privilegeEscalation.value,
      },
      remote: { enabled: cap.remote.enabled.value, mutationHint: cap.remote.mutationHint.value },
      git: { mutation: cap.git.possible.value },
      parserCompleteness: cap.parserCompleteness,
      ...(cap.analysisWarnings.length === 0 ? {} : { warnings: cap.analysisWarnings }),
    },
    max,
  )
}

/** Render the actor-context prompt sections, or a single placeholder when
 *  resolution produced nothing (keeps the prompt compact for unknown actors). */
export function actorEvidenceSections(envelope: ReviewEnvelope, config: ReviewerConfig): string[] {
  const actor = envelope.actor
  const lineage = envelope.lineage
  const intent = envelope.intent
  const completeness = envelope.evidenceCompleteness
  if (actor === undefined || lineage === undefined || intent === undefined) {
    return ["ACTOR_CONTEXT\n<unavailable />"]
  }
  const cap = config.maxPartChars * 2
  const sections = [
    `ACTOR_CONTEXT\n${renderActor(actor, cap)}`,
    `SESSION_LINEAGE\n${renderLineage(lineage, cap)}`,
    `DIRECT_USER_INTENT\n${renderIntentBlocks(intent.directUserIntent, cap)}`,
    `DELEGATED_TASK\n${renderIntentBlocks(intent.delegatedTask, cap)}`,
    `LOCAL_SESSION_CONTEXT\n${renderIntentBlocks(intent.localSessionIntent, cap)}`,
  ]
  if (envelope.capability !== undefined) {
    sections.push(`CAPABILITY_ASSESSMENT\n${renderCapability(envelope.capability, cap)}`)
  }
  if (completeness !== undefined) {
    sections.push(`EVIDENCE_COMPLETENESS\n${renderCompleteness(completeness, cap)}`)
  }
  return sections
}

export function normalizeMessages(value: unknown): MessageWithParts[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return []
    const record = item as Record<string, unknown>
    const info = typeof record.info === "object" && record.info !== null ? record.info : {}
    const parts = Array.isArray(record.parts)
      ? record.parts.filter(
          (part): part is Record<string, unknown> => typeof part === "object" && part !== null,
        )
      : []
    return [{ info: info as MessageWithParts["info"], parts }]
  })
}
