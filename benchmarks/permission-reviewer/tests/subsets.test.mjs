import test from "node:test"
import assert from "node:assert/strict"
import { systemOneDifficultSubset } from "../lib/subsets.mjs"

function document() {
  return {
    run: {
      fingerprint: "system-one-run",
      datasetHash: "dataset-hash",
      source: { sourceSha256: "plugin-source" },
      models: [
        {
          id: "jev-private",
          model: "jev-1.13-free",
          transport: "system-one",
          format: "system_one",
        },
      ],
      options: { repeats: 1 },
    },
    summary: { complete: true, expectedRows: 3 },
    results: [
      {
        caseId: "case-safe",
        modelId: "jev-private",
        repeat: 0,
        runFingerprint: "system-one-run",
        runMode: "system-one-core-replay",
        status: "valid",
        systemOneDifficulty: null,
        systemOneReasoningRecommended: false,
      },
      {
        caseId: "case-low-confidence",
        modelId: "jev-private",
        repeat: 0,
        runFingerprint: "system-one-run",
        runMode: "system-one-core-replay",
        status: "valid",
        systemOneDifficulty: "Confidence below threshold.",
        systemOneReasoningRecommended: true,
      },
      {
        caseId: "case-explicit-escalate",
        modelId: "jev-private",
        repeat: 0,
        runFingerprint: "system-one-run",
        runMode: "system-one-core-replay",
        status: "valid",
        systemOneDifficulty: "Explicit escalation.",
        systemOneReasoningRecommended: false,
      },
    ],
  }
}

test("derives a reproducible private reasoning-recommended subset", () => {
  const subset = systemOneDifficultSubset(document(), "dataset-hash", 3)
  assert.deepEqual([...subset.ids], ["case-low-confidence"])
  assert.deepEqual(subset.provenance, {
    kind: "system-one-reasoning-recommended",
    sourceRunFingerprint: "system-one-run",
    sourceModelId: "jev-private",
    sourcePluginSha256: "plugin-source",
    caseIdsSha256: subset.provenance.caseIdsSha256,
    count: 1,
  })
})

test("rejects mismatched, incomplete, or transport-failed source runs", () => {
  assert.throws(() => systemOneDifficultSubset(document(), "other-dataset", 3), /different corpus/)
  const incomplete = document()
  incomplete.summary.complete = false
  assert.throws(
    () => systemOneDifficultSubset(incomplete, "dataset-hash", 3),
    /complete full-corpus run/,
  )
  const failed = document()
  failed.results[0].status = "transport-error"
  assert.throws(() => systemOneDifficultSubset(failed, "dataset-hash", 3), /failed rows/)
})
