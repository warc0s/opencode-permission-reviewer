import { describe, expect, test } from "bun:test"
import { DEFAULT_CONFIG, resolveConfig, splitModel } from "../src/config.ts"
import { DECISION_SCHEMA, enforceDecision, parseDecision } from "../src/decision.ts"
import { decision } from "./helpers.ts"

describe("decision parsing and invariants", () => {
  test("accepts a valid structured decision", () => {
    expect(parseDecision(decision("allow"))).toEqual(decision("allow"))
  })

  test.each([
    undefined,
    null,
    {},
    { ...decision("allow"), outcome: "execute" },
    { ...decision("allow"), risk_level: "safe" },
    { ...decision("allow"), user_authorization: "admin" },
    { ...decision("allow"), rationale: " " },
    { ...decision("allow"), confidence: Number.NaN },
    { ...decision("allow"), confidence: 1.1 },
  ])("rejects malformed output %#", (value) => {
    expect(parseDecision(value)).toBeUndefined()
  })

  test("critical risk can never be auto-approved", () => {
    const result = enforceDecision(decision("allow", { risk_level: "critical" }), DEFAULT_CONFIG)
    expect(result.kind).toBe("escalate")
  })

  test("critical risk can never be silently escalated by the model", () => {
    const result = enforceDecision(decision("escalate", { risk_level: "critical" }), DEFAULT_CONFIG)
    expect(result.kind).toBe("escalate")
  })

  test("low confidence approval goes to a human", () => {
    const result = enforceDecision(decision("allow", { confidence: 0.69 }), DEFAULT_CONFIG)
    expect(result.kind).toBe("escalate")
  })

  test("preserves a validated denial below the approval confidence floor", () => {
    const denied = decision("deny", { confidence: 0.01 })
    expect(enforceDecision(denied, DEFAULT_CONFIG)).toMatchObject({
      kind: "deny",
      decision: denied,
      reason: denied.rationale,
      reviewerOutcome: "deny",
    })
  })

  test("preserves valid allow, deny, and escalate outcomes", () => {
    expect(enforceDecision(decision("allow"), DEFAULT_CONFIG).kind).toBe("allow")
    expect(enforceDecision(decision("deny"), DEFAULT_CONFIG).kind).toBe("deny")
    expect(enforceDecision(decision("escalate"), DEFAULT_CONFIG).kind).toBe("escalate")
  })

  test("the model can never auto-approve high risk with low or unknown authorization", () => {
    expect(
      enforceDecision(
        decision("allow", { risk_level: "high", user_authorization: "low" }),
        DEFAULT_CONFIG,
      ).kind,
    ).toBe("escalate")
    expect(
      enforceDecision(
        decision("allow", { risk_level: "high", user_authorization: "unknown" }),
        DEFAULT_CONFIG,
      ).kind,
    ).toBe("escalate")
    // The exact contradiction the comparative analysis flagged.
    const flagged = enforceDecision(
      decision("allow", { risk_level: "high", user_authorization: "unknown", confidence: 0.95 }),
      DEFAULT_CONFIG,
    )
    expect(flagged.kind).toBe("escalate")
    expect(flagged.reason).toContain("high risk")
  })

  test("high risk with at least medium authorization is approved when the model allows", () => {
    expect(
      enforceDecision(
        decision("allow", { risk_level: "high", user_authorization: "medium" }),
        DEFAULT_CONFIG,
      ).kind,
    ).toBe("allow")
    expect(
      enforceDecision(
        decision("allow", { risk_level: "high", user_authorization: "high" }),
        DEFAULT_CONFIG,
      ).kind,
    ).toBe("allow")
  })

  test("medium risk with unknown authorization escalates; medium+low is deliberately approved", () => {
    expect(
      enforceDecision(
        decision("allow", { risk_level: "medium", user_authorization: "unknown" }),
        DEFAULT_CONFIG,
      ).kind,
    ).toBe("escalate")
    expect(
      enforceDecision(
        decision("allow", { risk_level: "medium", user_authorization: "low" }),
        DEFAULT_CONFIG,
      ).kind,
    ).toBe("allow")
  })

  test("low risk never escalates on authorization alone", () => {
    expect(
      enforceDecision(
        decision("allow", { risk_level: "low", user_authorization: "unknown" }),
        DEFAULT_CONFIG,
      ).kind,
    ).toBe("allow")
    expect(
      enforceDecision(
        decision("allow", { risk_level: "low", user_authorization: "low" }),
        DEFAULT_CONFIG,
      ).kind,
    ).toBe("allow")
  })

  test("the gate never relaxes a deny or escalate, regardless of risk and authorization", () => {
    expect(
      enforceDecision(
        decision("deny", { risk_level: "high", user_authorization: "unknown" }),
        DEFAULT_CONFIG,
      ).kind,
    ).toBe("deny")
    expect(
      enforceDecision(
        decision("escalate", { risk_level: "high", user_authorization: "unknown" }),
        DEFAULT_CONFIG,
      ).kind,
    ).toBe("escalate")
  })

  test("low confidence takes precedence over the risk×authorization reason", () => {
    const result = enforceDecision(
      decision("allow", { risk_level: "high", user_authorization: "unknown", confidence: 0.5 }),
      DEFAULT_CONFIG,
    )
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("confidence")
  })

  test("full allow matrix (every risk×authorization cell)", () => {
    const expectAllow = (risk: string, auth: string) => {
      const result = enforceDecision(
        decision("allow", { risk_level: risk as never, user_authorization: auth as never }),
        DEFAULT_CONFIG,
      )
      expect({ risk, auth, kind: result.kind }).toEqual({ risk, auth, kind: "allow" })
    }
    const expectEscalate = (risk: string, auth: string) => {
      const result = enforceDecision(
        decision("allow", { risk_level: risk as never, user_authorization: auth as never }),
        DEFAULT_CONFIG,
      )
      expect({ risk, auth, kind: result.kind }).toEqual({ risk, auth, kind: "escalate" })
    }
    // low
    expectAllow("low", "high")
    expectAllow("low", "medium")
    expectAllow("low", "low")
    expectAllow("low", "unknown")
    // medium
    expectAllow("medium", "high")
    expectAllow("medium", "medium")
    expectAllow("medium", "low")
    expectEscalate("medium", "unknown")
    // high
    expectAllow("high", "high")
    expectAllow("high", "medium")
    expectEscalate("high", "low")
    expectEscalate("high", "unknown")
    // critical
    expectEscalate("critical", "high")
    expectEscalate("critical", "medium")
    expectEscalate("critical", "low")
    expectEscalate("critical", "unknown")
  })
})

