export type RiskLevel = "low" | "medium" | "high" | "critical"
export type UserAuthorization = "high" | "medium" | "low" | "unknown"
export type ReviewOutcome = "allow" | "deny" | "escalate"
export type ScopeAlignment = "aligned" | "partial" | "misaligned" | "unknown"
export type EvidenceSufficiency = "sufficient" | "partial" | "insufficient" | "unknown"
/** How final escalations are disposed after reviewer/policy/fail-safe produce them. */
export type EscalationMode = "manual" | "deny"
/** Effective disposition applied to an internal escalate result. */
export type EscalationDisposition = "manual" | "deny"

export interface ReviewDecision {
  /** Structured-decision schema version. Always 2 for the current schema. */
  version: 2
  outcome: ReviewOutcome
  risk_level: RiskLevel
  user_authorization: UserAuthorization
  /** How well the request aligns with the recovered user/delegated intent. */
  scope_alignment: ScopeAlignment
  /** Whether the evidence was sufficient to decide confidently. */
  evidence_completeness: EvidenceSufficiency
  rationale: string
  confidence: number
}

export interface PermissionToolSource {
  messageID: string
  callID: string
}

export interface PermissionRequest {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
  tool?: PermissionToolSource
}

export interface MessageWithParts {
  info: Record<string, unknown> & {
    id?: string
    role?: string
    structured?: unknown
  }
  parts: Array<Record<string, unknown>>
}

/** Deterministic risk×authorization matrix that gates reviewer `allow`
 *  outcomes. For each risk level, lists the authorization levels that permit an
 *  auto-allow. An empty array means no authorization permits auto-allow at that
 *  risk (the action is escalated). Only ever RESTRICTS; deny/escalate are always
 *  preserved. */
export interface RiskPolicy {
  allow: {
    low: UserAuthorization[]
    medium: UserAuthorization[]
    high: UserAuthorization[]
    critical: UserAuthorization[]
  }
  minimumConfidence: number
  onInvalidDecision: "manual" | "deny"
  onReviewerFailure: "manual" | "deny"
}

/** Conservative repository trust model. A repository cannot mark itself trusted
 *  through project configuration alone — trust comes from global config or an
 *  interactive decision stored outside the repo. */
export type RepositoryTrust = "trusted" | "untrusted" | "unknown"

/** A declarative policy condition: matches capability/actor facts. Every field
 *  is optional; the rule matches when ALL specified fields match. */
export interface PolicyCondition {
  actionClass?: CapabilityActionClass[]
  actorProfile?: ActorProfile[]
  writesWorkspace?: boolean
  writesExternal?: boolean
  writesTemporary?: boolean
  deletion?: boolean
  executesCode?: boolean
  createsAdHocCode?: boolean
  packageManagement?: boolean
  gitMutation?: boolean
  networkObserved?: boolean
  privilegeEscalation?: boolean
  remoteEnabled?: boolean
  persistence?: boolean
  repositoryTrust?: RepositoryTrust[]
}

/** A declarative rule that routes a request based on capability+actor facts. */
export interface PolicyRule {
  id: string
  source: "builtin" | "global" | "project" | "inline"
  when: PolicyCondition
  effect: "review" | "manual" | "deny" | "allow"
  reason: string
}

/** The result of evaluating the declarative policy. */
export interface PolicyTrace {
  /** Stable hash of the effective rule set (not the matched rules) for audit
   *  reproducibility. */
  effectivePolicyHash: string
  matchedRules: Array<{ id: string; source: string; effect: string; reason: string }>
  /** The route the engine computed (counterfactual in observe mode: what enforce
   *  mode WOULD have done with the same facts and rules). */
  finalRoute: "review" | "manual" | "deny" | "allow"
  mode: "observe" | "enforce"
}

export type ReviewerOutputFormat = "json_schema" | "text"

