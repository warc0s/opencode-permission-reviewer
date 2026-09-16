import type { PermissionRequest } from "./types.ts"
import {
  UI_START_GRACE_MS,
  UI_WATCHDOG_GRACE_MS,
  createUiStatus,
  type ReviewUiStatus,
} from "./ui-protocol.ts"

export interface UiStateOptions {
  model: string
  variant: string
  timeoutMs: number
}

export const RESULT_DISPLAY_MS = {
  approved: 5_000,
  denied: 5_000,
} as const

export class ReviewUiState {
  private readonly requests = new Map<string, ReviewUiStatus>()
  private readonly acknowledged = new Set<string>()

  constructor(private readonly options: UiStateOptions) {}

  asked(request: PermissionRequest, now = Date.now()): ReviewUiStatus {
    const existing = this.requests.get(request.id)
    if (existing) return existing
    const status = createUiStatus(request, "reviewing", { ...this.options, emittedAt: now })
    this.requests.set(request.id, status)
    return status
  }

  apply(status: ReviewUiStatus): boolean {
    const current = this.requests.get(status.requestID)
    if (current && !this.acknowledged.has(status.requestID)) {
      this.requests.set(
        status.requestID,
        status.phase === "reviewing" ? { ...status, emittedAt: current.emittedAt } : status,
      )
      this.acknowledged.add(status.requestID)
      return true
    }
    if (current && status.emittedAt < current.emittedAt) return false
    this.requests.set(status.requestID, status)
    this.acknowledged.add(status.requestID)
    return true
  }

  replied(requestID: string): void {
    const current = this.requests.get(requestID)
    if (!current || current.phase === "approved" || current.phase === "denied") return
    this.requests.delete(requestID)
    this.acknowledged.delete(requestID)
  }

  remove(requestID: string): void {
    this.requests.delete(requestID)
    this.acknowledged.delete(requestID)
  }

  get(requestID: string): ReviewUiStatus | undefined {
    return this.requests.get(requestID)
  }

  all(): ReviewUiStatus[] {
    return [...this.requests.values()].sort(
      (left, right) =>
        left.emittedAt - right.emittedAt || left.requestID.localeCompare(right.requestID),
    )
  }

  activeFor(
    sessionID: string,
    parentOf: (sessionID: string) => string | undefined,
  ): ReviewUiStatus | undefined {
    // Manual entries only drive toasts; they must not occupy the panel slot or
    // they hide later reviews. Prefer an in-flight review over a terminal
    // result, and within each class pick the newest request.
    const matches = this.all().filter((status) => {
      if (status.phase === "manual") return false
      if (status.sessionID === sessionID) return true
      let current = parentOf(status.sessionID)
      const visited = new Set<string>()
      while (current && !visited.has(current)) {
        if (current === sessionID) return true
        visited.add(current)
        current = parentOf(current)
      }
      return false
    })
    if (matches.length === 0) return undefined
    const rank = (phase: ReviewUiStatus["phase"]): number => {
      if (phase === "reviewing") return 2
      if (phase === "approved" || phase === "denied") return 1
      return 0
    }
    return matches.sort(
      (left, right) =>
        rank(right.phase) - rank(left.phase) ||
        right.emittedAt - left.emittedAt ||
        right.requestID.localeCompare(left.requestID),
    )[0]
  }

  expire(now = Date.now()): ReviewUiStatus[] {
    const expired: ReviewUiStatus[] = []
    for (const [requestID, status] of this.requests) {
      if (status.phase !== "reviewing") continue
      const acknowledged = this.acknowledged.has(requestID)
      const deadline = acknowledged
        ? status.emittedAt + status.timeoutMs + UI_WATCHDOG_GRACE_MS
        : status.emittedAt + UI_START_GRACE_MS
      if (now < deadline) continue
      const unknown: ReviewUiStatus = {
        ...status,
        phase: "unknown",
        emittedAt: now,
        reason: acknowledged
          ? "The reviewer did not return a result within the expected time."
          : "The reviewer did not acknowledge the start of the review.",
      }
      this.requests.set(requestID, unknown)
      expired.push(unknown)
    }
    return expired
  }

  dismissResults(now = Date.now()): string[] {
    const removed: string[] = []
    for (const [requestID, status] of this.requests) {
      if (status.phase !== "approved" && status.phase !== "denied") continue
      if (now < status.emittedAt + RESULT_DISPLAY_MS[status.phase]) continue
      this.remove(requestID)
      removed.push(requestID)
    }
    return removed
  }
}
