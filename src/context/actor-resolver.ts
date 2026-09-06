import type {
  ActorContext,
  ActorProfile,
  EvidenceCompleteness,
  EvidenceConfidence,
  IntentBlock,
  IntentContext,
  MessageWithParts,
  PermissionRequest,
  Provenanced,
  ReviewerConfig,
  SessionLineage,
  SessionNode,
} from "../types.ts"
import type { OpenCodeClientLike } from "../opencode/types.ts"
import { responseData, withTimeout } from "../opencode/transport.ts"

/** Bound for the resolver's metadata SDK calls: a hung session.get/messages
 *  must degrade to "unknown" instead of leaving the review pending forever. */
const METADATA_TIMEOUT_MS = 10_000

/**
 * Result of actor/lineage resolution. All fields are populated
 * even when the SDK is unavailable: the resolver degrades honestly to
 * "unknown"/"unavailable" rather than throwing, so a review never fails because
 * actor metadata could not be fetched (unknown actors are first-class).
 */
export interface ActorResolution {
  actor: ActorContext
  lineage: SessionLineage
  intent: IntentContext
  completeness: EvidenceCompleteness
}

// --- provenance helpers -----------------------------------------------------

function prov<T>(
  value: T,
  source: Provenanced<T>["source"],
  confidence: EvidenceConfidence,
  notes?: string[],
): Provenanced<T> {
  return notes === undefined ? { value, source, confidence } : { value, source, confidence, notes }
}

const UNKNOWN_STRING = prov<string | undefined>(undefined, "unavailable", "unknown")
const UNKNOWN_PROFILE = prov<ActorProfile>("unknown", "unavailable", "unknown")

// --- current-session actor (pure, from already-fetched messages) -----------

interface CurrentActor {
  agentName: string | undefined
  mode: string | undefined
  toolLocated: boolean
}

/**
 * Locate the requesting tool call by `request.tool.messageID`/`callID` and read
 * the containing assistant message's `agent`/`mode`.
 * Operates on the message list already fetched by the evidence assembler, so it
 * adds no SDK round-trips.
 */
function resolveCurrentActor(
  request: PermissionRequest,
  messages: MessageWithParts[],
): CurrentActor {
  const tool = request.tool
  if (!tool?.messageID) return { agentName: undefined, mode: undefined, toolLocated: false }
  const container = messages.find((m) => m.info.id === tool.messageID)
  if (!container) return { agentName: undefined, mode: undefined, toolLocated: false }
  const info = container.info as Record<string, unknown>
  const agentName = typeof info.agent === "string" ? info.agent : undefined
  const mode = typeof info.mode === "string" ? info.mode : undefined
  // Confirm the specific tool call (callID) exists in the message parts.
  const toolLocated =
    typeof tool.callID === "string" &&
    (container.parts as Array<Record<string, unknown>>).some(
      (part) => part.type === "tool" && part.callID === tool.callID,
    )
  return { agentName, mode, toolLocated }
}

// --- session.get wrapper (resilient) ----------------------------------------

interface SessionMetadata {
  id: string
  parentID: string | undefined
  title: string | undefined
  version: string | undefined
  agent: string | undefined
  mode: string | undefined
  createdAt: number | undefined
}

function readSession(id: string, raw: unknown): SessionMetadata {
  const r = (raw ?? {}) as Record<string, unknown>
  const parentID = typeof r.parentID === "string" ? r.parentID : undefined
  return {
    id,
    parentID,
    title: typeof r.title === "string" ? r.title : undefined,
    version: typeof r.version === "string" ? r.version : undefined,
    agent: typeof r.agent === "string" ? r.agent : undefined,
    mode: typeof r.mode === "string" ? r.mode : undefined,
    createdAt:
      typeof r.time === "object" &&
      r.time !== null &&
      "created" in r.time &&
      typeof (r.time as Record<string, unknown>).created === "number"
        ? ((r.time as Record<string, unknown>).created as number)
        : undefined,
  }
}