export interface ReviewerConfig {
  model: string
  variant: string
  /** How the reviewer model returns its decision. `json_schema` requests
   *  OpenCode's structured-output format (requires provider support); `text`
   *  asks the model to emit JSON in plain text and parses it locally. */
  outputFormat: ReviewerOutputFormat
  timeoutMs: number
  maxContextChars: number
  maxPartChars: number
  maxEnrichmentChars: number
  maxIntentChars: number
  transcriptMessages: number
  intentMessages: number
  historyMessages: number
  confidenceThreshold: number
  retainReviewSessions: boolean
  audit: boolean
  auditPath?: string
  policy?: string
  debug: boolean
  /** When "observe", actor evidence is collected and audited but never enforces
   *  new gates; "enforce" applies declarative policy routes. */
  enforcementMode: "observe" | "enforce"
  /**
   * How internal `escalate` results are disposed before UI/reply.
   * - `manual` (default): leave the request for a human (interactive mode).
   * - `deny`: convert every final escalation into a reject with rationale
   *   (non-interactive fail-closed). Never relaxes an explicit deny.
   */
  escalationMode: EscalationMode
  /** Max hops when walking session parents (default 8). */
  maxSessionDepth: number
  /** Max parent sessions fetched during lineage traversal. */
  maxParentSessions: number
  /** Trusted name→profile mappings (empty by default; no mappings shipped). */
  actorProfiles: Record<string, ActorProfile>
  /** Deterministic risk×authorization gate, configurable but defaults reproduce
   *  the previous hard-coded matrix exactly. */
  riskPolicy: RiskPolicy
  /** Repository trust level derived from global config (never from project). */
  repositoryTrust: RepositoryTrust
  /** Declarative policy rules (empty by default; observe mode audits the trace
   *  without enforcing). Project-sourced allow rules are rejected. */
  policyRules: PolicyRule[]
  /** Capture user answers to agent ask dialogs (question tool) and surface
   *  them to the reviewer as scoped authorization evidence. */
  askDecisions: boolean
}

export interface ReviewEnvelope {
  request: PermissionRequest
  directory: string
  worktree: string
  transcript: string
  intentHistory: string
  enrichment: string
  sshAudit: NonNullable<ReviewAuditRecord["ssh"]>
  preflightDenial?: string
  /** Agent-aware context (actor, lineage, intent). Observe-only: flows into the
   *  reviewer prompt and audit as evidence, never into enforcement decisions.
   *  Optional so older callers/tests still compile. */
  actor?: ActorContext
  lineage?: SessionLineage
  intent?: IntentContext
  evidenceCompleteness?: EvidenceCompleteness
  /** Structured capability facts derived from the bash command. Observe-only:
   *  feeds the reviewer prompt and audit, never enforcement. */
  capability?: CapabilityAssessment
  /** The policy trace produced for this request, surfaced to the reviewer prompt
   *  as EFFECTIVE_POLICY_SUMMARY and to audit. Observe-only. */
  policyTrace?: PolicyTrace
  /** Per-phase timing captured during evidence assembly (context/enrichment).
   *  The reviewer and reply phases are timed in the coordinator. */
  timings?: { contextMs?: number; enrichmentMs?: number }
  /** The parsed command reused across evidence providers. */
  parsedCommand?: ParsedCommand
  /** Operational purpose of the pending action (evidence, never authorization). */
  actionPurpose?: ActionPurpose
  /** User answers to agent ask dialogs in this session or its ancestors,
   *  captured live from question events. Observe-only: flows into the reviewer
   *  prompt (USER_ASK_DECISIONS) and audit, never into enforcement. */
  askDecisions?: AskDecision[]
}

/** Which layer produced the final decision for a request. Threaded into the
 *  audit record so reports can split outcomes by source. */
export type DecisionSource =
  "emergency-brake" | "deterministic-policy" | "llm-reviewer" | "manual-superseded" | "failure-safe"

