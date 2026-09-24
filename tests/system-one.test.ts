import { describe, expect, test } from "bun:test"
import { resolveConfig, isSystemOneReviewerModel } from "../src/config.ts"
import { ReviewAttempt } from "../src/core/review-attempt.ts"
import { createSystemOneInvoker, SystemOneReviewerBackend } from "../src/system-one/backend.ts"
import {
  enforceParsedSystemOneReview,
  enforceSystemOneDecision,
  parseSystemOneReview,
  SYSTEM_ONE_QUESTIONS,
} from "../src/system-one/review.ts"
import type { ReviewEnvelope, ReviewExecutionResult } from "../src/types.ts"

const choice = (selected: string, keys: string[], confidence = 1) => {
  const remainder = (1 - confidence) / (keys.length - 1)
  return {
    type: "choice",
    choice: selected,
    confidence,
    probabilities: Object.fromEntries(
      keys.map((key) => [key, key === selected ? confidence : remainder]),
    ),
  }
}

function response(overrides: Record<string, unknown> = {}) {
  const answers: Record<string, unknown> = {
    outcome: choice("allow", ["allow", "deny", "escalate"]),
    risk_level: choice("low", ["low", "medium", "high", "critical"]),
    user_authorization: choice("high", ["high", "medium", "low", "unknown"]),
    scope_alignment: choice("aligned", ["aligned", "partial", "misaligned", "unknown"]),
    evidence_completeness: choice("sufficient", [
      "sufficient",
      "partial",
      "insufficient",
      "unknown",
    ]),
    primary_basis: choice("authorized_routine", [
      "authorized_routine",
      "authorized_reversible_change",
      "insufficient_authorization",
      "scope_mismatch",
      "insufficient_evidence",
      "destructive_effect",
      "credential_or_private_data",
      "security_or_privilege_change",
      "external_or_remote_effect",
      "trusted_policy_restriction",
      "conflicting_evidence",
    ]),
    material_authorization: { type: "noul", noul: 1 },
    within_intent_scope: { type: "noul", noul: 1 },
    unauthorized_data_loss: { type: "noul", noul: 0 },
    untrusted_sensitive_disclosure: { type: "noul", noul: 0 },
    excessive_credential_access: { type: "noul", noul: 0 },
    unauthorized_security_change: { type: "noul", noul: 0 },
    unauthorized_external_mutation: { type: "noul", noul: 0 },
    essential_evidence_missing: { type: "noul", noul: 0 },
    absolute_policy_deny: { type: "noul", noul: 0 },
    ...overrides,
  }
  return { model: "jev-1.13.0", answers, usage: { input_tokens: 10, output_tokens: 0 } }
}

function envelope(): ReviewEnvelope {
  return {
    request: {
      id: "req_system_one",
      sessionID: "ses_system_one",
      permission: "bash",
      patterns: ["printf ok"],
      metadata: { command: "printf ok" },
      always: [],
    },
    directory: "/workspace",
    worktree: "/workspace",
    transcript: "USER: Run the harmless marker command.",
    intentHistory: "Run the harmless marker command.",
    enrichment: "",
    sshAudit: [],
  }
}

