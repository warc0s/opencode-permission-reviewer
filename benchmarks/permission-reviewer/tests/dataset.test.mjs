import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { loadDataset, validateCases, modelInput, selectCases } from "../lib/dataset.mjs"
import { sha256, shuffle } from "../lib/util.mjs"
const data = await loadDataset(fileURLToPath(new URL("../data/cases.jsonl", import.meta.url)))
test("600 requests, 140 families, 19 categories, all three outcomes", () => {
  assert.equal(data.cases.length, 600)
  assert.equal(data.validation.families, 140)
  assert.equal(data.validation.categories.length, 19)
  assert.deepEqual(data.validation.outcomes, { allow: 214, deny: 195, escalate: 191 })
})
test("synthetic labels have explicit provenance, not asserted human ground truth", () => {
  assert(data.cases.every((c) => c.gold.annotationStatus === "single-author-draft"))
})
test("paired cases and all mutations remain within one split", () => {
  const seen = new Map()
  for (const c of data.cases) {
    if (seen.has(c.family)) assert.equal(c.split, seen.get(c.family))
    else seen.set(c.family, c.split)
  }
  assert.equal(data.cases.filter((c) => c.metamorphic).length, 160)
  assert.equal(data.cases.filter((c) => c.attack).length, 40)
})
test("20 complete fixed trajectories, not adaptive rollouts", () => {
  const t = data.cases.filter((c) => c.trajectory)
  assert.equal(t.length, 80)
  assert(
    t.every(
      (c) => c.trajectory.mode === "fixed-prefix-replay" && !c.trajectory.pendingActionExecuted,
    ),
  )
})
test("input whitelist excludes gold, rubric and expected result", () => {
  const c = structuredClone(data.cases[0])
  c.gold.reason = "GOLD_SENTINEL_DO_NOT_SEND"
  const x = modelInput(c)
  assert(!JSON.stringify(x).includes(c.gold.reason))
  assert(!("gold" in x))
  assert(!("family" in x))
  x.request.permission = "modified"
  assert.notEqual(c.input.request.permission, "modified")
})
test("reject annotation accidentally nested in input", () => {
  const cases = structuredClone(data.cases)
  cases[0].input.gold = cases[0].gold
  assert.throws(() => validateCases(cases), /unrecognized input key/)
})
test("reject repeated ids", () =>
  assert.throws(() => validateCases([data.cases[0], data.cases[0]]), /duplicate/i))
test("reject family split leakage", () => {
  const cases = structuredClone(data.cases)
  cases[1].split = cases[0].split === "dev" ? "holdout" : "dev"
  assert.throws(() => validateCases(cases), /crosses partitions/)
})
test("all partitions include every outcome", () => {
  for (const split of ["dev", "validation", "holdout"])
    for (const gold of ["allow", "deny", "escalate"])
      assert(data.cases.some((c) => c.split === split && c.gold.outcome === gold))
})
test("selection rejects an empty slice", () =>
  assert.throws(() => selectCases(data.cases, { category: "does-not-exist" }), /No selected/))
test("seeded shuffle reproducible, changes order, never mutates source", () => {
  const a = [1, 2, 3, 4, 5, 6]
  const before = [...a]
  assert.deepEqual(shuffle(a, 9), shuffle(a, 9))
  assert.notDeepEqual(shuffle(a, 9), shuffle(a, 19))
  assert.deepEqual(a, before)
})
test("stable fingerprints ignore key insertion order, not meaning", () => {
  assert.equal(sha256({ a: 1, b: 2 }), sha256({ b: 2, a: 1 }))
  assert.notEqual(sha256({ a: 1 }), sha256({ a: 2 }))
})
