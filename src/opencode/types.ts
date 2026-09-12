import type { ReviewAuditRecord } from "../types.ts"
import type { OpenCodeCapabilities } from "./adapter.ts"
import type { ReviewUiStatus } from "../ui-protocol.ts"

export interface ClientResponse<T> {
  data?: T
  error?: unknown
}

export interface OpenCodeClientLike {
  session: {
    create(options: unknown): Promise<ClientResponse<Record<string, unknown>>>
    messages(options: unknown): Promise<ClientResponse<unknown>>
    prompt(options: unknown): Promise<ClientResponse<Record<string, unknown>>>
    delete?(options: unknown): Promise<ClientResponse<unknown>>
    /** Fetch session metadata (parentID, title, …). Optional: the actor resolver
     *  degrades to "lineage unavailable" when the host client does not expose it. */
    get?(options: unknown): Promise<ClientResponse<unknown>>
  }
  tool: {
    ids(options?: unknown): Promise<ClientResponse<string[]>>
  }
}

export interface RuntimeContext {
  client: OpenCodeClientLike
  /** What the plugin learned about the host client at startup (probe result).
   *  Surfaced to diagnostics and available to any future adapter consumer. */
  capabilities: OpenCodeCapabilities
  permissionReply(options: unknown): Promise<ClientResponse<unknown>>
  publishUiStatus?(status: ReviewUiStatus): Promise<ClientResponse<unknown>>
  writeAudit?(record: ReviewAuditRecord): Promise<void>
  directory: string
  worktree: string
  /** Where reviewer sessions run when isolation is available: a directory
   *  without project instructions or project config. Production resolves the
   *  shared data directory; tests inject a scratch path so they never touch
   *  the developer's HOME. */
  reviewerDirectoryBase?: string
}

// Re-export for convenience.
export type { ReviewUiStatus }
