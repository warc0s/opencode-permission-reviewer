import { describe, expect, test } from "bun:test"
import { AskDecisionRegistry, DISMISSED_ANSWER } from "../src/context/ask-decisions.ts"
import { renderAskDecisions, buildEvidence } from "../src/context.ts"
import { resolveConfig, DEFAULT_CONFIG } from "../src/config.ts"
import { ApprovalReviewerRuntime } from "../src/runtime.ts"
import type { AskDecision, ReviewEnvelope } from "../src/types.ts"
import { request, runtime as buildRuntime } from "./helpers.ts"

// Synthetic credential fragments are assembled by concatenation so secret
// scanners never see a continuous literal.
const SYNTHETIC_TOKEN = "sk-" + "syntheticcredential1234567890abcdef"

function asked(
  id: string,
  sessionID: string,
  questions: string[],
  v2 = false,
): Record<string, unknown> {
  return {
    type: v2 ? "question.v2.asked" : "question.asked",
    properties: {
      id,
      sessionID,
      questions: questions.map((question) => ({
        question,
        header: "Header",
        options: [{ label: "Yes" }, { label: "No" }],
      })),
    },
  }
}

function replied(requestID: string, answers: string[][], v2 = false): Record<string, unknown> {
  return {
    type: v2 ? "question.v2.replied" : "question.replied",
    properties: { sessionID: "ses_main", requestID, answers },
  }
}

function rejected(requestID: string, v2 = false): Record<string, unknown> {
  return {
    type: v2 ? "question.v2.rejected" : "question.rejected",
    properties: { sessionID: "ses_main", requestID },
  }
}