describe("System One reviewer", () => {
  test("selects only known Jev providers and model IDs", () => {
    expect(isSystemOneReviewerModel("opencode/jev-1.13-free")).toBe(true)
    expect(isSystemOneReviewerModel("typesafe-ai/jev-latest")).toBe(true)
    expect(isSystemOneReviewerModel("commandcode/typesafe/jev")).toBe(true)
    expect(isSystemOneReviewerModel("commandcode/jev-1.13")).toBe(false)
    expect(isSystemOneReviewerModel("commandcode/typesafe/other")).toBe(false)
    expect(isSystemOneReviewerModel("other/jev-1.13")).toBe(false)
    expect(isSystemOneReviewerModel("opencode/not-jev")).toBe(false)
  })

  test("routes Zen, TypeSafe, and Command Code through their System One endpoints", async () => {
    const providers = [
      {
        model: "opencode/jev-1.13",
        returnedModel: "jev-1.13",
        keyName: "OPENCODE_API_KEY",
        url: "https://opencode.ai/zen/v1/systemone",
      },
      {
        model: "typesafe-ai/jev-1.13.0",
        returnedModel: "jev-1.13.0",
        keyName: "TYPESAFE_API_KEY",
        url: "https://api.typesafe.ai/v1/systemone",
      },
      {
        model: "commandcode/typesafe/jev",
        returnedModel: "typesafe/jev",
        keyName: "CMD_API_KEY",
        url: "https://api.commandcode.ai/provider/v1/systemone",
      },
    ] as const
    const previousBaseURL = process.env.TYPESAFE_BASE_URL
    delete process.env.TYPESAFE_BASE_URL
    try {
      for (const provider of providers) {
        const previousKey = process.env[provider.keyName]
        const apiKey = `synthetic-${provider.keyName.toLowerCase()}`
        process.env[provider.keyName] = apiKey
        try {
          const config = resolveConfig({ model: provider.model })
          const state = {
            trustedPolicy: { reviewer: "policy", tenant: "tenant" },
            untrustedEvidence: "evidence",
          }
          const calls: Array<{ url: string; init: RequestInit }> = []
          const invoke = createSystemOneInvoker(config, async (url, init) => {
            calls.push({ url: String(url), init: init ?? {} })
            return Response.json({ ...response(), model: provider.returnedModel })
          })
          const raw = await invoke(state, new AbortController().signal)
          expect(calls).toHaveLength(1)
          expect(calls[0]?.url).toBe(provider.url)
          expect(calls[0]?.init.method).toBe("POST")
          expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${apiKey}`)
          expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
            model: provider.model.slice(provider.model.indexOf("/") + 1),
            state,
            questions: SYSTEM_ONE_QUESTIONS,
          })
          expect(parseSystemOneReview(raw, config)?.decision.outcome).toBe("allow")
        } finally {
          if (previousKey === undefined) delete process.env[provider.keyName]
          else process.env[provider.keyName] = previousKey
        }
      }
    } finally {
      if (previousBaseURL === undefined) delete process.env.TYPESAFE_BASE_URL
      else process.env.TYPESAFE_BASE_URL = previousBaseURL
    }
  })

  test("rejects an unexpected returned model from Command Code", () => {
    const config = resolveConfig({ model: "commandcode/typesafe/jev" })
    expect(parseSystemOneReview({ ...response(), model: "jev-1.13" }, config)).toBeUndefined()
  })

  test("does not borrow a TypeSafe key for a Command Code request", () => {
    const commandKey = process.env.CMD_API_KEY
    const typesafeKey = process.env.TYPESAFE_API_KEY
    delete process.env.CMD_API_KEY
    process.env.TYPESAFE_API_KEY = "synthetic-typesafe-key"
    try {
      expect(() =>
        createSystemOneInvoker(resolveConfig({ model: "commandcode/typesafe/jev" })),
      ).toThrow(/Missing CMD_API_KEY/)
    } finally {
      if (commandKey === undefined) delete process.env.CMD_API_KEY
      else process.env.CMD_API_KEY = commandKey
      if (typesafeKey === undefined) delete process.env.TYPESAFE_API_KEY
      else process.env.TYPESAFE_API_KEY = typesafeKey
    }
  })

  test("builds a complete fixed question set", () => {
    expect(Object.keys(SYSTEM_ONE_QUESTIONS)).toHaveLength(15)
    expect(SYSTEM_ONE_QUESTIONS.outcome.type).toBe("choice")
    expect(SYSTEM_ONE_QUESTIONS.absolute_policy_deny.type).toBe("noul")
  })

  test("accepts a confident and internally consistent allow", () => {
    const config = resolveConfig({ model: "opencode/jev-1.13-free" })
    const parsed = parseSystemOneReview(response(), config)
    expect(parsed?.difficultReason).toBeUndefined()
    expect(parsed?.decision).toMatchObject({
      outcome: "allow",
      risk_level: "low",
      confidence: 1,
      rationale: "The action is routine, narrow, and adequately authorized.",
    })
  })

  test("escalates a low-confidence deny instead of trusting it", () => {
    const config = resolveConfig({ model: "opencode/jev-1.13-free" })
    const parsed = parseSystemOneReview(
      response({
        outcome: choice("deny", ["allow", "deny", "escalate"], 0.35),
        risk_level: choice("high", ["low", "medium", "high", "critical"]),
        primary_basis: choice("destructive_effect", [
          "authorized_routine",
          "authorized_reversible_change",
          "insufficient_authorization",
          "scope_mismatch",
          "insufficient_evidence",
          "destructive_effect",
          "credential_or_private_data",
          "security_or_privilege_change",
          "external_or_remote_effect",
          "trusted_policy_restriction",
          "conflicting_evidence",
        ]),
        unauthorized_data_loss: { type: "noul", noul: 1 },
      }),
      config,
    )
    expect(parsed?.decision.outcome).toBe("deny")
    expect(parsed?.difficultReason).toContain("below 0.40")
  })

  test("uses outcome confidence instead of the weakest descriptive field", () => {
    const config = resolveConfig({ model: "opencode/jev-1.13-free" })
    const parsed = parseSystemOneReview(
      response({
        evidence_completeness: choice(
          "sufficient",
          ["sufficient", "partial", "insufficient", "unknown"],
          0.31,
        ),
      }),
      config,
    )
    expect(parsed?.decision.confidence).toBe(1)
    expect(parsed?.difficultReason).toBeUndefined()
  })

  test("requires strong outcome confidence to allow with incomplete evidence", () => {
    const config = resolveConfig({ model: "opencode/jev-1.13-free" })
    const parsed = parseSystemOneReview(
      response({
        outcome: choice("allow", ["allow", "deny", "escalate"], 0.62),
        evidence_completeness: choice("partial", [
          "sufficient",
          "partial",
          "insufficient",
          "unknown",
        ]),
      }),
      config,
    )
    expect(parsed?.difficultReason).toContain("incomplete evidence")
  })

  test("recommends reasoning only when an explicit escalation is plausibly resolvable", () => {
    const config = resolveConfig({ model: "opencode/jev-1.13-free" })
    const strict = resolveConfig({
      model: "opencode/jev-1.13-free",
      systemOneReasoningThreshold: 0.5,
    })
    const clear = parseSystemOneReview(
      response({ outcome: choice("escalate", ["allow", "deny", "escalate"]) }),
      config,
    )
    const ambiguous = parseSystemOneReview(
      response({ outcome: choice("escalate", ["allow", "deny", "escalate"], 0.6) }),
      config,
    )
    expect(clear?.reasoningRecommended).toBe(false)
    expect(ambiguous?.reasoningRecommended).toBe(true)
    expect(
      parseSystemOneReview(
        response({ outcome: choice("escalate", ["allow", "deny", "escalate"], 0.6) }),
        strict,
      )?.reasoningRecommended,
    ).toBe(false)
  })

  test("preserves a valid deny even when its confidence marks it difficult", () => {
    const config = resolveConfig({ model: "opencode/jev-1.13-free" })
    const parsed = parseSystemOneReview(
      response({
        outcome: choice("deny", ["allow", "deny", "escalate"], 0.35),
        risk_level: choice("high", ["low", "medium", "high", "critical"]),
        primary_basis: choice("destructive_effect", [
          "authorized_routine",
          "authorized_reversible_change",
          "insufficient_authorization",
          "scope_mismatch",
          "insufficient_evidence",
          "destructive_effect",
          "credential_or_private_data",
          "security_or_privilege_change",
          "external_or_remote_effect",
          "trusted_policy_restriction",
          "conflicting_evidence",
        ]),
      }),
      config,
    )
    expect(parsed?.difficultReason).toContain("below 0.40")
    expect(enforceParsedSystemOneReview(parsed!, config).kind).toBe("deny")
  })

  test("does not reapply chat-model confidence floors after reconciliation", () => {
    const config = resolveConfig({ model: "opencode/jev-1.13-free" })
    const parsed = parseSystemOneReview(
      response({ outcome: choice("allow", ["allow", "deny", "escalate"], 0.55) }),
      config,
    )
    expect(parsed?.difficultReason).toBeUndefined()
    expect(enforceSystemOneDecision(parsed!.decision, config).kind).toBe("allow")
  })

  test("treats an unsafe allow signal as a difficult contradiction", () => {
    const config = resolveConfig({ model: "opencode/jev-1.13-free" })
    const parsed = parseSystemOneReview(
      response({ untrusted_sensitive_disclosure: { type: "noul", noul: 0.85 } }),
      config,
    )
    expect(parsed?.difficultReason).toContain("material safety signal")
  })

  test("rejects a choice that is not the most probable option", () => {
    const config = resolveConfig({ model: "opencode/jev-1.13-free" })
    const raw = response()
    raw.answers.outcome = {
      type: "choice",
      choice: "allow",
      confidence: 0.6,
      probabilities: { allow: 0.05, deny: 0.9, escalate: 0.05 },
    }
    expect(parseSystemOneReview(raw, config)).toBeUndefined()
  })

  test("routes a valid difficult decision to the configured reasoning reviewer", async () => {
    const config = resolveConfig({ model: "opencode/jev-1.13-free" })
    let escalations = 0
    const secondary: ReviewExecutionResult = {
      kind: "deny",
      reason: "Reasoning reviewer denied the action.",
      decisionSource: "llm-reviewer",
    }
    const backend = new SystemOneReviewerBackend(
      config,
      async () => {
        escalations++
        return secondary
      },
      "openai/gpt-5.6-luna",
      async () => response({ outcome: choice("escalate", ["allow", "deny", "escalate"], 0.6) }),
    )
    const result = await backend.review(envelope(), new ReviewAttempt("generation", 10_000))
    expect(result.kind).toBe("deny")
    expect(result.reviewerModel).toBe("openai/gpt-5.6-luna")
    expect(result.reviewerEscalatedFrom?.model).toBe("opencode/jev-1.13-free")
    expect(escalations).toBe(1)
  })

  test("keeps a clear System One escalation manual without paying for reasoning", async () => {
    const config = resolveConfig({ model: "opencode/jev-1.13-free" })
    let escalations = 0
    const backend = new SystemOneReviewerBackend(
      config,
      async () => {
        escalations++
        return { kind: "deny", reason: "unexpected" }
      },
      "openai/gpt-5.6-luna",
      async () => response({ outcome: choice("escalate", ["allow", "deny", "escalate"]) }),
    )
    const result = await backend.review(envelope(), new ReviewAttempt("generation", 10_000))
    expect(result.kind).toBe("escalate")
    expect(result.decisionSource).toBe("system-one-reviewer")
    expect(escalations).toBe(0)
  })

  test("honors a valid System One deny without paying for reasoning", async () => {
    const config = resolveConfig({ model: "opencode/jev-1.13-free" })
    let escalations = 0
    const backend = new SystemOneReviewerBackend(
      config,
      async () => {
        escalations++
        return { kind: "allow", reason: "unexpected" }
      },
      "openai/gpt-5.6-luna",
      async () =>
        response({
          outcome: choice("deny", ["allow", "deny", "escalate"], 0.35),
          primary_basis: choice("destructive_effect", [
            "authorized_routine",
            "authorized_reversible_change",
            "insufficient_authorization",
            "scope_mismatch",
            "insufficient_evidence",
            "destructive_effect",
            "credential_or_private_data",
            "security_or_privilege_change",
            "external_or_remote_effect",
            "trusted_policy_restriction",
            "conflicting_evidence",
          ]),
        }),
    )
    const result = await backend.review(envelope(), new ReviewAttempt("generation", 10_000))
    expect(result.kind).toBe("deny")
    expect(escalations).toBe(0)
  })

  test("does not let a reasoning reviewer override an escalation with incomplete evidence", async () => {
    const config = resolveConfig({ model: "opencode/jev-1.13-free" })
    const backend = new SystemOneReviewerBackend(
      config,
      async () => ({
        kind: "allow",
        reason: "The action appears safe.",
        decisionSource: "llm-reviewer",
        reviewerOutcome: "allow",
        decision: {
          version: 2,
          outcome: "allow",
          risk_level: "low",
          user_authorization: "high",
          scope_alignment: "aligned",
          evidence_completeness: "partial",
          rationale: "The action appears safe.",
          confidence: 0.95,
        },
      }),
      "openai/gpt-5.6-luna",
      async () => response({ outcome: choice("escalate", ["allow", "deny", "escalate"], 0.6) }),
    )
    const result = await backend.review(envelope(), new ReviewAttempt("generation", 10_000))
    expect(result.kind).toBe("escalate")
    expect(result.reviewerOutcome).toBe("allow")
    expect(result.reviewerModel).toBe("openai/gpt-5.6-luna")
    expect(result.reviewerEscalatedFrom?.model).toBe("opencode/jev-1.13-free")
  })

  test("accepts a reasoning reviewer allow backed by sufficient evidence", async () => {
    const config = resolveConfig({ model: "opencode/jev-1.13-free" })
    const backend = new SystemOneReviewerBackend(
      config,
      async () => ({
        kind: "allow",
        reason: "The action is supported by complete evidence.",
        decisionSource: "llm-reviewer",
        reviewerOutcome: "allow",
        decision: {
          version: 2,
          outcome: "allow",
          risk_level: "low",
          user_authorization: "high",
          scope_alignment: "aligned",
          evidence_completeness: "sufficient",
          rationale: "The action is supported by complete evidence.",
          confidence: 0.95,
        },
      }),
      "openai/gpt-5.6-luna",
      async () => response({ outcome: choice("escalate", ["allow", "deny", "escalate"], 0.6) }),
    )
    const result = await backend.review(envelope(), new ReviewAttempt("generation", 10_000))
    expect(result.kind).toBe("allow")
    expect(result.reviewerModel).toBe("openai/gpt-5.6-luna")
  })

  test("does not invoke the reasoning reviewer for a transport failure", async () => {
    const config = resolveConfig({ model: "opencode/jev-1.13-free" })
    let escalations = 0
    const backend = new SystemOneReviewerBackend(
      config,
      async () => {
        escalations++
        return { kind: "allow", reason: "unexpected" }
      },
      "openai/gpt-5.6-luna",
      async () => {
        throw new Error("synthetic transport failure")
      },
    )
    const result = await backend.review(envelope(), new ReviewAttempt("generation", 10_000))
    expect(result.kind).toBe("escalate")
    expect(result.decisionSource).toBe("failure-safe")
    expect(escalations).toBe(0)
  })
})
