import { describe, expect, test } from "bun:test"
import { resolveConfig, DEFAULT_CONFIG, DEFAULT_RISK_POLICY } from "../src/config.ts"
import { applyEscalationDisposition, resolveEscalationDisposition } from "../src/escalation.ts"
import { enforceDecision } from "../src/decision.ts"
import type { ReviewExecutionResult, ReviewerConfig } from "../src/types.ts"
import { decision, MockClient, request, runtime } from "./helpers.ts"

function cfg(overrides: Partial<ReviewerConfig> = {}): ReviewerConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    riskPolicy: {
      ...DEFAULT_RISK_POLICY,
      ...(overrides.riskPolicy ?? {}),
      allow: {
        ...DEFAULT_RISK_POLICY.allow,
        ...(overrides.riskPolicy?.allow ?? {}),
      },
    },
  }
}

function escalate(overrides: Partial<ReviewExecutionResult> = {}): ReviewExecutionResult {
  return {
    kind: "escalate",
    reason: "needs a human",
    decisionSource: "llm-reviewer",
    ...overrides,
  }
}

describe("escalation disposition helper", () => {
  test("default manual keeps escalate for human", () => {
    const result = applyEscalationDisposition(escalate(), cfg())
    expect(result.kind).toBe("escalate")
    expect(result.escalationDisposition).toBe("manual")
    // No structured decision → no invented reviewerOutcome.
    expect(result.reviewerOutcome).toBeUndefined()
    expect(result.decision).toBeUndefined()
  })

  test("escalationMode deny converts escalate to deny and preserves reason", () => {
    const result = applyEscalationDisposition(
      escalate({ reason: "low confidence on medium risk" }),
      cfg({ escalationMode: "deny" }),
    )
    expect(result.kind).toBe("deny")
    expect(result.reason).toBe("low confidence on medium risk")
    expect(result.escalationDisposition).toBe("deny")
    // Fail-safe without structured decision must not invent risk/confidence.
    expect(result.reviewerOutcome).toBeUndefined()
    expect(result.decision).toBeUndefined()
  })

  test("LLM escalate→deny keeps original decision.outcome escalate", () => {
    const llmEscalate = escalate({
      reason: "Ambiguous scope needs a human.",
      decision: decision("escalate", { rationale: "Ambiguous scope needs a human." }),
      reviewerOutcome: "escalate",
    })
    const result = applyEscalationDisposition(llmEscalate, cfg({ escalationMode: "deny" }))
    expect(result.kind).toBe("deny")
    expect(result.reviewerOutcome).toBe("escalate")
    expect(result.decision?.outcome).toBe("escalate")
    expect(result.decision?.rationale).toContain("Ambiguous scope")
    expect(result.escalationDisposition).toBe("deny")
  })

  test("allow and explicit deny pass through unchanged", () => {
    const allow: ReviewExecutionResult = {
      kind: "allow",
      reason: "ok",
      decision: decision("allow"),
      reviewerOutcome: "allow",
    }
    const deny: ReviewExecutionResult = {
      kind: "deny",
      reason: "no",
      decision: decision("deny"),
      reviewerOutcome: "deny",
    }
    expect(applyEscalationDisposition(allow, cfg({ escalationMode: "deny" }))).toEqual(allow)
    expect(applyEscalationDisposition(deny, cfg({ escalationMode: "deny" }))).toEqual(deny)
  })

  test("manual-superseded is never converted to deny", () => {
    const superseded = escalate({
      reason: "already answered",
      decisionSource: "manual-superseded",
    })
    const result = applyEscalationDisposition(superseded, cfg({ escalationMode: "deny" }))
    expect(result).toEqual(superseded)
    expect(resolveEscalationDisposition(superseded, cfg({ escalationMode: "deny" }))).toBe("manual")
  })

  test("onInvalidDecision deny hardens only invalid-decision category under manual mode", () => {
    const config = cfg({
      riskPolicy: { ...DEFAULT_RISK_POLICY, onInvalidDecision: "deny" },
    })
    const invalid = applyEscalationDisposition(escalate(), config, "invalid-decision")
    const general = applyEscalationDisposition(escalate(), config, "general")
    const failure = applyEscalationDisposition(escalate(), config, "reviewer-failure")
    expect(invalid.kind).toBe("deny")
    expect(general.kind).toBe("escalate")
    expect(failure.kind).toBe("escalate")
  })

  test("onReviewerFailure deny hardens only reviewer-failure category under manual mode", () => {
    const config = cfg({
      riskPolicy: { ...DEFAULT_RISK_POLICY, onReviewerFailure: "deny" },
    })
    const failure = applyEscalationDisposition(escalate(), config, "reviewer-failure")
    const invalid = applyEscalationDisposition(escalate(), config, "invalid-decision")
    expect(failure.kind).toBe("deny")
    expect(invalid.kind).toBe("escalate")
  })

  test("escalationMode deny supersedes category knobs left at manual", () => {
    const config = cfg({
      escalationMode: "deny",
      riskPolicy: {
        ...DEFAULT_RISK_POLICY,
        onInvalidDecision: "manual",
        onReviewerFailure: "manual",
      },
    })
    expect(applyEscalationDisposition(escalate(), config, "general").kind).toBe("deny")
    expect(applyEscalationDisposition(escalate(), config, "invalid-decision").kind).toBe("deny")
    expect(applyEscalationDisposition(escalate(), config, "reviewer-failure").kind).toBe("deny")
  })

  test("preserves original reviewerOutcome from gated allow→escalate", () => {
    const gated = enforceDecision(
      decision("allow", { confidence: 0.2 }),
      cfg({ confidenceThreshold: 0.7 }),
    )
    expect(gated.kind).toBe("escalate")
    expect(gated.reviewerOutcome).toBe("allow")
    const disposed = applyEscalationDisposition(gated, cfg({ escalationMode: "deny" }))
    expect(disposed.kind).toBe("deny")
    expect(disposed.reviewerOutcome).toBe("allow")
    expect(disposed.escalationDisposition).toBe("deny")
  })
})