describe("configuration", () => {
  test("defaults to GPT-6 Luna at medium reasoning", () => {
    expect(resolveConfig(undefined).model).toBe("openai/gpt-6-luna")
    expect(resolveConfig(undefined).variant).toBe("medium")
    expect(resolveConfig(undefined).outputFormat).toBe("json_schema")
  })

  test("resolves the output format", () => {
    expect(resolveConfig({ outputFormat: "text" }).outputFormat).toBe("text")
    expect(resolveConfig({ outputFormat: "json_schema" }).outputFormat).toBe("json_schema")
    // Invalid values fall back to the safe structured-output default.
    expect(resolveConfig({ outputFormat: "bogus" }).outputFormat).toBe("json_schema")
    expect(resolveConfig({ outputFormat: 42 }).outputFormat).toBe("json_schema")
  })

  test("bounds unsafe numeric options", () => {
    const value = resolveConfig({
      timeoutMs: 1,
      confidenceThreshold: -10,
      transcriptMessages: 1_000_000,
    })
    expect(value.timeoutMs).toBe(5_000)
    expect(value.confidenceThreshold).toBe(0.5)
    expect(value.transcriptMessages).toBe(100)
  })

  test("splits provider and model without losing nested model IDs", () => {
    expect(splitModel("openai/gpt-5.6-luna")).toEqual({
      providerID: "openai",
      modelID: "gpt-5.6-luna",
    })
    expect(() => splitModel("invalid")).toThrow()
  })
})

