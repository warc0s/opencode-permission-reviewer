import { DEFAULT_CONFIG } from "../src/config.ts"
import type { OpenCodeClientLike, RuntimeContext } from "../src/runtime.ts"
import { ApprovalReviewerRuntime } from "../src/runtime.ts"
import { probeCapabilities } from "../src/opencode/capability-detection.ts"
import type {
  PermissionRequest,
  ReviewAuditRecord,
  ReviewDecision,
  ReviewerConfig,
} from "../src/types.ts"
import type { ReviewUiStatus } from "../src/ui-protocol.ts"

export function decision(
  outcome: ReviewDecision["outcome"],
  overrides: Partial<ReviewDecision> = {},
): ReviewDecision {
  return {
    version: 2,
    outcome,
    risk_level: outcome === "deny" ? "high" : "low",
    user_authorization: outcome === "allow" ? "high" : "low",
    rationale:
      outcome === "allow"
        ? "The action is narrow, reversible, and explicitly requested."
        : "The action has unsafe unrequested effects.",
    confidence: 0.95,
    scope_alignment: "aligned",
    evidence_completeness: "sufficient",
    ...overrides,
  }
}

export function request(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: "per_1",
    sessionID: "ses_main",
    permission: "bash",
    patterns: ["printf safe"],
    metadata: { command: "printf safe" },
    always: ["printf *"],
    tool: { messageID: "msg_1", callID: "call_1" },
    ...overrides,
  }
}

export class MockClient implements OpenCodeClientLike {
  readonly creates: unknown[] = []
  readonly messageQueries: unknown[] = []
  readonly prompts: unknown[] = []
  readonly deletes: unknown[] = []
  readonly toolQueries: unknown[] = []
  readonly replies: unknown[] = []
  readonly uiStatuses: ReviewUiStatus[] = []
  nextStructured: unknown = decision("allow")
  /** When set, `session.prompt` returns text parts instead of `info.structured`. */
  nextText: string | undefined
  /** Per-call text responses for `session.prompt`; shifted in order, overrides `nextText`. */
  nextTexts: string[] = []
  promptImpl?: (options: unknown) => Promise<{ data?: Record<string, unknown>; error?: unknown }>
  messagesImpl?: (options: unknown) => Promise<{ data?: unknown; error?: unknown }>
  messageData: unknown = [
    {
      info: { id: "msg_user", role: "user" },
      parts: [{ type: "text", text: "Run the narrow safe command." }],
    },
    {
      info: { id: "msg_assistant", role: "assistant" },
      parts: [
        {
          type: "tool",
          tool: "bash",
          callID: "call_1",
          state: { input: { command: "printf safe" } },
        },
      ],
    },
  ]
  createError?: unknown
  messagesError?: unknown
  promptError?: unknown
  replyError?: unknown
  publishStatusError?: unknown
  toolIdsError?: unknown
  private sessionCounter = 0

  session: OpenCodeClientLike["session"]
  tool: OpenCodeClientLike["tool"]

  constructor() {
    this.session = {
      create: async (options: unknown) => {
        this.creates.push(options)
        if (this.createError !== undefined) return { error: this.createError }
        this.sessionCounter += 1
        return { data: { id: `ses_review_${this.sessionCounter}` } }
      },
      messages: async (options: unknown) => {
        this.messageQueries.push(options)
        if (this.messagesImpl) return this.messagesImpl(options)
        if (this.messagesError !== undefined) return { error: this.messagesError }
        return { data: this.messageData }
      },
      prompt: async (options: unknown) => {
        this.prompts.push(options)
        if (this.promptImpl) return this.promptImpl(options)
        if (this.promptError !== undefined) return { error: this.promptError }
        if (this.nextTexts.length > 0) {
          const text = this.nextTexts.shift()!
          return {
            data: {
              info: { id: "msg_review", role: "assistant" },
              parts: [{ type: "text", text }],
            },
          }
        }
        if (this.nextText !== undefined) {
          return {
            data: {
              info: { id: "msg_review", role: "assistant" },
              parts: [{ type: "text", text: this.nextText }],
            },
          }
        }
        return { data: { info: { structured: this.nextStructured } } }
      },
      delete: async (options: unknown) => {
        this.deletes.push(options)
        return { data: true }
      },
    }
    this.tool = {
      ids: async (options?: unknown) => {
        this.toolQueries.push(options)
        if (this.toolIdsError !== undefined) return { error: this.toolIdsError }
        return { data: ["bash", "read", "write", "webfetch", "task"] }
      },
    }
  }

  permissionReply = async (options: unknown) => {
    this.replies.push(options)
    if (this.replyError !== undefined) return { error: this.replyError }
    return { data: true }
  }

  publishUiStatus = async (status: ReviewUiStatus) => {
    this.uiStatuses.push(status)
    if (this.publishStatusError !== undefined) return { error: this.publishStatusError }
    return { data: true }
  }
}

export function config(overrides: Partial<ReviewerConfig> = {}): ReviewerConfig {
  return { ...DEFAULT_CONFIG, ...overrides }
}

export function runtime(
  client = new MockClient(),
  configOverrides: Partial<ReviewerConfig> = {},
  logger?: (message: string, details?: unknown) => void,
  contextOverrides: Partial<Pick<RuntimeContext, "directory" | "worktree">> = {},
): { runtime: ApprovalReviewerRuntime; client: MockClient; ctx: RuntimeContext } {
  const auditRecords: ReviewAuditRecord[] = []
  const ctx: RuntimeContext = {
    client,
    capabilities: probeCapabilities(client),
    permissionReply: client.permissionReply,
    publishUiStatus: client.publishUiStatus,
    writeAudit: async (record) => {
      auditRecords.push(record)
    },
    directory: contextOverrides.directory ?? "/workspace/project",
    worktree: contextOverrides.worktree ?? contextOverrides.directory ?? "/workspace/project",
  }
  return {
    runtime: new ApprovalReviewerRuntime(ctx, config(configOverrides), logger),
    client,
    ctx: Object.assign(ctx, { auditRecords }),
  }
}
