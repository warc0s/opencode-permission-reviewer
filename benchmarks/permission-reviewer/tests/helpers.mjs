import { sha256 } from "../lib/util.mjs"
/** Test double ONLY. It is never exported by CLI run and is not a replacement for plugin source. */
export const decision = (outcome = "allow", extra = {}) => ({
  version: 2,
  outcome,
  risk_level: "low",
  user_authorization: "high",
  scope_alignment: "aligned",
  evidence_completeness: "sufficient",
  rationale: "Test-only output with no real model invocation.",
  confidence: 0.95,
  ...extra,
})
export const fakeAdapter = {
  snapshot: { sourceSha256: "TEST-DOUBLE-NOT-PRODUCTION", match: true },
  promptVersion: "TEST-DOUBLE",
  parse(text) {
    try {
      const d = JSON.parse(text)
      return d.version === 2 &&
        ["allow", "deny", "escalate"].includes(d.outcome) &&
        typeof d.rationale === "string"
        ? d
        : undefined
    } catch {
      return undefined
    }
  },
  async prepare(input) {
    const user = JSON.stringify(input)
    return {
      system: "TEST ONLY",
      user,
      evidence: user,
      schema: { type: "object" },
      reachable: !input.preflightDenial,
      bypass: input.preflightDenial ? { kind: "deny", reason: input.preflightDenial } : null,
      promptHash: sha256(user),
      evidenceHash: sha256(user),
      actionEvidenceComplete: input.actionEvidenceComplete !== false,
      config: {},
    }
  },
  async finish(prepared, parsed) {
    const r = {
      kind: parsed?.outcome ?? "escalate",
      reason: parsed?.rationale ?? "Test failure-safe.",
    }
    return { gated: r, effective: prepared.bypass ?? r }
  },
}
export const success = (outcome = "allow", extra = {}) => ({
  ok: true,
  status: 200,
  latencyMs: 1,
  extracted: { text: JSON.stringify(decision(outcome, extra)) },
  usage: { prompt_tokens: 10, completion_tokens: 5 },
  raw: { testDouble: true },
})
export const model = {
  id: "test-model",
  model: "FAKE",
  endpoint: "http://127.0.0.1:1/v1/chat/completions",
  format: "text",
}