async function fetchSession(
  client: OpenCodeClientLike,
  sessionID: string,
  directory: string,
): Promise<SessionMetadata | undefined> {
  if (typeof client.session.get !== "function") return undefined
  try {
    const response = await withTimeout(
      client.session.get({ path: { id: sessionID }, query: { directory } }),
      METADATA_TIMEOUT_MS,
    )
    return readSession(sessionID, responseData(response, "session.get"))
  } catch {
    return undefined
  }
}

// --- lineage walk -----------------------------------------------------------

/**
 * Walk session parents via `session.get`, bounded by `maxSessionDepth`/
 * `maxParentSessions` with mandatory cycle detection. Missing/unavailable
 * parents are recorded explicitly rather than aborting the walk.
 */
async function walkLineage(
  client: OpenCodeClientLike,
  sessionID: string,
  directory: string,
  config: ReviewerConfig,
): Promise<SessionLineage> {
  const nodes: SessionNode[] = []
  const missingParents: string[] = []
  const visited = new Set<string>()
  let cycleDetected = false

  const current = await fetchSession(client, sessionID, directory)
  const fallback: SessionMetadata = {
    id: sessionID,
    parentID: undefined,
    title: undefined,
    version: undefined,
    agent: undefined,
    mode: undefined,
    createdAt: undefined,
  }
  nodes.push(toNode(current ?? fallback))
  visited.add(sessionID)

  let cursor = current
  let depth = 0
  while (cursor?.parentID) {
    if (depth >= config.maxSessionDepth || nodes.length - 1 >= config.maxParentSessions) {
      // Hit a configured bound; remaining ancestry is truncated, not missing.
      return finalize(nodes, cursor.parentID, depth, cycleDetected, true, missingParents)
    }
    if (visited.has(cursor.parentID)) {
      cycleDetected = true
      missingParents.push(cursor.parentID)
      break
    }
    visited.add(cursor.parentID)
    const parent = await fetchSession(client, cursor.parentID, directory)
    if (!parent) {
      missingParents.push(cursor.parentID)
      break
    }
    nodes.push(toNode(parent))
    depth += 1
    cursor = parent
  }
  return finalize(nodes, undefined, depth, cycleDetected, false, missingParents)
}

function toNode(s: SessionMetadata): SessionNode {
  const node: SessionNode = { sessionID: s.id }
  if (s.parentID !== undefined) node.parentID = s.parentID
  if (s.title !== undefined) node.title = s.title
  if (s.version !== undefined) node.version = s.version
  if (s.agent !== undefined) node.actorName = s.agent
  if (s.mode !== undefined) node.mode = s.mode
  if (s.createdAt !== undefined) node.createdAt = s.createdAt
  return node
}

function finalize(
  nodes: SessionNode[],
  nextUnresolved: string | undefined,
  depth: number,
  cycleDetected: boolean,
  truncated: boolean,
  missingParents: string[],
): SessionLineage {
  if (nextUnresolved !== undefined && !missingParents.includes(nextUnresolved)) {
    missingParents.push(nextUnresolved)
  }
  const root = nodes[nodes.length - 1]
  return {
    nodes,
    rootSessionID: root?.sessionID ?? nodes[0]!.sessionID,
    depth,
    cycleDetected,
    truncated,
    missingParents,
  }
}

// --- parent/root message fetch for intent extraction ------------------------

async function fetchMessagesBounded(
  client: OpenCodeClientLike,
  sessionID: string,
  directory: string,
  limit: number,
): Promise<MessageWithParts[]> {
  try {
    const response = await withTimeout(
      client.session.messages({
        path: { id: sessionID },
        query: { directory, limit },
      }),
      METADATA_TIMEOUT_MS,
    )
    return normalizeFetched(responseData(response, "session.messages"))
  } catch {
    return []
  }
}

function normalizeFetched(raw: unknown): MessageWithParts[] {
  if (!Array.isArray(raw)) return []
  return raw as MessageWithParts[]
}

// --- intent extraction ------------------------------------------------------

/** Host-authored text injected into a user-role message is never human
 *  authorization. Provenance comes from the part's own `synthetic`/`ignored`
 *  flags when the host sets them; the text-pattern check below is only a
 *  fallback for hosts that do not. */