export interface ReviewAuditRecord {
  /**
   * Audit schema version. Present on every record; readers default a missing
   * field to `1` (additive — old records are still valid).
   * Bump only on a breaking change to the record shape.
   */
  schemaVersion?: number
  /** Version of the structured-decision schema the reviewer was asked to emit. */
  decisionSchemaVersion?: number
  /** Version of the reviewer system prompt used for this decision. */
  promptVersion?: string
  /** Which layer produced the outcome (brake, policy, reviewer, supersede,
   *  failure-safe). Absent on legacy v1 records. */
  decisionSource?: DecisionSource
  timestamp: string
  durationMs: number
  requestID: string
  sessionID: string
  permission: string
  /** Stable hash of the canonical request (permission, patterns, metadata,
   *  tool) for cross-record correlation. Absent on legacy v1 records. */
  actionHash?: string
  outcome: ReviewExecutionResult["kind"]
  reason: string
  riskLevel?: RiskLevel
  userAuthorization?: UserAuthorization
  /** How well the action aligned with the recovered intent (from the reviewer
   *  decision). Absent when no reviewer decision was reached. */
  scopeAlignment?: ScopeAlignment
  confidence?: number
  /**
   * Structured outcome emitted by the reviewer LLM before gates/disposition.
   * Absent when no valid structured decision was produced (brake, policy,
   * failure-safe, supersede).
   */
  reviewerOutcome?: ReviewOutcome
  /**
   * How an internal escalate was disposed. Present only when the logical result
   * was escalate (or a gate converted allow→escalate) and enforcement chose
   * manual or deny. Absent for explicit deny, allow, and manual-superseded.
   */
  escalationDisposition?: EscalationDisposition
  /** The reviewer model used for this request (config.model). */
  reviewerModel?: string
  /** Per-phase timings. Absent on legacy v1 records and on deterministic paths
   *  that never reach that phase. */
  timings?: { contextMs?: number; enrichmentMs?: number; reviewerMs?: number; replyMs?: number }
  /** Non-fatal warnings accumulated during evidence collection/analysis. */
  warnings?: string[]
  reviewerSessionID?: string
  /** Root session of the request's ancestry (additive; absent when lineage was
   *  unavailable). */
  rootSessionID?: string
  /** Overall evidence completeness for the request (additive). */
  evidenceCompleteness?: string
  /** Resolved actor snapshot for audit (additive). Uses identityCompleteness
   *  (not the decision's numeric confidence) to avoid field ambiguity; v2 also
   *  carries identitySource + confidence. */
  actor?: {
    name?: string
    mode?: string
    profile: ActorProfile
    identityCompleteness: "complete" | "partial" | "unknown"
    /** How the agent identity was established (tool-message, session-api,
     *  unavailable, …). Absent on legacy v1 records. */
    identitySource?: string
    /** Reliability of the identity claim. Absent on legacy v1 records. */
    confidence?: EvidenceConfidence
    delegationDepth?: number
  }
  ssh?: Array<{
    destination: string
    port?: string
    remoteCommandSha256?: string
    stdinSource?: string
    stdinStatus?: string
    stdinReason?: string
  }>
  /** Additive capability snapshot for audit (observe-only). */
  capability?: {
    actionClass: string
    summary: string
    parserCompleteness: string
    executesCode?: boolean
    createsAdHocCode?: boolean
    invokesPackageLifecycleScripts?: boolean
    writeEffects?: {
      temporaryWrite?: boolean
      workspaceWrite?: boolean
      externalWrite?: boolean
      deletion?: boolean
    }
    networkObserved?: boolean
    privilegeEscalation?: boolean
    persistence?: boolean
    remoteEnabled?: boolean
    gitMutation?: boolean
  }
  /** Additive policy trace for audit (observe-only). */
  policyTrace?: {
    effectivePolicyHash: string
    matchedRules: Array<{ id: string; source: string; effect: string; reason: string }>
    finalRoute: string
    mode: string
  }
  /** Additive snapshot of the ask decisions surfaced to the reviewer prompt
   *  (observe-only; capped to the most recent few). */
  askDecisions?: Array<{ at: number; question: string; answer: string }>
}

export interface ApprovedAnnotation {
  requestID: string
  sessionID: string
  decision: ReviewDecision
}

export interface ReviewExecutionResult {
  kind: "allow" | "deny" | "escalate"
  decision?: ReviewDecision
  reason: string
  reviewSessionID?: string
  /** Which layer produced this result; threaded into the audit record. */
  decisionSource?: DecisionSource
  /**
   * Structured outcome from the reviewer LLM before gates/disposition.
   * Absent when no valid structured decision was produced.
   */
  reviewerOutcome?: ReviewOutcome
  /**
   * How an internal escalate was disposed at the enforcement boundary.
   * Absent when the result was never an escalate (explicit allow/deny) or when
   * the request was already answered manually (`manual-superseded`).
   */
  escalationDisposition?: EscalationDisposition
}

// ---------------------------------------------------------------------------
// Agent-aware context data model.
//
// These types carry actor/lineage/intent evidence alongside a permission
// request. They flow into the reviewer prompt (as evidence sections) and the
// audit record (additive fields) WITHOUT changing enforcement: the v1 decision
// schema and enforceDecision are untouched (observe-only by default).
// ---------------------------------------------------------------------------

/** Reliability of a derived fact. */
export type EvidenceConfidence = "confirmed" | "high" | "medium" | "low" | "unknown"

/** Every non-trivial derived fact carries provenance so the LLM and audit can
 *  weigh claims by how reliably they were established. */
export interface Provenanced<T> {
  value: T
  source:
    | "permission-event"
    | "tool-message"
    | "session-api"
    | "parent-session"
    | "global-config"
    | "project-config"
    | "effective-permissions"
    | "static-analysis"
    | "heuristic"
    | "unavailable"
  confidence: EvidenceConfidence
  notes?: string[]
}

