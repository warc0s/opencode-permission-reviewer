#!/usr/bin/env bun
/** Run this inside the actual pinned checkout. This is NOT part of Node-only mocked tests. */
import assert from "node:assert/strict"
import { resolve, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { openPlugin } from "../lib/plugin.mjs"
import { loadDataset, modelInput } from "../lib/dataset.mjs"
import { decision } from "./helpers.mjs"
const i = process.argv.indexOf("--repo")
assert(i >= 0 && process.argv[i + 1], "Usage: bun tests/plugin-parity.mjs --repo /path/plugin")
const repo = resolve(process.argv[i + 1])
const adapter = await openPlugin(repo, { allowDrift: process.argv.includes("--allow-drift") })
const coreDecision = await import(pathToFileURL(resolve(repo, "src/decision.ts")).href)
const context = await import(pathToFileURL(resolve(repo, "src/context.ts")).href)
const policy = await import(pathToFileURL(resolve(repo, "src/policy.ts")).href)
const data = await loadDataset(
  resolve(dirname(fileURLToPath(import.meta.url)), "../data/cases.jsonl"),
)
let checks = 0
for (const c of data.cases) {
  const p = await adapter.prepare(modelInput(c), { model: "not-called", format: "text" })
  const exact = context.buildEvidenceResult(p.envelope, p.config)
  assert.equal(p.evidence, exact.text)
  assert.equal(p.system, policy.REVIEWER_SYSTEM_PROMPT)
  const tenant =
    (p.config.policy ?? policy.DEFAULT_TENANT_POLICY) +
    (c.input.policyAppend
      ? "\n\n## Trusted case-specific restrictions\n" + c.input.policyAppend
      : "")
  assert.equal(p.user, policy.buildReviewerPrompt(tenant, exact.text, "text"))
  for (const outcome of ["allow", "deny", "escalate"]) {
    const d = decision(outcome),
      parsed = adapter.parse(JSON.stringify(d))
    assert.deepEqual(parsed, coreDecision.parseDecisionFromText(JSON.stringify(d)))
    const result = await adapter.finish(p, parsed)
    assert.deepEqual(result.gated, {
      ...coreDecision.enforceDecision(parsed, p.config),
      decisionSource: "llm-reviewer",
    })
    if (p.actionEvidenceComplete === false && result.effective.kind === "allow")
      throw new Error("Incomplete action was approved: " + c.id)
    checks++
  }
}
const c =
  data.cases.find(
    (c) =>
      c.gold.outcome === "allow" && c.input.request.metadata.command === "git status --porcelain",
  ) ?? data.cases[0]
const p = await adapter.prepare(modelInput(c), { model: "not-called", format: "text" })
for (const invalid of [
  "",
  "{}",
  "prose " + JSON.stringify(decision()),
  JSON.stringify(decision()) + "\n" + JSON.stringify(decision()),
  "[]",
  "null",
])
  assert.equal(adapter.parse(invalid), undefined)
assert(adapter.parse("```json\n" + JSON.stringify(decision()) + "\n```"))
assert.equal((await adapter.finish(p, decision("deny", { confidence: 0 }))).gated.kind, "deny")
assert.notEqual(
  (await adapter.finish(p, decision("allow", { risk_level: "critical" }))).effective.kind,
  "allow",
)
assert.notEqual(
  (await adapter.finish(p, decision("allow", { confidence: 0 }))).effective.kind,
  "allow",
)
assert.notEqual(
  (await adapter.finish(p, decision("allow", { scope_alignment: "misaligned" }))).effective.kind,
  "allow",
)
const degraded = structuredClone(modelInput(c))
degraded.config.configDegraded = ["test-only config failure"]
assert.notEqual(
  (
    await adapter.finish(
      await adapter.prepare(degraded, { model: "not-called", format: "text" }),
      decision(),
    )
  ).effective.kind,
  "allow",
)
console.log(
  JSON.stringify(
    {
      pass: true,
      caseProfiles: data.cases.length,
      decisionPaths: checks,
      networkCalls: 0,
      fixtureExecutions: 0,
      source: adapter.snapshot.sourceSha256,
      scope:
        "Pure evidence/prompt/parser/core parity. NOT native V1/V2 host lifecycle integration.",
    },
    null,
    2,
  ),
)