function isSyntheticPart(part: Record<string, unknown>): boolean {
  if (part.type !== "text" || typeof part.text !== "string") return false
  if (part.synthetic === true || part.ignored === true) return true
  return /^\s*(Magic Compact:|You have \d+ weighted tokens left)/.test(part.text)
}

function messageCreatedAt(message: MessageWithParts): number | undefined {
  const time = message.info.time as Record<string, unknown> | undefined
  return typeof time === "object" && time !== null && typeof time.created === "number"
    ? time.created
    : undefined
}

function userTextOf(message: MessageWithParts): string | undefined {
  if (message.info.role !== "user") return undefined
  for (const part of message.parts as Array<Record<string, unknown>>) {
    if (isSyntheticPart(part)) continue
    if (typeof part.text === "string" && part.text.trim()) {
      return part.text
    }
  }
  return undefined
}

/** A delegation recorded as a subtask/task tool part in a parent session.
 *  Task-tool parts carry the spawned child session id in
 *  `state.metadata.sessionId`; when present, only the delegation that created
 *  THIS session is recorded, so sibling subagent briefs are not attributed to
 *  the request under review. */
function extractDelegatedTasks(
  messages: MessageWithParts[],
  sessionID: string,
  childSessionID: string,
): IntentBlock[] {
  const blocks: IntentBlock[] = []
  for (const message of messages) {
    for (const part of message.parts as Array<Record<string, unknown>>) {
      const isSubtask = part.type === "subtask"
      const isTaskTool = part.type === "tool" && part.tool === "task"
      if (!isSubtask && !isTaskTool) continue
      if (isTaskTool) {
        const state = part.state as Record<string, unknown> | undefined
        const metadata = state?.metadata as Record<string, unknown> | undefined
        if (typeof metadata?.sessionId === "string" && metadata.sessionId !== childSessionID) {
          continue
        }
      }
      const text =
        typeof part.prompt === "string"
          ? part.prompt
          : typeof part.description === "string"
            ? part.description
            : undefined
      if (!text || !text.trim()) continue
      blocks.push({
        sessionID,
        messageID: typeof message.info.id === "string" ? message.info.id : "",
        actor: "assistant",
        text,
        synthetic: false,
        ...(typeof part.time === "object" &&
        part.time !== null &&
        "start" in part.time &&
        typeof (part.time as Record<string, unknown>).start === "number"
          ? { createdAt: (part.time as Record<string, unknown>).start as number }
          : {}),
        provenance: prov<"intent">("intent", "parent-session", "high"),
      })
    }
  }
  return blocks
}

function extractDirectIntent(
  messages: MessageWithParts[],
  sessionID: string,
  options?: { skipFirstUserMessage?: boolean },
): IntentBlock[] {
  const blocks: IntentBlock[] = []
  let skippedFirst = false
  for (const message of messages) {
    const text = userTextOf(message)
    if (!text) continue
    // In a delegated (child) session the FIRST user message is the parent
    // agent's briefing, not a human instruction; it is attribution noise for
    // "did the user authorize this" and is already recovered as a delegated
    // task from the parent session.
    if (options?.skipFirstUserMessage === true && !skippedFirst) {
      skippedFirst = true
      continue
    }
    const createdAt = messageCreatedAt(message)
    blocks.push({
      sessionID,
      messageID: typeof message.info.id === "string" ? message.info.id : "",
      actor: "user",
      text,
      synthetic: false,
      ...(createdAt === undefined ? {} : { createdAt }),
      provenance: prov<"intent">("intent", "parent-session", "high"),
    })
  }
  return blocks
}