/** Generic policy templates, NOT automatic trust levels. */
export type ActorProfile =
  "read-only" | "validation" | "workspace" | "operator" | "reviewer" | "unknown"

/** Normalized effective-permission summary when the SDK exposes it.
 *  The v1 SDK does not expose effective rules, so this stays `undefined`. */
export interface EffectivePermissionSummary {
  edit: "allow" | "ask" | "deny" | "mixed" | "unknown"
  bash: "allow" | "ask" | "deny" | "mixed" | "unknown"
  task: "allow" | "ask" | "deny" | "mixed" | "unknown"
  externalDirectory: "allow" | "ask" | "deny" | "mixed" | "unknown"
  source: "session" | "agent-config" | "derived" | "unknown"
}

/** Who is requesting the permission. */
export interface ActorContext {
  agentName: Provenanced<string | undefined>
  mode: Provenanced<string | undefined>
  profile: Provenanced<ActorProfile>
  sessionID: string
  parentSessionID: Provenanced<string | undefined>
  rootSessionID: Provenanced<string>
  delegationDepth: Provenanced<number>
  effectivePermissions?: EffectivePermissionSummary
  identityCompleteness: "complete" | "partial" | "unknown"
}

/** A node in the session ancestry chain. */
export interface SessionNode {
  sessionID: string
  parentID?: string
  title?: string
  version?: string
  actorName?: string
  mode?: string
  createdAt?: number
}

/** The resolved session ancestry with failure modes made explicit. */
export interface SessionLineage {
  nodes: SessionNode[]
  rootSessionID: string
  depth: number
  cycleDetected: boolean
  truncated: boolean
  missingParents: string[]
}

/** A single authorization/intent statement. */
export interface IntentBlock {
  sessionID: string
  messageID: string
  actor: "user" | "assistant" | "system" | "unknown"
  text: string
  synthetic: boolean
  createdAt?: number
  provenance: Provenanced<"intent">
}

/** One user decision on an agent-initiated ask dialog (question tool). The
 *  question text is agent-generated and untrusted; only the answer is a user
 *  authorization signal, scoped to the subject and time of the ask. */
export interface AskDecision {
  /** Epoch ms when the reply (or dismissal) was observed. */
  at: number
  /** What the agent asked, already redacted and truncated. */
  question: string
  /** The option labels the user selected, or a dismissal marker. */
  answer: string
}

/** Direct user intent kept separate from delegated task. */
export interface IntentContext {
  directUserIntent: IntentBlock[]
  delegatedTask: IntentBlock[]
  localSessionIntent: IntentBlock[]
  conflictingInstructions: string[]
  latestExplicitAuthorization?: IntentBlock
  completeness: "complete" | "partial" | "insufficient"
}

/** Meta-summary of what evidence was available. */
export interface EvidenceCompleteness {
  permission: boolean
  actor: boolean
  lineage: boolean
  directUserIntent: boolean
  delegatedTask: boolean
  /** Whether a non-unavailable ACTION_PURPOSE was recovered. */
  purpose: boolean
  capability: boolean
  repositoryState: boolean
  referencedCode: boolean
  reasons: string[]
  overall: "sufficient" | "partial" | "insufficient"
}

/**
 * Operational purpose of the pending action — what the agent appears to be
 * trying to accomplish. This is untrusted evidence: it never demonstrates
 * user authorization by itself.
 */
export interface ActionPurpose {
  text?: string
  source: "agent-context" | "intent-derived" | "unavailable"
  confidence: EvidenceConfidence
}

// ---------------------------------------------------------------------------
// Capability analysis. The analyzer produces these facts from the bash
// command using the existing shell lexer; each fact is evidence for the reviewer
// prompt, never a final safety decision. Fields default to "unknown" when no
// detector covers them yet.
// ---------------------------------------------------------------------------

/** How completely the command could be statically analyzed. */
export type ParserCompleteness =
  /** Fully parsed: no variables, globs, substitutions, or heredoc bodies. */
  | "complete-for-supported-form"
  /** Some constructs could not be resolved (variables, partial heredoc). */
  | "partial"
  /** Heavy dynamic constructs (command substitution, eval, dynamic heredoc). */
  | "opaque"

/** A redirection extracted from a parsed command segment. */
export interface Redirection {
  /** `>` `>>` `<` `2>` `&>` etc. */
  operator: string
  /** Target path (file descriptor targets normalized to a path when possible). */
  target: string
  /** Whether the target was quoted in the source (affects literal-ness). */
  quoted: boolean
}

