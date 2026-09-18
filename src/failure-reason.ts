// Shared formatting for failure-safe review reasons.
//
// The host SDK reports transport problems as short reason words on the error
// itself while the actionable detail lives on the chained cause. Copying only
// the top-level message would leave the agent and the audit trail with a bare
// word, so every failure-safe catch formats the phase, the error name, the
// optional reason code, and the cause chain into a single bounded string.

const MAX_FAILURE_REASON_LENGTH = 500
const MAX_CAUSE_DEPTH = 2

function safeName(error: Error): string {
  try {
    const name = error.name
    if (typeof name === "string" && name.trim().length > 0) return name.trim()
  } catch {
    // Fall through to the default below.
  }
  return "Error"
}

function safeMessage(error: Error): string {
  try {
    const message = error.message
    if (typeof message === "string" && message.length > 0) return message
  } catch {
    // Fall through to the fallback below.
  }
  try {
    const text = String(error)
    if (text.length > 0) return text
  } catch {
    // Fall through to the default below.
  }
  return "unknown error"
}

function safeReasonSuffix(error: Error): string {
  try {
    const record = error as unknown as Record<string, unknown>
    const reason = record.reason
    if (typeof reason === "string") {
      const text = reason.trim()
      if (text.length > 0) return `, reason=${text}`
      return ""
    }
    if (typeof reason === "number" || typeof reason === "boolean") {
      return `, reason=${String(reason)}`
    }
  } catch {
    // A throwing accessor must not break reason formatting.
  }
  return ""
}

function safeCauseMessage(cause: unknown): string | undefined {
  try {
    if (cause instanceof Error) {
      const message = safeMessage(cause)
      return message.length > 0 ? message : safeName(cause)
    }
    if (typeof cause === "string") return cause.length > 0 ? cause : undefined
    if (cause === null || cause === undefined) return undefined
    const text = String(cause)
    return text.length > 0 ? text : undefined
  } catch {
    return undefined
  }
}

function safePhase(phase: string): string {
  try {
    if (typeof phase === "string" && phase.trim().length > 0) return phase.trim()
  } catch {
    // Fall through to the default below.
  }
  return "review"
}

function truncate(reason: string): string {
  if (reason.length <= MAX_FAILURE_REASON_LENGTH) return reason
  return `${reason.slice(0, MAX_FAILURE_REASON_LENGTH - 3)}...`
}

/**
 * Format an unknown thrown value as a bounded failure-safe reason that names
 * where the failure happened and preserves the chained cause. Never throws.
 */
export function formatFailureReason(phase: string, error: unknown): string {
  try {
    const label = safePhase(phase)
    if (!(error instanceof Error)) {
      let text = "unknown error"
      try {
        const raw = String(error)
        if (raw.length > 0) text = raw
      } catch {
        // Keep the default text.
      }
      return truncate(`${label} failed (UnknownError): ${text}`)
    }
    const name = safeName(error)
    const message = safeMessage(error)
    const suffix = safeReasonSuffix(error)
    const causes: string[] = []
    try {
      let current: unknown = error
      for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
        if (typeof current !== "object" || current === null) break
        let next: unknown
        try {
          next = (current as { cause?: unknown }).cause
        } catch {
          break
        }
        if (next === null || next === undefined) break
        const text = safeCauseMessage(next)
        if (text !== undefined && text.length > 0) causes.push(text)
        current = next
      }
    } catch {
      // Partial cause chains are still useful.
    }
    const base = `${label} failed (${name}${suffix}): ${message}`
    if (causes.length === 0) return truncate(base)
    return truncate(`${base}; caused by: ${causes.join("; caused by: ")}`)
  } catch {
    return "review failed: unknown error"
  }
}