describe("AskDecisionRegistry", () => {
  test("captures an asked→replied lifecycle", () => {
    const registry = new AskDecisionRegistry()
    registry.observe(asked("que_1", "ses_main", ["Run the marker command?"]))
    registry.observe(replied("que_1", [["Yes"]]))
    const decisions = registry.recentFor(["ses_main"])
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.question).toBe("Run the marker command?")
    expect(decisions[0]!.answer).toBe("Yes")
    expect(decisions[0]!.at).toBeGreaterThan(0)
  })

  test("accepts v2 event spellings and dedupes against v1", () => {
    const registry = new AskDecisionRegistry()
    registry.observe(asked("que_1", "ses_main", ["Deploy?"]))
    // Same ask id arriving under the v2 spelling must upsert, not duplicate.
    registry.observe(asked("que_1", "ses_main", ["Deploy?"], true))
    registry.observe(replied("que_1", [["Yes"]], true))
    // A replayed reply is ignored.
    registry.observe(replied("que_1", [["No"]]))
    const decisions = registry.recentFor(["ses_main"])
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.answer).toBe("Yes")
  })

  test("a late asked for an already-resolved request is a replay", () => {
    const registry = new AskDecisionRegistry()
    registry.observe(asked("que_1", "ses_main", ["Deploy?"]))
    registry.observe(replied("que_1", [["Yes"]]))
    registry.observe(asked("que_1", "ses_main", ["Deploy?"]))
    expect(registry.recentFor(["ses_main"])).toHaveLength(1)
    expect(registry.pendingCount()).toBe(0)
  })

  test("rejection records a dismissal, not an approval", () => {
    const registry = new AskDecisionRegistry()
    registry.observe(asked("que_1", "ses_main", ["Deploy?"]))
    registry.observe(rejected("que_1"))
    const decisions = registry.recentFor(["ses_main"])
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.answer).toBe(DISMISSED_ANSWER)
  })

  test("a reply without a matching ask is dropped", () => {
    const registry = new AskDecisionRegistry()
    registry.observe(replied("que_unknown", [["Yes"]]))
    registry.observe(rejected("que_unknown"))
    expect(registry.recentFor(["ses_main"])).toHaveLength(0)
  })

  test("multi-question asks pair answers by index; gaps render as Unanswered", () => {
    const registry = new AskDecisionRegistry()
    registry.observe(asked("que_1", "ses_main", ["Branch?", "Force push?"]))
    registry.observe(replied("que_1", [["main"], []]))
    const [first] = registry.recentFor(["ses_main"])
    expect(first!.question).toBe("Branch? | Force push?")
    expect(first!.answer).toBe("main | Unanswered")
  })

  test("malformed events never throw and leave no state", () => {
    const registry = new AskDecisionRegistry()
    const garbage: unknown[] = [
      null,
      42,
      "question.asked",
      { type: "question.asked" },
      { type: "question.asked", properties: null },
      { type: "question.asked", properties: { id: "que_1" } },
      { type: "question.asked", properties: { id: "que_1", sessionID: "s", questions: "no" } },
      { type: "question.asked", properties: { id: "que_1", sessionID: "s", questions: [{}] } },
      { type: "question.replied", properties: { answers: [["Yes"]] } },
      { type: "question.replied", properties: { requestID: "que_1", answers: "no" } },
      { type: "question.replied", properties: { requestID: "que_1", answers: [42] } },
      { type: "other.event", properties: {} },
    ]
    for (const event of garbage) {
      expect(() => registry.observe(event)).not.toThrow()
    }
    expect(registry.pendingCount()).toBe(0)
    expect(registry.recentFor(["s"])).toHaveLength(0)
  })

  test("question and answer text is redacted at capture time", () => {
    const registry = new AskDecisionRegistry()
    registry.observe(asked("que_1", "ses_main", [`Run with token ${SYNTHETIC_TOKEN}?`]))
    registry.observe(replied("que_1", [[`Yes, use ${SYNTHETIC_TOKEN}`]]))
    const [first] = registry.recentFor(["ses_main"])
    expect(first!.question).not.toContain(SYNTHETIC_TOKEN)
    expect(first!.answer).not.toContain(SYNTHETIC_TOKEN)
  })

  test("question and answer text is truncated at capture time", () => {
    const registry = new AskDecisionRegistry()
    registry.observe(asked("que_1", "ses_main", ["x".repeat(500)]))
    registry.observe(replied("que_1", [["y".repeat(500)]]))
    const [first] = registry.recentFor(["ses_main"])
    expect(first!.question.length).toBeLessThanOrEqual(160)
    expect(first!.answer.length).toBeLessThanOrEqual(120)
  })

  test("pending asks expire after the TTL", () => {
    let clock = 1_000_000
    const registry = new AskDecisionRegistry(undefined, () => clock)
    registry.observe(asked("que_1", "ses_main", ["Deploy?"]))
    clock += 31 * 60 * 1000
    registry.observe(asked("que_fresh", "ses_main", ["Ship?"])) // triggers pruning
    registry.observe(replied("que_1", [["Yes"]]))
    expect(registry.recentFor(["ses_main"])).toHaveLength(0)
  })

  test("a late reply cannot pair with an expired ask even without new asks", () => {
    let clock = 1_000_000
    const registry = new AskDecisionRegistry(undefined, () => clock)
    registry.observe(asked("que_1", "ses_main", ["Deploy?"]))
    clock += 31 * 60 * 1000
    // No intervening asked: the reply path itself must honor the TTL.
    registry.observe(replied("que_1", [["Yes"]]))
    registry.observe(rejected("que_1"))
    expect(registry.recentFor(["ses_main"])).toHaveLength(0)
    expect(registry.pendingCount()).toBe(0)
  })

  test("answers shorter or longer than the questions clamp to the asked set", () => {
    const registry = new AskDecisionRegistry()
    registry.observe(asked("que_short", "ses_main", ["A?", "B?", "C?"]))
    registry.observe(replied("que_short", [["yes"]]))
    expect(registry.recentFor(["ses_main"])[0]!.answer).toBe("yes | Unanswered | Unanswered")

    registry.observe(asked("que_long", "ses_main", ["Only?"]))
    registry.observe(replied("que_long", [["yes"], ["orphan"], ["orphan"]]))
    expect(registry.recentFor(["ses_main"]).at(-1)!.answer).toBe("yes")
  })

  test("rejections work in the v2 spelling", () => {
    const registry = new AskDecisionRegistry()
    registry.observe(asked("que_1", "ses_main", ["Deploy?"], true))
    registry.observe(rejected("que_1", true))
    expect(registry.recentFor(["ses_main"])[0]!.answer).toBe(DISMISSED_ANSWER)
  })

  test("recentFor tolerates empty scopes and zero limits", () => {
    const registry = new AskDecisionRegistry()
    registry.observe(asked("que_1", "ses_main", ["Deploy?"]))
    registry.observe(replied("que_1", [["Yes"]]))
    expect(registry.recentFor([])).toEqual([])
    expect(registry.recentFor(["ses_main"], 0)).toEqual([])
  })

  test("pending capacity is bounded; overflowed asks are forgotten", () => {
    let clock = 1_000_000
    const registry = new AskDecisionRegistry(undefined, () => clock)
    registry.observe(asked("que_first", "ses_main", ["First?"]))
    for (let i = 0; i < 128; i++) {
      clock += 1
      registry.observe(asked(`que_bulk_${i}`, "ses_main", [`Q${i}?`]))
    }
    registry.observe(replied("que_first", [["Yes"]]))
    expect(registry.recentFor(["ses_main"])).toHaveLength(0)
  })

  test("resolved decisions are FIFO-bounded globally", () => {
    let clock = 1_000_000
    const registry = new AskDecisionRegistry(undefined, () => clock)
    for (let i = 0; i < 501; i++) {
      clock += 1
      const id = `que_${i}`
      registry.observe(asked(id, "ses_main", [`Q${i}?`]))
      registry.observe(replied(id, [["Yes"]]))
    }
    expect(registry.resolvedCount()).toBe(500)
    const decisions = registry.recentFor(["ses_main"], 500)
    expect(decisions[0]!.question).toBe("Q1?")
    expect(decisions.at(-1)!.question).toBe("Q500?")
  })

  test("visibility is scoped to the given sessions, most recent last", () => {
    let clock = 1_000_000
    const registry = new AskDecisionRegistry(undefined, () => clock)
    for (const [id, session] of [
      ["que_1", "ses_parent"],
      ["que_2", "ses_main"],
      ["que_3", "ses_sibling"],
    ] as const) {
      clock += 1
      registry.observe(asked(id, session, [`${id}?`]))
      registry.observe(id === "que_3" ? rejected(id) : replied(id, [["Yes"]]))
    }
    const visible = registry.recentFor(["ses_main", "ses_parent"])
    expect(visible.map((d) => d.question)).toEqual(["que_1?", "que_2?"])
    const limited = registry.recentFor(["ses_main", "ses_parent"], 1)
    expect(limited.map((d) => d.question)).toEqual(["que_2?"])
  })
})

