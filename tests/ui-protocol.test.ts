import { describe, expect, test } from "bun:test"
import { decision, request } from "./helpers.ts"
import {
  UI_COMMAND_PREFIX,
  UI_START_GRACE_MS,
  UI_WATCHDOG_GRACE_MS,
  createUiStatus,
  decodeUiStatus,
  encodeUiStatus,
  permissionAction,
} from "../src/ui-protocol.ts"
import { ReviewUiState } from "../src/ui-state.ts"

const options = {
  model: "openai/gpt-5.6-luna",
  variant: "max",
  timeoutMs: 120_000,
}

describe("TUI status protocol", () => {
  test("round-trips every phase without losing decision details", () => {
    for (const phase of ["reviewing", "approved", "denied", "manual"] as const) {
      const status = createUiStatus(request(), phase, {
        ...options,
        emittedAt: 123,
        reason: "Concrete reason",
        decision: decision(phase === "denied" ? "deny" : phase === "manual" ? "escalate" : "allow"),
        ...(phase === "denied" ? { escalationDisposition: "deny" as const } : {}),
      })
      expect(decodeUiStatus(encodeUiStatus(status))).toEqual(status)
      if (phase === "denied") {
        expect(status.escalationDisposition).toBe("deny")
      }
    }
  })

  test("rejects invalid escalationDisposition values", () => {
    const status = createUiStatus(request(), "denied", {
      ...options,
      escalationDisposition: "deny",
    })
    const payload = { ...status, escalationDisposition: "sometimes" }
    const encoded = `${UI_COMMAND_PREFIX}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`
    expect(decodeUiStatus(encoded)).toBeUndefined()
  })

  test("rejects unrelated, malformed, oversized, and structurally invalid commands", () => {
    expect(decodeUiStatus("session.new")).toBeUndefined()
    expect(decodeUiStatus(`${UI_COMMAND_PREFIX}%%%`)).toBeUndefined()
    expect(decodeUiStatus(`${UI_COMMAND_PREFIX}${"a".repeat(16_001)}`)).toBeUndefined()
    const invalid = Buffer.from(JSON.stringify({ version: 1, phase: "approved" })).toString(
      "base64url",
    )
    expect(decodeUiStatus(`${UI_COMMAND_PREFIX}${invalid}`)).toBeUndefined()
  })

  test("uses the concrete command and bounds untrusted display text", () => {
    expect(permissionAction(request({ metadata: { command: "printf safe" } }))).toBe(
      "$ printf safe",
    )
    const action = permissionAction(
      request({ metadata: { command: `x${" ".repeat(20)}${"y".repeat(800)}` } }),
    )
    expect(action.length).toBeLessThanOrEqual(500)
    expect(action).not.toContain("  ")
  })
})

describe("TUI state machine", () => {
  test("starts in reviewing and requires an explicit server acknowledgement", () => {
    const state = new ReviewUiState(options)
    state.asked(request(), 1_000)
    expect(state.get("per_1")?.phase).toBe("reviewing")
    expect(state.expire(1_000 + UI_START_GRACE_MS - 1)).toHaveLength(0)
    expect(state.expire(1_000 + UI_START_GRACE_MS)).toMatchObject([
      { phase: "unknown", reason: "The reviewer did not acknowledge the start of the review." },
    ])
  })

  test("an acknowledged review uses the model timeout plus watchdog grace", () => {
    const state = new ReviewUiState(options)
    const asked = state.asked(request(), 1_000)
    state.apply({ ...asked, emittedAt: 1_100 })
    expect(state.expire(1_000 + options.timeoutMs + UI_WATCHDOG_GRACE_MS - 1)).toHaveLength(0)
    expect(state.expire(1_000 + options.timeoutMs + UI_WATCHDOG_GRACE_MS)[0]?.phase).toBe("unknown")
  })

  test("accepts the first server acknowledgement despite transport clock skew", () => {
    const state = new ReviewUiState(options)
    const local = state.asked(request(), 1_000)
    expect(state.apply({ ...local, emittedAt: 990 })).toBe(true)
    expect(state.expire(1_000 + UI_START_GRACE_MS)).toHaveLength(0)
    expect(state.expire(1_000 + options.timeoutMs + UI_WATCHDOG_GRACE_MS)[0]?.phase).toBe("unknown")
  })

  test("ignores stale network status and preserves terminal results after permission.replied", () => {
    const state = new ReviewUiState(options)
    const asked = state.asked(request(), 1_000)
    const approved = { ...asked, phase: "approved" as const, emittedAt: 2_000, reason: "Safe" }
    expect(state.apply(approved)).toBe(true)
    expect(state.apply({ ...asked, emittedAt: 1_500 })).toBe(false)
    state.replied("per_1")
    expect(state.get("per_1")?.phase).toBe("approved")
  })

  test("reveals manual permissions and removes them after the human replies", () => {
    const state = new ReviewUiState(options)
    const status = createUiStatus(request(), "manual", {
      ...options,
      emittedAt: 2_000,
      reason: "Low confidence",
    })
    state.apply(status)
    expect(state.get("per_1")?.phase).toBe("manual")
    state.replied("per_1")
    expect(state.get("per_1")).toBeUndefined()
  })

  test("dismisses automatic results after their visual dwell time", () => {
    const state = new ReviewUiState(options)
    const approved = createUiStatus(request(), "approved", {
      ...options,
      emittedAt: 1_000,
      reason: "Safe",
    })
    state.apply(approved)
    expect(state.dismissResults(5_999)).toHaveLength(0)
    expect(state.dismissResults(6_000)).toEqual(["per_1"])

    const denied = createUiStatus(request({ id: "per_2" }), "denied", {
      ...options,
      emittedAt: 3_000,
      reason: "Unsafe",
    })
    state.apply(denied)
    expect(state.dismissResults(7_999)).toHaveLength(0)
    expect(state.dismissResults(8_000)).toEqual(["per_2"])
  })

  test("finds child-session requests from their visible parent and resists parent cycles", () => {
    const state = new ReviewUiState(options)
    state.asked(request({ sessionID: "ses_child" }), 1_000)
    expect(
      state.activeFor("ses_parent", (id) => (id === "ses_child" ? "ses_parent" : undefined))
        ?.requestID,
    ).toBe("per_1")
    expect(
      state.activeFor("ses_other", (id) => (id === "ses_child" ? "ses_cycle" : "ses_child")),
    ).toBeUndefined()
  })

  test("skips manual entries and prefers a newer reviewing request over a terminal result", () => {
    const state = new ReviewUiState(options)
    state.apply(
      createUiStatus(request({ id: "per_old" }), "manual", {
        ...options,
        emittedAt: 1_000,
        reason: "Low confidence",
      }),
    )
    state.apply(
      createUiStatus(request({ id: "per_done" }), "approved", {
        ...options,
        emittedAt: 2_000,
        reason: "Safe",
      }),
    )
    state.asked(request({ id: "per_new" }), 3_000)
    expect(state.activeFor("ses_main", () => undefined)?.requestID).toBe("per_new")
    expect(state.activeFor("ses_main", () => undefined)?.phase).toBe("reviewing")
  })
})