/** A heredoc extracted before lexing so its body never reaches the lexer/brake. */
export interface HeredocRecord {
  /** The literal delimiter token as it appeared (`EOF`, `END`, …). */
  delimiter: string
  /** `<<` (expansion on) or `<<-` (tabs stripped) — normalized form. */
  operator: string
  /** Whether the delimiter was quoted, disabling expansion (`<<'EOF'`). */
  expansionDisabled: boolean
  /** Bounded + redacted body (truncated to a safe length). */
  bodyBounded: string
  /** SHA-256 of the full, unredacted body (stable identity without leaking it). */
  bodySha256: string
  /** Whether the body was truncated for storage. */
  truncated: boolean
  /** Output path associated with the heredoc when a `> path` precedes it. */
  outputTarget?: string
  /** Whether the body is dynamically constructed (unresolvable expansion). */
  dynamic: boolean
}

/** A command parsed into a reusable structure. Wraps the existing lexer output
 *  plus pre-extracted redirections and heredocs; the emergency brake keeps using
 *  the raw lexer functions unchanged. */
export interface ParsedCommand {
  /** The command after heredoc bodies were replaced with placeholders. */
  sanitizedCommand: string
  /** Lexed segments of the sanitized command. */
  segments: import("./shell-lexer.ts").ShellSegment[]
  /** Effective commands (wrappers peeled) per segment. */
  effective: import("./shell-lexer.ts").ShellToken[][]
  /** Redirections grouped by segment index. */
  redirections: Redirection[][]
  /** Heredocs extracted before lexing. */
  heredocs: HeredocRecord[]
  /** Whether the original command contained any dynamic constructs. */
  hasDynamicConstructs: boolean
}

/** High-level classification of what the action does. */
export type CapabilityActionClass =
  | "read-only"
  | "workspace-write"
  | "temporary-write"
  | "external-write"
  | "destruction"
  | "code-execution"
  | "package-management"
  | "git-mutation"
  | "network"
  | "remote-operation"
  | "service-management"
  | "persistence"
  | "privilege-escalation"
  | "unknown"

/** What the action can do, what it appears to do, and analysis confidence. */
export interface CapabilityAssessment {
  /** Best single-label summary of the dominant capability. */
  actionClass: Provenanced<CapabilityActionClass>
  /** Human-readable summary of the detected surface. */
  summary: string
  /** Executes an interpreter or runtime (sh, python, node, bun, …). */
  executesCode: Provenanced<boolean | "unknown">
  /** Executes code that lives in the repository (scripts, test files). */
  executesRepositoryCode: Provenanced<boolean | "unknown">
  /** Executes ad-hoc code generated by the agent (heredoc/inline). */
  createsAdHocCode: Provenanced<boolean | "unknown">
  /** Invokes a known test runner (pytest, jest, bun test, …). */
  invokesExistingTestRunner: Provenanced<boolean | "unknown">
  /** Runs a package manager that may execute lifecycle scripts. */
  invokesPackageLifecycleScripts: Provenanced<boolean | "unknown">
  /** Detected file-write surface. */
  writeEffects: {
    temporaryWrite: Provenanced<boolean | "unknown">
    workspaceWrite: Provenanced<boolean | "unknown">
    externalWrite: Provenanced<boolean | "unknown">
    deletion: Provenanced<boolean | "unknown">
  }
  /** Detected network surface. */
  network: {
    observed: Provenanced<boolean | "unknown">
    possible: Provenanced<boolean | "unknown">
    /** Hosts/destinations observed literally in the command. */
    destinations: string[]
    observedAccess: Provenanced<boolean | "unknown">
    possibleAccess: Provenanced<boolean | "unknown">
  }
  /** Detected process side-effects. */
  process: {
    childProcesses: Provenanced<boolean | "unknown">
    persistence: Provenanced<boolean | "unknown">
    privilegeEscalation: Provenanced<boolean | "unknown">
  }
  /** Detected remote-operation surface (ssh, etc.). */
  remote: {
    enabled: Provenanced<boolean | "unknown">
    mutationHint: Provenanced<boolean | "unknown">
  }
  /** Detected git mutation surface. */
  git: {
    observed: Provenanced<boolean | "unknown">
    possible: Provenanced<boolean | "unknown">
    observedAccess: Provenanced<boolean | "unknown">
    possibleAccess: Provenanced<boolean | "unknown">
  }
  /** How completely the command could be analyzed. */
  parserCompleteness: ParserCompleteness
  /** Free-form warnings about analysis limitations. */
  analysisWarnings: string[]
}