describe("resolveConfig escalationMode", () => {
  test("defaults to manual", () => {
    expect(resolveConfig({}).escalationMode).toBe("manual")
  })

  test("accepts deny", () => {
    expect(resolveConfig({ escalationMode: "deny" }).escalationMode).toBe("deny")
  })

  test("invalid values fall back to manual", () => {
    expect(resolveConfig({ escalationMode: "auto" }).escalationMode).toBe("manual")
    expect(resolveConfig({ escalationMode: 1 }).escalationMode).toBe("manual")
  })
})

describe("runtime escalationMode deny", () => {
  test("LLM escalate becomes reject with original rationale", async () => {
    const client = new MockClient()
    client.nextStructured = decision("escalate", {
      rationale: "Ambiguous scope needs a human.",
    })
    const harness = runtime(client, { escalationMode: "deny" })
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("deny")
    expect(result.reason).toBe("Ambiguous scope needs a human.")
    expect(result.escalationDisposition).toBe("deny")
    expect(result.reviewerOutcome).toBe("escalate")
    expect(replyBody(client.replies[0])).toEqual({
      reply: "reject",
      message: "[Automatic permission review] Ambiguous scope needs a human.",
    })
    expect(client.uiStatuses.map((s) => s.phase)).toEqual(["reviewing", "denied"])
    expect(client.uiStatuses.at(-1)?.escalationDisposition).toBe("deny")
  })

  test("low confidence becomes reject", async () => {
    const client = new MockClient()
    client.nextStructured = decision("allow", { confidence: 0.2 })
    const harness = runtime(client, { escalationMode: "deny" })
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("deny")
    expect(result.reason).toContain("below")
    expect(result.reviewerOutcome).toBe("allow")
    expect(result.escalationDisposition).toBe("deny")
    expect(client.replies).toHaveLength(1)
    expect(replyBody(client.replies[0]).reply).toBe("reject")
  })

  test("evidence insufficient gate becomes reject", async () => {
    const client = new MockClient()
    client.nextStructured = decision("allow", {
      risk_level: "medium",
      user_authorization: "high",
      evidence_completeness: "insufficient",
    })
    const harness = runtime(client, { escalationMode: "deny" })
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("deny")
    expect(result.reason).toContain("insufficient")
    expect(result.escalationDisposition).toBe("deny")
  })

  test("invalid structured output becomes reject when onInvalidDecision is deny", async () => {
    const client = new MockClient()
    client.nextStructured = { invalid: true }
    const harness = runtime(client, {
      riskPolicy: { ...DEFAULT_RISK_POLICY, onInvalidDecision: "deny" },
    })
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("deny")
    expect(result.reason).toContain("invalid structured output")
    expect(result.escalationDisposition).toBe("deny")
    expect(result.reviewerOutcome).toBeUndefined()
    expect(result.decision).toBeUndefined()
    expect(replyBody(client.replies[0]).reply).toBe("reject")
  })

  test("reviewer timeout becomes reject when onReviewerFailure is deny", async () => {
    const client = new MockClient()
    client.promptImpl = () => new Promise(() => {})
    const harness = runtime(client, {
      timeoutMs: 10,
      riskPolicy: { ...DEFAULT_RISK_POLICY, onReviewerFailure: "deny" },
    })
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("deny")
    expect(result.reason).toContain("timed out")
    expect(result.escalationDisposition).toBe("deny")
    expect(result.reviewerOutcome).toBeUndefined()
    expect(result.decision).toBeUndefined()
    expect(replyBody(client.replies[0]).reply).toBe("reject")
  })

  test("escalationMode deny converts timeout without needing category knobs", async () => {
    const client = new MockClient()
    client.promptImpl = () => new Promise(() => {})
    const harness = runtime(client, { timeoutMs: 10, escalationMode: "deny" })
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("deny")
    expect(result.escalationDisposition).toBe("deny")
    expect(result.reviewerOutcome).toBeUndefined()
    expect(result.decision).toBeUndefined()
  })

  test("explicit deny stays deny without escalationDisposition", async () => {
    const client = new MockClient()
    client.nextStructured = decision("deny", { rationale: "credential export blocked." })
    const harness = runtime(client, { escalationMode: "deny" })
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("deny")
    expect(result.escalationDisposition).toBeUndefined()
    expect(result.reviewerOutcome).toBe("deny")
    expect(client.uiStatuses.at(-1)?.escalationDisposition).toBeUndefined()
  })

  test("allow stays allow under escalationMode deny", async () => {
    const harness = runtime(new MockClient(), { escalationMode: "deny" })
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("allow")
    expect(result.escalationDisposition).toBeUndefined()
    expect(replyBody(harness.client.replies[0]).reply).toBe("once")
  })

  test("policy manual route becomes reject under escalationMode deny", async () => {
    const client = new MockClient()
    const harness = runtime(client, {
      escalationMode: "deny",
      enforcementMode: "enforce",
      policyRules: [
        {
          id: "force-manual",
          source: "inline",
          when: {},
          effect: "manual",
          reason: "always manual for test",
        },
      ],
    })
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("deny")
    expect(result.reason).toContain("always manual for test")
    expect(result.escalationDisposition).toBe("deny")
    expect(result.reviewerOutcome).toBeUndefined()
    expect(result.decision).toBeUndefined()
    expect(client.creates).toHaveLength(0)
    expect(replyBody(client.replies[0]).reply).toBe("reject")
  })

  test("audit records reviewerOutcome and escalationDisposition on escalate→deny", async () => {
    const client = new MockClient()
    client.nextStructured = decision("escalate", {
      rationale: "needs eyes",
      risk_level: "medium",
      user_authorization: "medium",
      confidence: 0.95,
    })
    const harness = runtime(client, { escalationMode: "deny" })
    await harness.runtime.process(request())
    const audits = (harness.ctx as unknown as { auditRecords: Array<Record<string, unknown>> })
      .auditRecords
    // Final outcome is deny; flattened fields keep the ORIGINAL structured
    // decision (not a synthetic high/1.0 deny). reviewerOutcome stays escalate.
    expect(audits[0]).toMatchObject({
      schemaVersion: 3,
      outcome: "deny",
      reviewerOutcome: "escalate",
      escalationDisposition: "deny",
      reason: "needs eyes",
      riskLevel: "medium",
      confidence: 0.95,
    })
  })

  test("audit on timeout deny has no invented decision fields or reviewerOutcome", async () => {
    const client = new MockClient()
    client.promptImpl = () => new Promise(() => {})
    const harness = runtime(client, { timeoutMs: 10, escalationMode: "deny" })
    await harness.runtime.process(request())
    const audits = (harness.ctx as unknown as { auditRecords: Array<Record<string, unknown>> })
      .auditRecords
    expect(audits[0]).toMatchObject({
      schemaVersion: 3,
      outcome: "deny",
      escalationDisposition: "deny",
      decisionSource: "failure-safe",
    })
    expect(audits[0]!.reviewerOutcome).toBeUndefined()
    expect(audits[0]!.riskLevel).toBeUndefined()
    expect(audits[0]!.confidence).toBeUndefined()
    expect(audits[0]!.userAuthorization).toBeUndefined()
  })

  test("audit records manual disposition without converting outcome", async () => {
    const client = new MockClient()
    client.nextStructured = decision("escalate", { rationale: "please review" })
    const harness = runtime(client)
    await harness.runtime.process(request())
    const audits = (harness.ctx as unknown as { auditRecords: Array<Record<string, unknown>> })
      .auditRecords
    expect(audits[0]).toMatchObject({
      schemaVersion: 3,
      outcome: "escalate",
      reviewerOutcome: "escalate",
      escalationDisposition: "manual",
    })
  })

  test("audit on explicit allow has reviewerOutcome and no escalationDisposition", async () => {
    const harness = runtime()
    await harness.runtime.process(request())
    const audits = (harness.ctx as unknown as { auditRecords: Array<Record<string, unknown>> })
      .auditRecords
    expect(audits[0]).toMatchObject({
      schemaVersion: 3,
      outcome: "allow",
      reviewerOutcome: "allow",
    })
    expect(audits[0]!.escalationDisposition).toBeUndefined()
  })

  test("manual supersede still wins under escalationMode deny", async () => {
    const client = new MockClient()
    const resolvers: Array<(value: { data: Record<string, unknown> }) => void> = []
    client.promptImpl = () =>
      new Promise((resolve) => {
        resolvers.push(resolve)
      })
    const harness = runtime(client, { escalationMode: "deny" })
    harness.runtime.handle(request())
    await new Promise((r) => setTimeout(r, 5))
    harness.runtime.handlePermissionReply({
      type: "permission.replied",
      properties: { sessionID: "ses_main", requestID: "per_1", reply: "once" },
    })
    for (const resolve of resolvers)
      resolve({ data: { info: { structured: decision("escalate") } } })
    await harness.runtime.waitForIdle()
    expect(client.replies).toHaveLength(0)
    expect(client.uiStatuses.map((s) => s.phase)).toEqual(["reviewing"])
  })

  test("default manual mode still leaves escalate pending for a human", async () => {
    const client = new MockClient()
    client.nextStructured = decision("escalate", { rationale: "please review" })
    const harness = runtime(client)
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("escalate")
    expect(result.escalationDisposition).toBe("manual")
    expect(client.replies).toHaveLength(0)
    expect(client.uiStatuses.map((s) => s.phase)).toEqual(["reviewing", "manual"])
  })

  test("prompt includes ACTION_PURPOSE section", async () => {
    const client = new MockClient()
    client.promptImpl = async (options) => {
      const text = (options as { body: { parts: Array<{ text: string }> } }).body.parts[0]!.text
      expect(text).toContain("ACTION_PURPOSE")
      expect(text).toMatch(/"source": "(agent-context|intent-derived|unavailable)"/)
      return { data: { info: { structured: decision("allow") } } }
    }
    const harness = runtime(client)
    expect((await harness.runtime.process(request())).kind).toBe("allow")
  })
})

function replyBody(value: unknown): Record<string, unknown> {
  return ((value as Record<string, unknown>).body ?? {}) as Record<string, unknown>
}
