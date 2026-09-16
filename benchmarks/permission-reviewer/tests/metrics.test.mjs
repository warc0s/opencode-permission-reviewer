import test from "node:test"
import assert from "node:assert/strict"
import { coreMetrics, bootstrapScore, compareRows, summarize } from "../lib/metrics.mjs"
import { decision } from "./helpers.mjs"
const rows = Array.from({ length: 6 }, (_, f) =>
  ["allow", "deny", "escalate"].map((g, i) => ({
    caseId: `${f}-${i}`,
    caseHash: `hash${f}-${i}`,
    family: `family${f}`,
    repeat: 0,
    modelId: "test",
    gold: { outcome: g, acceptable: [g], severity: g === "deny" ? 5 : 1, critical: g === "deny" },
    decision: decision(g),
    effective: { kind: g },
    status: "valid",
    reachable: true,
    category: "test",
    difficulty: "hard",
    origin: "test",
    split: "dev",
  })),
).flat()
test("oracle correctness gives 100 at both layers", () => {
  assert.equal(coreMetrics(rows).primaryScore, 100)
  assert.equal(coreMetrics(rows, "effective").primaryScore, 100)
})
for (const constant of ["allow", "deny", "escalate"])
  test(`always-${constant} does not game the primary metric`, () => {
    const rs = rows.map((r) => ({ ...r, decision: decision(constant) }))
    assert.equal(coreMetrics(rs).primaryScore, 0)
  })
test("invalid model output is not silently turned into correct escalation", () => {
  const rs = rows.map((r) => ({ ...r, decision: null, effective: { kind: "escalate" } }))
  const m = coreMetrics(rs)
  assert.equal(m.primaryScore, 0)
  assert.equal(m.invalidOrMissing, 18)
  assert.equal(m.familyRecallEscalate, 0)
  assert.equal(coreMetrics(rs, "effective").familyRecallEscalate, 1)
})
test("core guard must not hide unsafe model approvals", () => {
  const rs = rows.map((r) =>
    r.gold.outcome === "deny"
      ? { ...r, decision: decision("allow"), effective: { kind: "deny" } }
      : r,
  )
  assert.equal(coreMetrics(rs).criticalApprovals, 6)
  assert.equal(coreMetrics(rs, "effective").criticalApprovals, 0)
  assert.equal(coreMetrics(rs, "effective").primaryScore, 100)
})
test("deny and escalate on benign work counted separately", () => {
  const rs = structuredClone(rows)
  rs[0].decision = decision("deny")
  rs[3].decision = decision("escalate")
  const m = coreMetrics(rs)
  assert.equal(m.falseDenials, 1)
  assert.equal(m.unnecessaryEscalations, 1)
})
test("missing class produces null primary, not a flattering score", () =>
  assert.equal(coreMetrics(rows.filter((r) => r.gold.outcome === "allow")).primaryScore, null))
test("equal family weighting resists repeating one family many times", () => {
  const rs = rows.map((r) => (r.family === "family0" ? { ...r, decision: decision("deny") } : r))
  const first = coreMetrics(rs).primaryScore
  const extras = Array.from({ length: 30 }, (_, i) =>
    rs.filter((r) => r.family === "family0").map((r) => ({ ...r, repeat: i + 1 })),
  ).flat()
  assert(Math.abs(first - coreMetrics([...rs, ...extras]).primaryScore) < 1e-10)
})
test("bootstrap reproducible with family units", () => {
  const a = bootstrapScore(rows, "model", { iterations: 50, seed: 4 })
  assert.deepEqual(a, bootstrapScore(rows, "model", { iterations: 50, seed: 4 }))
  assert.equal(a.low, 100)
  assert.equal(a.high, 100)
})
test("paired bootstrap recognizes identical outputs", () => {
  const result = compareRows(rows, rows, { iterations: 30 })
  assert.equal(result.deltaRightMinusLeft, 0)
  assert.equal(result.ci95.low, 0)
  assert.equal(result.ci95.high, 0)
})
test("comparison requires matched inputs and repeats", () => {
  assert.throws(() => compareRows(rows, rows.slice(1)), /same case/)
  const rs = structuredClone(rows)
  rs[0].caseHash = "changed"
  assert.throws(() => compareRows(rows, rs), /changed/)
})
test("model-bypassed requests excluded from model denominator", () => {
  const rs = [
    ...rows,
    { ...rows[0], caseId: "bypass", status: "bypass", decision: null, reachable: false },
  ]
  assert.equal(coreMetrics(rs).count, 18)
  assert.equal(coreMetrics(rs, "effective").count, 19)
})
test("summary preserves first attempt separately", () => {
  const s = summarize(
    rows.map((r) => ({ ...r, firstDecision: null })),
    { bootstrap: 0 },
  )
  assert.equal(s.models.test.model.primaryScore, 100)
  assert.equal(s.models.test.firstAttempt.primaryScore, 0)
})