describe("renderAskDecisions", () => {
  test("renders one compact line per decision", () => {
    const decisions: AskDecision[] = [
      { at: Date.UTC(2026, 8, 1, 12, 1, 3), question: "Run tests?", answer: "Yes" },
      { at: Date.UTC(2026, 8, 1, 12, 2, 41), question: "Push?", answer: "No" },
    ]
    const text = renderAskDecisions(decisions)!
    expect(text.split("\n")).toHaveLength(2)
    expect(text).toContain("[12:01:03Z] Q: Run tests? A: Yes")
    expect(text).toContain("[12:02:41Z] Q: Push? A: No")
  })

  test("returns undefined when there is nothing to show", () => {
    expect(renderAskDecisions(undefined)).toBeUndefined()
    expect(renderAskDecisions([])).toBeUndefined()
  })

  test("drops oldest lines when the block exceeds the budget", () => {
    const decisions = Array.from({ length: 40 }, (_, i) => ({
      at: Date.UTC(2026, 8, 1, 12, 0, i),
      question: `q${i} `.repeat(20).trim(),
      answer: "Yes",
    }))
    const text = renderAskDecisions(decisions)!
    expect(text.length).toBeLessThanOrEqual(1_500)
    expect(text).not.toContain("q0 ")
    expect(text).toContain("q39")
  })
})