async function resolveIntent(
  request: PermissionRequest,
  currentMessages: MessageWithParts[],
  lineage: SessionLineage,
  client: OpenCodeClientLike,
  directory: string,
  config: ReviewerConfig,
): Promise<IntentContext> {
  // Local (current session) direct intent. In a delegated session the first
  // user message is the parent agent's briefing, not human input.
  const localSessionIntent = extractDirectIntent(currentMessages, request.sessionID, {
    skipFirstUserMessage: lineage.depth > 0,
  })
  const limit = Math.max(config.intentMessages, 4)

  const directUserIntent: IntentBlock[] = [...localSessionIntent]
  const delegatedTask: IntentBlock[] = []

  // Immediate parent: delegation that created/instructed this session.
  const parent = lineage.nodes[1]
  if (parent) {
    const parentMessages = await fetchMessagesBounded(client, parent.sessionID, directory, limit)
    delegatedTask.push(
      ...extractDelegatedTasks(parentMessages, parent.sessionID, request.sessionID),
    )
    directUserIntent.push(...extractDirectIntent(parentMessages, parent.sessionID))
  }

  // Root session (if distinct from parent AND from the current session whose
  // messages we already hold): authoritative user intent.
  const root = lineage.nodes[lineage.nodes.length - 1]
  if (root && root !== parent && root.sessionID !== request.sessionID) {
    const rootMessages = await fetchMessagesBounded(client, root.sessionID, directory, limit)
    directUserIntent.push(...extractDirectIntent(rootMessages, root.sessionID))
  }

  // Pick by creation time, not by array position: the intent arrays are
  // concatenated local → parent → root, so the last element is the root's
  // latest message even when the current session holds much newer input. When
  // no block carries a timestamp, fall back to the last recovered block.
  const timestamped = directUserIntent.filter((block) => block.createdAt !== undefined)
  const latestExplicitAuthorization =
    timestamped.length > 0
      ? timestamped.reduce((best, block) =>
          (block.createdAt ?? 0) > (best.createdAt ?? 0) ? block : best,
        )
      : directUserIntent[directUserIntent.length - 1]

  const reasons: string[] = []
  if (delegatedTask.length === 0) reasons.push("no delegation subtask located in parent session")
  if (lineage.missingParents.length > 0)
    reasons.push(`missing parents: ${lineage.missingParents.join(", ")}`)
  if (directUserIntent.length === 0) reasons.push("no direct user intent recovered")

  const completeness: IntentContext["completeness"] =
    directUserIntent.length > 0 && delegatedTask.length > 0
      ? "complete"
      : directUserIntent.length > 0 || localSessionIntent.length > 0
        ? "partial"
        : "insufficient"

  return {
    directUserIntent,
    delegatedTask,
    localSessionIntent,
    conflictingInstructions: [],
    ...(latestExplicitAuthorization === undefined ? {} : { latestExplicitAuthorization }),
    completeness,
    ...(reasons.length === 0 ? {} : { reasons }),
  }
}

// --- actor context assembly -------------------------------------------------

function resolveProfile(
  agentName: string | undefined,
  config: ReviewerConfig,
): Provenanced<ActorProfile> {
  if (agentName !== undefined) {
    const mapped = config.actorProfiles[agentName]
    if (mapped !== undefined) {
      return prov<ActorProfile>(mapped, "global-config", "confirmed")
    }
  }
  return UNKNOWN_PROFILE
}

function assembleActorContext(
  request: PermissionRequest,
  current: CurrentActor,
  lineage: SessionLineage,
  config: ReviewerConfig,
): ActorContext {
  const agentName =
    current.agentName !== undefined
      ? prov<string | undefined>(
          current.agentName,
          "tool-message",
          current.toolLocated ? "confirmed" : "high",
        )
      : UNKNOWN_STRING
  const mode =
    current.mode !== undefined
      ? prov<string | undefined>(
          current.mode,
          "tool-message",
          current.toolLocated ? "confirmed" : "high",
        )
      : UNKNOWN_STRING

  const parent = lineage.nodes[1]
  const parentSessionID =
    parent !== undefined
      ? prov<string | undefined>(parent.sessionID, "session-api", "confirmed")
      : prov<string | undefined>(undefined, "unavailable", "unknown")

  const identityCompleteness: ActorContext["identityCompleteness"] =
    current.agentName !== undefined && current.mode !== undefined
      ? "complete"
      : current.agentName !== undefined || current.mode !== undefined
        ? "partial"
        : "unknown"

  return {
    agentName,
    mode,
    profile: resolveProfile(current.agentName, config),
    sessionID: request.sessionID,
    parentSessionID,
    rootSessionID: prov<string>(
      lineage.rootSessionID,
      "session-api",
      lineage.depth > 0 ? "confirmed" : "unknown",
    ),
    delegationDepth: prov<number>(
      lineage.depth,
      "session-api",
      lineage.depth > 0 ? "confirmed" : "unknown",
    ),
    identityCompleteness,
  }
}

