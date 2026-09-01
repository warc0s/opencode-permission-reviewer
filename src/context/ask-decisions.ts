import type { AskDecision } from "../types.ts"
import { redactSecrets } from "../redact.ts"

/**
 * Captures user answers to agent ask dialogs (the `question` tool) from the
 * OpenCode event stream and exposes them as compact, session-scoped
 * authorization evidence for the reviewer prompt.
 *
 * The host runs questions through a dedicated service (`question.asked` /
 * `question.replied` / `question.rejected` events) that never touches the
 * permission pipeline, so these decisions are invisible to a permission-only
 * observer. This registry is the counterpart capture layer: it is
 * enrichment-only — question events never trigger, supersede, or enforce
 * anything — and it is total (malformed events are dropped, never thrown).
 *
 * Robustness rules:
 * - One logical ask = one record, keyed by the per-ask request ID. The v1 and
 *   v2 event spellings of the same ask upsert into the same entry, and a
 *   replayed reply or rejection is ignored.
 * - A reply or rejection without a matching pending ask is dropped (the
 *   question text is unknowable after the fact).
 * - Pending asks expire (TTL) so a very late reply cannot pair with a stale
 *   question from another context.
 * - Resolved decisions are FIFO-bounded globally; the per-review limit is
 *   applied at query time, not storage time.
 * - Question and answer text is redacted before storage; a credential pasted
 *   as a custom answer must never land in the registry, prompt, or audit.
 */

/** Marker recorded when the user dismisses an ask without answering. */
export const DISMISSED_ANSWER = "Dismissed by user"

/** Word the host uses for sub-questions the user left unanswered. */
const UNANSWERED = "Unanswered"

const MAX_PENDING = 128
const MAX_RESOLVED = 500
const PENDING_TTL_MS = 30 * 60 * 1000

const QUESTION_MAX_CHARS = 160
const ANSWER_MAX_CHARS = 120

type Logger = (message: string, details?: unknown) => void

interface PendingAsk {
  sessionID: string
  questions: string[]
  askedAt: number
}

interface ResolvedDecision extends AskDecision {
  requestID: string
  sessionID: string
}

/** What the evidence assembler consumes: a bounded, lineage-scoped query. */
export interface AskDecisionSource {
  recentFor(sessionIDs: string[], limit?: number): AskDecision[]
}

interface QuestionShape {
  id: string
  sessionID: string
  questions: string[]
}

interface ReplyShape {
  requestID: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function sanitizeText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  const text = value.trim()
  if (!text) return undefined
  const redacted = redactSecrets(text)
  return redacted.length <= max ? redacted : redacted.slice(0, max)
}

/** Normalize a `question.(v2.)asked` payload into question texts. */
function parseAsked(properties: unknown): QuestionShape | undefined {
  if (!isObject(properties)) return
  if (typeof properties.id !== "string" || typeof properties.sessionID !== "string") return
  if (!Array.isArray(properties.questions)) return
  const questions: string[] = []
  for (const raw of properties.questions) {
    if (!isObject(raw)) continue
    const text = sanitizeText(raw.question, QUESTION_MAX_CHARS)
    if (text !== undefined) questions.push(text)
  }
  if (questions.length === 0) return
  return { id: properties.id, sessionID: properties.sessionID, questions }
}

/** Normalize a `question.(v2.)replied` payload into per-question answers
 *  (each an array of selected labels). Pairing/padding against the asked
 *  questions happens where the pending entry is known. */
function parseReply(properties: unknown): { requestID: string; answers: string[] } | undefined {
  if (!isObject(properties)) return
  if (typeof properties.requestID !== "string") return
  if (!Array.isArray(properties.answers)) return
  const perQuestion: string[] = []
  for (const raw of properties.answers) {
    if (!Array.isArray(raw)) continue
    const labels = raw.filter((label): label is string => typeof label === "string")
    perQuestion.push(
      labels.length === 0
        ? UNANSWERED
        : (sanitizeText(labels.join(", "), ANSWER_MAX_CHARS) ?? UNANSWERED),
    )
  }
  if (perQuestion.length === 0) return
  return { requestID: properties.requestID, answers: perQuestion }
}

function parseReplyTarget(properties: unknown): ReplyShape | undefined {
  if (!isObject(properties)) return
  return typeof properties.requestID === "string" ? { requestID: properties.requestID } : undefined
}