describe("ask decisions in the reviewer evidence", () => {
  const baseEnvelope: ReviewEnvelope = {
    request: request(),
    directory: "/workspace/project",
    worktree: "/workspace/project",
    transcript: "RECENT_TRANSCRIPT-BODY",
    intentHistory: "USER_INTENT-BODY",
    enrichment: "",
    sshAudit: [],
  }

  test("the section sits between intent history and transcript and is omitted when empty", () => {
    const withDecisions = buildEvidence(
      {
        ...baseEnvelope,
        askDecisions: [
          { at: Date.UTC(2026, 8, 1, 12, 1, 3), question: "Run tests?", answer: "Yes" },
        ],
      },
      { ...DEFAULT_CONFIG },
    )
    expect(withDecisions).toContain("USER_ASK_DECISIONS")
    const intent = withDecisions.indexOf("USER_INTENT_HISTORY")
    const ask = withDecisions.indexOf("USER_ASK_DECISIONS")
    const transcript = withDecisions.indexOf("RECENT_TRANSCRIPT")
    expect(intent).toBeGreaterThan(-1)
    expect(ask).toBeGreaterThan(intent)
    expect(transcript).toBeGreaterThan(ask)

    const without = buildEvidence(baseEnvelope, { ...DEFAULT_CONFIG })
    expect(without).not.toContain("USER_ASK_DECISIONS")
  })
})

describe("ask decisions in the coordinator lifecycle", () => {
  test("captured decisions reach the audit record", async () => {
    const registry = new AskDecisionRegistry()
    registry.observe(asked("que_1", "ses_main", ["Run the marker command?"]))
    registry.observe(replied("que_1", [["Yes"]]))
    const { ctx } = buildRuntime()
    const runtime = new ApprovalReviewerRuntime(
      ctx,
      { ...DEFAULT_CONFIG },
      undefined,
      undefined,
      registry,
    )
    const result = await runtime.process(request())
    expect(result.kind).toBe("allow")
    const records = (ctx as unknown as { auditRecords: unknown[] }).auditRecords as Array<{
      askDecisions?: AskDecision[]
    }>
    expect(records).toHaveLength(1)
    expect(records[0]!.askDecisions).toEqual([
      { at: expect.any(Number), question: "Run the marker command?", answer: "Yes" },
    ])
  })

  test("the audit field is capped to the most recent decisions", async () => {
    let clock = 1_000_000
    const registry = new AskDecisionRegistry(undefined, () => clock)
    for (let i = 0; i < 8; i++) {
      clock += 1
      registry.observe(asked(`que_${i}`, "ses_main", [`Q${i}?`]))
      registry.observe(replied(`que_${i}`, [["Yes"]]))
    }
    const { ctx } = buildRuntime()
    const runtime = new ApprovalReviewerRuntime(
      ctx,
      { ...DEFAULT_CONFIG },
      undefined,
      undefined,
      registry,
    )
    await runtime.process(request())
    const records = (ctx as unknown as { auditRecords: unknown[] }).auditRecords as Array<{
      askDecisions?: AskDecision[]
    }>
    expect(records[0]!.askDecisions).toHaveLength(5)
    expect(records[0]!.askDecisions!.at(-1)!.question).toBe("Q7?")
  })

  test("registry present but config disabled keeps the feature off", async () => {
    const registry = new AskDecisionRegistry()
    registry.observe(asked("que_1", "ses_main", ["Run the marker command?"]))
    registry.observe(replied("que_1", [["Yes"]]))
    const { ctx } = buildRuntime(undefined, { askDecisions: false })
    const runtime = new ApprovalReviewerRuntime(
      ctx,
      { ...DEFAULT_CONFIG, askDecisions: false },
      undefined,
      undefined,
      registry,
    )
    await runtime.process(request())
    const records = (ctx as unknown as { auditRecords: unknown[] }).auditRecords as Array<{
      askDecisions?: AskDecision[]
    }>
    expect(records[0]!.askDecisions).toBeUndefined()
  })
})

describe("askDecisions config knob", () => {
  test("defaults to enabled", () => {
    expect(DEFAULT_CONFIG.askDecisions).toBe(true)
    expect(resolveConfig(undefined).askDecisions).toBe(true)
  })

  test("parses explicit values and ignores invalid ones", () => {
    expect(resolveConfig({ askDecisions: false }).askDecisions).toBe(false)
    expect(resolveConfig({ askDecisions: "no" }).askDecisions).toBe(true)
  })
})