describe("schema v2 fields", () => {
  test("parseDecision accepts scope_alignment and evidence_completeness", () => {
    const parsed = parseDecision({
      ...decision("allow"),
      scope_alignment: "misaligned",
      evidence_completeness: "insufficient",
    })
    expect(parsed?.scope_alignment).toBe("misaligned")
    expect(parsed?.evidence_completeness).toBe("insufficient")
  })

  test("parseDecision rejects a decision without a version field", () => {
    const parsed = parseDecision({
      outcome: "allow",
      risk_level: "low",
      user_authorization: "high",
      rationale: "safe",
      confidence: 0.9,
      scope_alignment: "aligned",
      evidence_completeness: "sufficient",
    })
    expect(parsed).toBeUndefined()
  })

  test("parseDecision rejects a decision with the wrong version", () => {
    expect(parseDecision({ ...decision("allow"), version: 1 })).toBeUndefined()
    expect(parseDecision({ ...decision("allow"), version: 3 })).toBeUndefined()
  })

  test("parseDecision rejects invalid scope_alignment values", () => {
    expect(parseDecision({ ...decision("allow"), scope_alignment: "perfect" })).toBeUndefined()
  })

  test("parseDecision rejects invalid evidence_completeness values", () => {
    expect(parseDecision({ ...decision("allow"), evidence_completeness: "great" })).toBeUndefined()
  })

  test("parseDecision rejects a v2 decision missing scope_alignment", () => {
    const parsed = parseDecision({
      version: 2,
      outcome: "allow",
      risk_level: "low",
      user_authorization: "high",
      rationale: "safe",
      confidence: 0.9,
      evidence_completeness: "sufficient",
    })
    expect(parsed).toBeUndefined()
  })

  test("parseDecision rejects a v2 decision missing evidence_completeness", () => {
    const parsed = parseDecision({
      version: 2,
      outcome: "allow",
      risk_level: "low",
      user_authorization: "high",
      rationale: "safe",
      confidence: 0.9,
      scope_alignment: "aligned",
    })
    expect(parsed).toBeUndefined()
  })

  test("DECISION_SCHEMA rejects unknown fields (additionalProperties: false)", () => {
    expect(DECISION_SCHEMA.additionalProperties).toBe(false)
  })

  test("DECISION_SCHEMA requires the version and v2 properties", () => {
    expect(DECISION_SCHEMA.properties).toHaveProperty("version")
    expect(DECISION_SCHEMA.properties).toHaveProperty("scope_alignment")
    expect(DECISION_SCHEMA.properties).toHaveProperty("evidence_completeness")
    expect(DECISION_SCHEMA.required).toContain("version")
    expect(DECISION_SCHEMA.required).toContain("scope_alignment")
    expect(DECISION_SCHEMA.required).toContain("evidence_completeness")
  })

  test("misaligned scope escalates an allow", () => {
    const result = enforceDecision(
      decision("allow", { scope_alignment: "misaligned" }),
      DEFAULT_CONFIG,
    )
    expect(result.kind).toBe("escalate")
  })

  test("aligned scope does not escalate by itself", () => {
    const result = enforceDecision(
      decision("allow", { scope_alignment: "aligned" }),
      DEFAULT_CONFIG,
    )
    expect(result.kind).toBe("allow")
  })

  test("insufficient evidence escalates a medium-risk allow", () => {
    const result = enforceDecision(
      decision("allow", {
        risk_level: "medium",
        user_authorization: "high",
        evidence_completeness: "insufficient",
      }),
      DEFAULT_CONFIG,
    )
    expect(result.kind).toBe("escalate")
  })

  test("insufficient evidence does not escalate a low-risk allow", () => {
    const result = enforceDecision(
      decision("allow", {
        risk_level: "low",
        user_authorization: "high",
        evidence_completeness: "insufficient",
      }),
      DEFAULT_CONFIG,
    )
    expect(result.kind).toBe("allow")
  })

  test("a v2 decision with unknown scope/evidence is never escalated by the v2 gates", () => {
    // The closest equivalent to a legacy decision: a valid v2 record whose
    // scope/evidence the reviewer could not determine. The v2 gates only fire
    // on "misaligned" / "insufficient", so "unknown" must still pass.
    const result = enforceDecision(
      decision("allow", {
        risk_level: "medium",
        user_authorization: "high",
        scope_alignment: "unknown",
        evidence_completeness: "unknown",
      }),
      DEFAULT_CONFIG,
    )
    expect(result.kind).toBe("allow")
  })

  test("deny and escalate outcomes are never affected by v2 gates", () => {
    expect(
      enforceDecision(decision("deny", { scope_alignment: "aligned" }), DEFAULT_CONFIG).kind,
    ).toBe("deny")
    expect(
      enforceDecision(decision("escalate", { evidence_completeness: "sufficient" }), DEFAULT_CONFIG)
        .kind,
    ).toBe("escalate")
  })
})
