import type { PermissionRequest, ReviewEnvelope, ReviewerConfig } from "../types.ts"
import { buildIntentHistory, buildTranscript, normalizeMessages } from "../context.ts"
import type { AskDecisionSource } from "./ask-decisions.ts"
import type { OpenCodeClientLike } from "../opencode/types.ts"
import { responseData } from "../opencode/transport.ts"
import { resolveActorContext } from "./actor-resolver.ts"
import { resolveActionPurpose } from "./action-purpose.ts"
import { parseCommand } from "../capability/command-parser.ts"
import { analyzeCapability } from "../capability/bash-analyzer.ts"
import type { EvidenceProvider } from "../evidence/provider.ts"
import type { SshAuditSummary } from "../ssh-evidence.ts"
import { SshEvidenceProvider } from "../evidence/ssh-provider.ts"
import { LocalScriptEvidenceProvider } from "../evidence/local-script-provider.ts"
import { GitEvidenceProvider } from "../evidence/git-provider.ts"

export interface EvidenceAssemblyContext {
  client: OpenCodeClientLike
  directory: string
  worktree: string
  config: ReviewerConfig
  /** Live ask-decision capture, when enabled. Enrichment-only. */
  askDecisions?: AskDecisionSource
}

/**
 * Fetch the session transcript and run every evidence provider concurrently,
 * then fold the fragments into a single {@link ReviewEnvelope}. This is the
 * only place that decides which evidence text reaches the reviewer prompt and
 * which ssh audit summary reaches the audit record.
 */
export async function assembleEvidence(
  request: PermissionRequest,
  providers: EvidenceProvider[],
  ctx: EvidenceAssemblyContext,
): Promise<ReviewEnvelope> {
  const contextStart = performance.now()
  const response = await ctx.client.session.messages({
    path: { id: request.sessionID },
    query: {
      directory: ctx.directory,
      limit: Math.max(ctx.config.historyMessages, ctx.config.transcriptMessages * 2, 20),
    },
  })
  const messages = normalizeMessages(responseData(response, "session.messages"))

  // Resolve actor/lineage/intent. The resolver is resilient — it never throws,
  // degrading to "unknown" — so this cannot block a review.
  const actor = await resolveActorContext(request, messages, ctx.client, ctx.directory, ctx.config)

  // Parse the bash command and derive capability facts. Only computed for bash
  // requests; non-bash permissions have no command surface to analyze. Wrapped in
  // try/catch so a parser bug can never block a review (capability degrades to
  // absent, never throws).
  let parsed
  let capability
  if (request.permission === "bash") {
    const command =
      typeof request.metadata.command === "string"
        ? request.metadata.command
        : request.patterns.filter((p) => typeof p === "string").join("\n")
    if (command.trim()) {
      try {
        parsed = parseCommand(command)
        capability = analyzeCapability(parsed, ctx.directory, ctx.worktree)
      } catch {
        // Static analysis is best-effort; absence is non-fatal.
      }
    }
  }

  const contextMs = performance.now() - contextStart

  const enrichmentStart = performance.now()
  const fragments = await Promise.all(
    providers.map((provider) =>
      provider.collect({
        request,
        directory: ctx.directory,
        worktree: ctx.worktree,
        maxChars: ctx.config.maxEnrichmentChars,
      }),
    ),
  )
  const enrichmentMs = performance.now() - enrichmentStart

  const enrichment = fragments
    .map((fragment) => fragment.text)
    .filter(Boolean)
    .join("\n\n")

  const sshFragment = fragments.find((fragment) => fragment.kind === "ssh")
  const sshAudit: SshAuditSummary[] = sshFragment?.audit ?? []
  const preflightDenial = fragments.find(
    (fragment) => fragment.preflightDenial !== undefined,
  )?.preflightDenial

  const actionPurpose = resolveActionPurpose(request, actor.intent, messages)

  // Ask decisions are visible only along the resolved ancestry: the
  // requesting session plus sessions the lineage walker actually reached.
  // Sibling and unrelated sessions are never in scope.
  const askDecisions =
    ctx.config.askDecisions && ctx.askDecisions !== undefined
      ? ctx.askDecisions.recentFor([
          request.sessionID,
          ...(actor.lineage?.nodes.map((node) => node.sessionID) ?? []),
        ])
      : undefined

  const purposeOk = actionPurpose.source !== "unavailable"
  const completenessReasons = [...actor.completeness.reasons]
  if (!purposeOk) completenessReasons.push("action purpose unavailable")

  return {
    request,
    directory: ctx.directory,
    worktree: ctx.worktree,
    timings: { contextMs, enrichmentMs },
    transcript: buildTranscript(messages, ctx.config),
    intentHistory: buildIntentHistory(messages, ctx.config),
    enrichment,
    sshAudit,
    ...(preflightDenial === undefined ? {} : { preflightDenial }),
    actor: actor.actor,
    lineage: actor.lineage,
    intent: actor.intent,
    actionPurpose,
    evidenceCompleteness: {
      ...actor.completeness,
      purpose: purposeOk,
      // Capability is computed here (not in the resolver), so reflect whether
      // the analyzer produced facts for this request.
      capability: capability !== undefined,
      reasons: completenessReasons,
    },
    ...(parsed === undefined ? {} : { parsedCommand: parsed }),
    ...(capability === undefined ? {} : { capability }),
    ...(askDecisions === undefined || askDecisions.length === 0 ? {} : { askDecisions }),
  }
}

/** The default evidence bundle used when callers do not inject their own. */
export function defaultEvidenceProviders(): EvidenceProvider[] {
  return [new SshEvidenceProvider(), new LocalScriptEvidenceProvider(), new GitEvidenceProvider()]
}