export class AskDecisionRegistry implements AskDecisionSource {
  private readonly pending = new Map<string, PendingAsk>()
  private readonly resolved = new Map<string, ResolvedDecision>()
  private readonly log: Logger
  private readonly now: () => number

  constructor(logger?: Logger, now: () => number = () => Date.now()) {
    this.log = logger ?? (() => {})
    this.now = now
  }

  /**
   * Observe one raw event. Total: never throws; anything malformed or
   * unrelated is dropped silently. Must be called synchronously from the event
   * hook so registry mutations are visible to reviews started later.
   */
  observe(event: unknown): void {
    if (!isObject(event)) return
    switch (event.type) {
      case "question.asked":
      case "question.v2.asked": {
        const asked = parseAsked(event.properties)
        if (asked === undefined) return
        // A late duplicate ask for an already-resolved request is a replay.
        if (this.resolved.has(asked.id)) return
        this.prunePending()
        this.pending.set(asked.id, {
          sessionID: asked.sessionID,
          questions: asked.questions,
          askedAt: this.now(),
        })
        return
      }
      case "question.replied":
      case "question.v2.replied": {
        const reply = parseReply(event.properties)
        if (reply === undefined) return
        const pending = this.takePending(reply.requestID)
        if (pending === undefined) return
        this.store(reply.requestID, pending.sessionID, {
          at: this.now(),
          question: pending.questions.join(" | "),
          // Clamp to the asked questions: missing slots are unanswered, and
          // extra slots in a malformed event are orphan noise.
          answer: pending.questions
            .map((_, index) => reply.answers[index] ?? UNANSWERED)
            .join(" | "),
        })
        this.log("ask decision captured", {
          requestID: reply.requestID,
          sessionID: pending.sessionID,
        })
        return
      }
      case "question.rejected":
      case "question.v2.rejected": {
        const target = parseReplyTarget(event.properties)
        if (target === undefined) return
        const pending = this.takePending(target.requestID)
        if (pending === undefined) return
        this.store(target.requestID, pending.sessionID, {
          at: this.now(),
          question: pending.questions.join(" | "),
          answer: DISMISSED_ANSWER,
        })
        this.log("ask dismissed by user", {
          requestID: target.requestID,
          sessionID: pending.sessionID,
        })
        return
      }
      default:
        return
    }
  }

  /**
   * Decisions visible to a review running in `sessionIDs` (the requesting
   * session plus its resolved ancestors), oldest first, bounded to the most
   * recent `limit`. Sibling and unrelated sessions are never visible.
   */
  recentFor(sessionIDs: string[], limit = 6): AskDecision[] {
    if (sessionIDs.length === 0 || limit <= 0) return []
    const scope = new Set(sessionIDs)
    const visible = [...this.resolved.values()]
      .filter((decision) => scope.has(decision.sessionID))
      .sort((a, b) => a.at - b.at)
    // `slice(-limit)` would return everything for limit 0; guarded above.
    return visible.slice(-limit).map((decision) => ({
      at: decision.at,
      question: decision.question,
      answer: decision.answer,
    }))
  }

  /** Observed-but-unresolved asks (diagnostics only). */
  pendingCount(): number {
    return this.pending.size
  }

  /** Resolved decisions retained (diagnostics only). */
  resolvedCount(): number {
    return this.resolved.size
  }

  private takePending(requestID: string): PendingAsk | undefined {
    // Replies and rejections must not pair with an expired ask, even when no
    // new ask arrived to trigger the routine pruning.
    this.pruneExpired()
    const pending = this.pending.get(requestID)
    if (pending !== undefined) this.pending.delete(requestID)
    return pending
  }

  private store(requestID: string, sessionID: string, decision: AskDecision): void {
    this.resolved.set(requestID, { ...decision, requestID, sessionID })
    while (this.resolved.size > MAX_RESOLVED) {
      const oldest = this.resolved.keys().next().value
      if (oldest === undefined) break
      this.resolved.delete(oldest)
    }
  }

  /** Enforce the pending cap and TTL. Map iteration order is insertion
   *  order, so `keys().next()` is the oldest entry. */
  private prunePending(): void {
    this.pruneExpired()
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value
      if (oldest === undefined) break
      this.pending.delete(oldest)
    }
  }

  private pruneExpired(): void {
    const cutoff = this.now() - PENDING_TTL_MS
    for (const [id, entry] of this.pending) {
      if (entry.askedAt < cutoff) this.pending.delete(id)
    }
  }
}
