/** Bounded FIFO admission. Queueing consumes the caller's existing deadline. */
export class ReviewLimiter {
  private active = 0
  private readonly queue: Array<() => void> = []
  constructor(
    private readonly concurrency = 32,
    private readonly capacity = 2048,
  ) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    if (this.active >= this.concurrency && this.queue.length >= this.capacity)
      return Promise.reject(new Error("Reviewer queue is full"))
    return new Promise((resolve, reject) => {
      const abort = () => {
        const index = this.queue.indexOf(start)
        if (index >= 0) this.queue.splice(index, 1)
        reject(signal.reason)
      }
      const start = () => {
        signal.removeEventListener("abort", abort)
        if (signal.aborted) {
          reject(signal.reason)
          return
        }
        this.active++
        let released = false
        resolve(() => {
          if (released) return
          released = true
          this.active--
          this.queue.shift()?.()
        })
      }
      if (this.active < this.concurrency) start()
      else {
        this.queue.push(start)
        signal.addEventListener("abort", abort, { once: true })
      }
    })
  }
}
