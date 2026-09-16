import { assert } from "./util.mjs"

const syntheticOrigins = new Set(["authored-synthetic", "metamorphic-context"])
const metricFields = [
  "count",
  "families",
  "primaryScore",
  "familyWeightedSafety",
  "familyRecallAllow",
  "familyRecallDeny",
  "familyRecallEscalate",
  "exactAccuracy",
  "acceptableAccuracy",
  "confusion",
  "invalidOrMissing",
  "dangerousApprovals",
  "unsupportedApprovals",
  "criticalApprovals",
  "criticalCases",
  "falseDenials",
  "unnecessaryEscalations",
  "benignAutoApprovalRate",
  "familiesWithAnyUnsafeApproval",
  "allMembersCorrectFamilyRate",
  "observedCriticalGate",
]

const pick = (value, fields) => Object.fromEntries(fields.map((key) => [key, value?.[key] ?? null]))

export function publicReport(document) {
  const { run, summary, results } = document
  assert(
    run?.fingerprint && run?.datasetHash && run?.source?.sourceSha256,
    "Missing run provenance.",
  )
  assert(run.source.match === true, "Public results require the pinned plugin source.")
  assert(
    summary?.complete === true && Array.isArray(results) && results.length === summary.expectedRows,
    "Only complete runs can be published.",
  )
  assert(
    results.every(
      (row) => syntheticOrigins.has(row.origin) && row.runFingerprint === run.fingerprint,
    ),
    "Public results must contain only matching synthetic cases.",
  )
  const models = (run.models ?? []).map((model) =>
    pick(model, ["id", "model", "format", "transport", "variant"]),
  )
  assert(models.length > 0, "Missing model provenance.")
  const metrics = Object.fromEntries(
    models.map((model) => {
      const scored = summary.models?.[model.id]
      assert(scored, `Missing metrics for ${model.id}.`)
      return [
        model.id,
        {
          model: pick(scored.model, metricFields),
          reachable: pick(scored.reachable, metricFields),
          effective: pick(scored.effective, metricFields),
          firstAttempt: pick(scored.firstAttempt, metricFields),
          operational: {
            httpAttempts: scored.operational?.httpAttempts ?? null,
            transportFailures: scored.operational?.transportFailures ?? null,
            requestsRetried: scored.operational?.requestsRetried ?? null,
            latencyMs: pick(scored.operational?.latencyMs, ["p50", "p95", "mean"]),
            usage: pick(scored.operational?.usage, [
              "inputTokens",
              "outputTokens",
              "attemptsWithMissingUsage",
              "complete",
            ]),
          },
        },
      ]
    }),
  )
  return {
    schemaVersion: 1,
    kind: "synthetic-permission-reviewer-benchmark",
    warning: "Single-author synthetic labels; not a production safety certification.",
    provenance: {
      runFingerprint: run.fingerprint,
      datasetHash: run.datasetHash,
      pluginSourceSha256: run.source.sourceSha256,
      pinnedCommit: run.source.pinnedCommit,
      harnessSha256: run.harnessSha256,
      track: run.options?.track ?? null,
      repeats: run.options?.repeats ?? null,
      seed: run.options?.seed ?? null,
    },
    models,
    metrics,
    results: results.map((row) => ({
      caseId: row.caseId,
      family: row.family,
      category: row.category,
      split: row.split,
      modelId: row.modelId,
      repeat: row.repeat,
      expected: row.gold?.outcome ?? null,
      acceptable: row.gold?.acceptable ?? [],
      critical: row.gold?.critical ?? false,
      severity: row.gold?.severity ?? null,
      reachable: row.reachable,
      status: row.status,
      firstOutcome: row.firstDecision?.outcome ?? null,
      modelOutcome: row.decision?.outcome ?? null,
      modelRisk: row.decision?.risk_level ?? null,
      modelAuthorization: row.decision?.user_authorization ?? null,
      modelScope: row.decision?.scope_alignment ?? null,
      modelEvidence: row.decision?.evidence_completeness ?? null,
      confidence: row.decision?.confidence ?? null,
      effectiveOutcome: row.effective?.kind ?? null,
    })),
  }
}
