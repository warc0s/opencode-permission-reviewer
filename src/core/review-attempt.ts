import { randomUUID } from "node:crypto"
import type { ReviewEnvelope } from "../types.ts"
import type { ApplicationResult } from "./contracts.ts"

export type AttemptState = "reviewing" | "finished" | "cancelled" | "expired"

/** One invocation owns its deadline, identity, and terminal transition. */
export class ReviewAttempt {
  application: ApplicationResult = "human-pending"
  readonly evidence: Partial<
    Pick<
      ReviewEnvelope,
      | "sshAudit"
      | "actor"
      | "capability"
      | "policyTrace"
      | "askDecisions"
      | "evidenceCompleteness"
      | "verifiedScript"
    >
  > & {
    timings?: { contextMs?: number; enrichmentMs?: number; reviewerMs?: number; replyMs?: number }
  } = {}
  readonly id: string
  readonly controller = new AbortController()
  readonly startedAt: number
  readonly deadline: number
  private stateValue: AttemptState = "reviewing"
  private readonly timer: ReturnType<typeof setTimeout>

  constructor(
    readonly generation: string,
    budgetMs: number,
    private readonly now: () => number = Date.now,
    newID: () => string = randomUUID,
  ) {
    this.id = newID()
    this.startedAt = now()
    this.deadline = this.startedAt + budgetMs
    this.timer = setTimeout(() => this.close("expired"), budgetMs)
  }

  get state(): AttemptState {
    return this.stateValue
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  remainingMs(): number {
    return Math.max(0, this.deadline - this.now())
  }

  active(generation = this.generation): boolean {
    if (this.stateValue === "reviewing" && this.remainingMs() === 0) this.close("expired")
    return this.stateValue === "reviewing" && generation === this.generation
  }

  close(state: Exclude<AttemptState, "reviewing">): boolean {
    if (this.stateValue !== "reviewing") return false
    this.stateValue = state
    clearTimeout(this.timer)
    this.controller.abort(new Error(`Review ${state}`))
    return true
  }

  /** Abort the wait even if a host operation cannot cancel its transport. */
  async wait<T>(operation: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(this.signal.reason)
      // Observe the operation even when cancellation won before admission.
      // Its transport can still reject after this waiter has already closed.
      if (this.signal.aborted) abort()
      else this.signal.addEventListener("abort", abort, { once: true })
      operation.then(
        (value) => {
          this.signal.removeEventListener("abort", abort)
          if (this.active()) resolve(value)
          else reject(this.signal.reason ?? new Error("Review is no longer active"))
        },
        (error: unknown) => {
          this.signal.removeEventListener("abort", abort)
          reject(error)
        },
      )
    })
  }
}
