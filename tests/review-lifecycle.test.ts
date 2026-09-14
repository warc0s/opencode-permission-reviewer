import { expect, test } from "bun:test"
import { ReviewAttempt } from "../src/core/review-attempt.ts"
import { ReviewLimiter } from "../src/core/review-limiter.ts"
import { request, runtime } from "./helpers.ts"

test("attempt identity, deadline, and terminal state cannot be resurrected", async () => {
  let now = 100
  const attempt = new ReviewAttempt(
    "generation",
    1000,
    () => now,
    () => "review",
  )
  expect(attempt.id).toBe("review")
  expect(attempt.active("other-generation")).toBe(false)
  now = 1100
  expect(attempt.active()).toBe(false)
  expect(attempt.state).toBe("expired")
  expect(attempt.remainingMs()).toBe(0)
  expect(attempt.close("finished")).toBe(false)
  await expect(attempt.wait(Promise.reject(new Error("late transport failure")))).rejects.toThrow(
    "Review expired",
  )
})

test("cancellation rejects an outstanding wait and ignores a late result", async () => {
  const attempt = new ReviewAttempt("generation", 1000)
  let complete!: (value: string) => void
  const operation = new Promise<string>((resolve) => {
    complete = resolve
  })
  const waiting = attempt.wait(operation)
  attempt.close("cancelled")
  await expect(waiting).rejects.toThrow("Review cancelled")
  complete("allow")
  await operation
  expect(attempt.state).toBe("cancelled")
})

test("bounded FIFO admission removes cancelled work and releases capacity exactly once", async () => {
  const limiter = new ReviewLimiter(1, 2)
  const first = await limiter.acquire(new AbortController().signal)
  const cancelled = new AbortController()
  const second = limiter.acquire(cancelled.signal)
  const third = limiter.acquire(new AbortController().signal)
  await expect(limiter.acquire(new AbortController().signal)).rejects.toThrow("queue is full")
  cancelled.abort(new Error("queued cancellation"))
  await expect(second).rejects.toThrow("queued cancellation")
  const fourth = limiter.acquire(new AbortController().signal)
  first()
  first()
  const releaseThird = await third
  let fourthStarted = false
  void fourth.then(() => {
    fourthStarted = true
  })
  await Promise.resolve()
  expect(fourthStarted).toBe(false)
  releaseThird()
  const releaseFourth = await fourth
  releaseFourth()
  const alreadyAborted = new AbortController()
  alreadyAborted.abort()
  expect(() => limiter.acquire(alreadyAborted.signal)).toThrow()
})

test("admission failure applies the configured denial before releasing attempt state", async () => {
  const limiter = new ReviewLimiter(1, 0)
  const release = await limiter.acquire(new AbortController().signal)
  const harness = runtime(undefined, { escalationMode: "deny" })
  Reflect.set(harness.runtime, "limiter", limiter)
  try {
    harness.runtime.handle(request())
    await harness.runtime.waitForIdle()
    expect(harness.client.prompts).toHaveLength(0)
    expect(harness.client.replies).toHaveLength(1)
    expect(harness.client.replies[0]).toHaveProperty("body.reply", "reject")
    expect(Reflect.get(harness.ctx, "auditRecords")[0]).toMatchObject({
      outcome: "deny",
      application: "reply-accepted",
    })
  } finally {
    release()
    await harness.runtime.dispose()
  }
})
