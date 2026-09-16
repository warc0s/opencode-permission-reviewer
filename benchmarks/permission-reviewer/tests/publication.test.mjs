import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, chmod, stat, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { publicReport } from "../lib/publication.mjs"
import { privateDir } from "../lib/util.mjs"

const privateText = "SYNTHETIC_PRIVATE_MARKER"
const document = () => ({
  run: {
    fingerprint: "run-hash",
    datasetHash: "corpus-hash",
    harnessSha256: "harness-hash",
    source: { match: true, pinnedCommit: "commit-hash", sourceSha256: "source-hash" },
    models: [
      {
        id: "candidate",
        model: "candidate-version",
        format: "text",
        endpoint: `https://${privateText}.invalid`,
        apiKeyEnv: privateText,
      },
    ],
    options: { track: "reviewer", repeats: 1, seed: 17 },
  },
  summary: {
    complete: true,
    expectedRows: 1,
    models: {
      candidate: {
        model: { primaryScore: 70, dangerousApprovals: 0, secret: privateText },
        reachable: { primaryScore: 70 },
        effective: { primaryScore: 72 },
        firstAttempt: { primaryScore: 70 },
        operational: {
          httpAttempts: 1,
          transportFailures: 0,
          requestsRetried: 0,
          latencyMs: { p50: 12, p95: 12, mean: 12 },
          usage: { inputTokens: 100, outputTokens: 20, complete: true },
        },
      },
    },
  },
  results: [
    {
      origin: "authored-synthetic",
      runFingerprint: "run-hash",
      caseId: "case-1",
      family: "family-1",
      category: "git",
      split: "dev",
      modelId: "candidate",
      repeat: 0,
      gold: {
        outcome: "deny",
        acceptable: ["deny"],
        critical: true,
        severity: 5,
        reason: privateText,
      },
      reachable: true,
      status: "valid",
      firstDecision: { outcome: "deny" },
      decision: { outcome: "deny", rationale: privateText, confidence: 0.9 },
      effective: { kind: "deny", reason: privateText },
      prompt: { user: privateText },
      evidence: privateText,
      attempts: [{ rawText: privateText }],
    },
  ],
})

test("public export is an allowlist, not a redacted copy of raw records", () => {
  const report = publicReport(document())
  assert.equal(report.results[0].modelOutcome, "deny")
  assert.equal(report.metrics.candidate.model.primaryScore, 70)
  assert(!JSON.stringify(report).includes(privateText))
  assert(!("attempts" in report.results[0]))
})

test("public export rejects private, incomplete, and drifted runs", () => {
  const privateRun = document()
  privateRun.results[0].origin = "non-synthetic"
  assert.throws(() => publicReport(privateRun), /synthetic/)
  const incomplete = document()
  incomplete.summary.complete = false
  assert.throws(() => publicReport(incomplete), /complete/)
  const drifted = document()
  drifted.run.source.match = false
  assert.throws(() => publicReport(drifted), /pinned/)
})

test("private output handling does not chmod an existing public directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "prb-output-"))
  try {
    const publicPath = join(root, "public")
    await mkdir(publicPath)
    await chmod(publicPath, 0o755)
    await assert.rejects(privateDir(publicPath), /not private/)
    assert.equal((await stat(publicPath)).mode & 0o777, 0o755)
    const newPath = join(root, "private")
    await privateDir(newPath)
    assert.equal((await stat(newPath)).mode & 0o777, 0o700)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
