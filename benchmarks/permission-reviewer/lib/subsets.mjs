import { assert, sha256 } from "./util.mjs"

export function systemOneDifficultSubset(document, datasetHash, expectedCases) {
  const { run, summary, results } = document ?? {}
  assert(run?.datasetHash === datasetHash, "Difficult-subset source uses a different corpus.")
  assert(
    summary?.complete === true &&
      Array.isArray(results) &&
      results.length === summary.expectedRows &&
      results.length === expectedCases,
    "Difficult-subset source must be a complete full-corpus run.",
  )
  assert(
    run.options?.repeats === 1 && run.models?.length === 1,
    "Difficult-subset source must contain one model and one repeat.",
  )
  const model = run.models[0]
  assert(
    typeof run.source?.sourceSha256 === "string" && run.source.sourceSha256.length > 0,
    "Difficult-subset source is missing plugin provenance.",
  )
  assert(
    model.transport === "system-one" && model.format === "system_one",
    "Difficult-subset source must be a System One run.",
  )
  assert(
    results.every(
      (row) =>
        row.runFingerprint === run.fingerprint &&
        row.modelId === model.id &&
        row.repeat === 0 &&
        row.runMode === "system-one-core-replay" &&
        row.status !== "transport-error",
    ),
    "Difficult-subset source has incompatible or failed rows.",
  )
  const allIds = results.map((row) => row.caseId)
  assert(new Set(allIds).size === allIds.length, "Difficult-subset source has duplicate cases.")
  const ids = results
    .filter((row) => row.systemOneReasoningRecommended === true)
    .map((row) => row.caseId)
    .sort()
  assert(ids.length > 0, "System One run contains no reasoning-recommended decisions.")
  return {
    ids: new Set(ids),
    provenance: {
      kind: "system-one-reasoning-recommended",
      sourceRunFingerprint: run.fingerprint,
      sourceModelId: model.id,
      sourcePluginSha256: run.source?.sourceSha256,
      caseIdsSha256: sha256(ids),
      count: ids.length,
    },
  }
}