function assessCompleteness(
  actor: ActorContext,
  lineage: SessionLineage,
  intent: IntentContext,
): EvidenceCompleteness {
  const reasons: string[] = []
  if (actor.identityCompleteness === "unknown") reasons.push("actor identity unavailable")
  if (lineage.depth === 0) reasons.push("no parent lineage resolved")
  if (lineage.missingParents.length > 0)
    reasons.push(`missing parents: ${lineage.missingParents.join(", ")}`)
  if (intent.directUserIntent.length === 0) reasons.push("no direct user intent recovered")
  if (intent.delegatedTask.length === 0 && lineage.depth > 0)
    reasons.push("no delegation task located")

  const actorOk = actor.identityCompleteness !== "unknown"
  const lineageOk = lineage.depth > 0
  const directOk = intent.directUserIntent.length > 0
  const delegatedOk = intent.delegatedTask.length > 0
  // purpose is filled later by the evidence assembler; default false here so
  // callers that only run the resolver still see an explicit flag.
  const purposeOk = false
  const score = [true, actorOk, lineageOk, directOk, delegatedOk].filter(Boolean).length
  const overall: EvidenceCompleteness["overall"] =
    score >= 4 ? "sufficient" : score >= 2 ? "partial" : "insufficient"

  return {
    permission: true,
    actor: actorOk,
    lineage: lineageOk,
    directUserIntent: directOk,
    delegatedTask: delegatedOk,
    purpose: purposeOk,
    capability: false, // no provider produces capability facts yet
    repositoryState: false, // git evidence exists only as enrichment text today
    referencedCode: false,
    reasons,
    overall,
  }
}

// --- public entry point (resilient) -----------------------------------------

/**
 * Resolve actor, lineage and intent for a permission request.
 * NEVER throws: on any failure it returns an "unknown" resolution so the review
 * proceeds. Callers thread the result into the prompt and audit as evidence.
 */
export async function resolveActorContext(
  request: PermissionRequest,
  messages: MessageWithParts[],
  client: OpenCodeClientLike,
  directory: string,
  config: ReviewerConfig,
): Promise<ActorResolution> {
  try {
    const current = resolveCurrentActor(request, messages)
    const lineage = await walkLineage(client, request.sessionID, directory, config)
    const intent = await resolveIntent(request, messages, lineage, client, directory, config)
    const actor = assembleActorContext(request, current, lineage, config)
    const completeness = assessCompleteness(actor, lineage, intent)
    return { actor, lineage, intent, completeness }
  } catch (error) {
    return unknownResolution(request, error)
  }
}

/** Fallback used when resolution fails outright. Exposed for tests. */
export function unknownResolution(request: PermissionRequest, error: unknown): ActorResolution {
  const message = error instanceof Error ? error.message : String(error)
  const lineage: SessionLineage = {
    nodes: [{ sessionID: request.sessionID }],
    rootSessionID: request.sessionID,
    depth: 0,
    cycleDetected: false,
    truncated: false,
    missingParents: [],
  }
  const actor: ActorContext = {
    agentName: UNKNOWN_STRING,
    mode: UNKNOWN_STRING,
    profile: UNKNOWN_PROFILE,
    sessionID: request.sessionID,
    parentSessionID: UNKNOWN_STRING,
    rootSessionID: prov<string>(request.sessionID, "unavailable", "unknown"),
    delegationDepth: prov<number>(0, "unavailable", "unknown"),
    identityCompleteness: "unknown",
  }
  const intent: IntentContext = {
    directUserIntent: [],
    delegatedTask: [],
    localSessionIntent: [],
    conflictingInstructions: [],
    completeness: "insufficient",
  }
  return {
    actor,
    lineage,
    intent,
    completeness: {
      permission: true,
      actor: false,
      lineage: false,
      directUserIntent: false,
      delegatedTask: false,
      purpose: false,
      capability: false,
      repositoryState: false,
      referencedCode: false,
      reasons: [`actor resolution failed: ${message}`],
      overall: "insufficient",
    },
  }
}
