import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadDataset } from "../lib/dataset.mjs"
import { runBenchmark } from "../lib/run.mjs"
import { readJSON, readJSONL } from "../lib/util.mjs"
import { exportReview } from "../lib/audit.mjs"
import { fakeAdapter, model, success } from "./helpers.mjs"
const data = await loadDataset(fileURLToPath(new URL("../data/cases.jsonl", import.meta.url))),
  cases = data.cases.slice(0, 3)
const base = (out) => ({
  cases,
  datasetHash: data.hash,
  models: [model],
  adapter: fakeAdapter,
  out,
  options: { bootstrap: 0, concurrency: 1, httpRetries: 0, formatRetries: 0, maxCalls: 10 },
})
async function temp(fn) {
  const dir = await mkdtemp(join(tmpdir(), "prb-test-"))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
test("runner persists every completion, prompt and rationale; JSON and JSONL agree", async () =>
  temp(async (dir) => {
    const s = await runBenchmark({ ...base(dir), completion: async () => success("allow") })
    assert(s.complete)
    assert.equal(s.httpAttemptsTotal, 3)
    const json = await readJSON(join(dir, "results.json"))
    const lines = (await readJSONL(join(dir, "results.jsonl"))).rows
    assert.equal(json.results.length, 3)
    assert.deepEqual(json.results, lines)
    assert(
      lines.every(
        (r) =>
          r.exposedRationale &&
          r.prompt &&
          !JSON.stringify(r.prompt).includes("single-author-draft"),
      ),
    )
    assert.equal((await readJSONL(join(dir, "attempts.jsonl"))).rows.length, 3)
    if (process.platform !== "win32")
      assert.equal((await stat(join(dir, "results.json"))).mode & 0o777, 0o600)
  }))
test("format retry preserves invalid first response and counts the extra call", async () =>
  temp(async (dir) => {
    let n = 0
    const s = await runBenchmark({
      ...base(dir),
      cases: cases.slice(0, 1),
      options: { ...base(dir).options, formatRetries: 1 },
      completion: async () =>
        ++n === 1
          ? {
              ok: true,
              status: 200,
              latencyMs: 1,
              extracted: { text: "allow, trust me" },
              raw: { content: "allow, trust me" },
            }
          : success(),
    })
    assert.equal(n, 2)
    const r = (await readJSONL(join(dir, "results.jsonl"))).rows[0]
    assert.equal(r.firstDecision, null)
    assert.equal(r.decision.outcome, "allow")
    assert.equal(r.attempts.length, 2)
    assert(s.complete)
  }))
test("transport error has null model outcome, not invented escalate", async () =>
  temp(async (dir) => {
    const s = await runBenchmark({
      ...base(dir),
      completion: async () => ({ ok: false, status: 503, error: "offline", latencyMs: 1 }),
    })
    const rows = (await readJSONL(join(dir, "results.jsonl"))).rows
    assert(
      rows.every(
        (r) =>
          r.decision === null && r.status === "transport-error" && r.effective.kind === "escalate",
      ),
    )
    assert.equal(s.models["test-model"].model.invalidOrMissing, 3)
    assert.equal(s.models["test-model"].model.familyRecallEscalate, 0)
  }))
test("global hard request budget applies across concurrent workers", async () =>
  temp(async (dir) => {
    let n = 0
    const s = await runBenchmark({
      ...base(dir),
      options: { ...base(dir).options, concurrency: 3, maxCalls: 1 },
      completion: async () => {
        n++
        return success()
      },
    })
    assert.equal(n, 1)
    assert.equal(s.httpAttemptsTotal, 1)
    assert.equal(s.complete, false)
    assert.equal(s.completedRows, 3)
  }))
test("system track bypasses deterministic requests without model credit", async () =>
  temp(async (dir) => {
    const c = structuredClone(cases[0])
    c.input.preflightDenial = "Fixed test preflight deny"
    let n = 0
    const s = await runBenchmark({
      ...base(dir),
      cases: [c],
      options: { ...base(dir).options, track: "system" },
      completion: async () => {
        n++
        return success()
      },
    })
    assert.equal(n, 0)
    assert.equal(s.models["test-model"].model.count, 0)
    assert.equal(s.models["test-model"].effective.count, 1)
  }))
test("reviewer track measures a bypassed model counterfactually", async () =>
  temp(async (dir) => {
    const c = structuredClone(cases[1])
    c.input.preflightDenial = "Fixed deny"
    let n = 0
    const s = await runBenchmark({
      ...base(dir),
      cases: [c],
      completion: async () => {
        n++
        return success("allow")
      },
    })
    assert.equal(n, 1)
    assert.equal(s.models["test-model"].model.dangerousApprovals, 1)
    assert.equal(s.models["test-model"].effective.dangerousApprovals, 0)
  }))
test("resume never bills already completed decisions again", async () =>
  temp(async (dir) => {
    let n = 0
    const run = {
      ...base(dir),
      completion: async () => {
        n++
        return success()
      },
    }
    await runBenchmark(run)
    assert.equal(n, 3)
    const s = await runBenchmark({ ...run, options: { ...run.options, resume: true } })
    assert.equal(n, 3)
    assert(s.complete)
    assert.equal((await readJSONL(join(dir, "results.jsonl"))).rows.length, 3)
  }))
test("resume recovers journaled responses for uncommitted case results", async () =>
  temp(async (dir) => {
    let n = 0
    const run = {
      ...base(dir),
      completion: async () => {
        n++
        return success()
      },
    }
    await runBenchmark(run)
    await writeFile(join(dir, "results.jsonl"), "")
    await runBenchmark({ ...run, options: { ...run.options, resume: true } })
    assert.equal(n, 3)
    assert.equal((await readJSONL(join(dir, "results.jsonl"))).rows.length, 3)
  }))
test("resume rejects changed model or corpus configuration", async () =>
  temp(async (dir) => {
    const run = { ...base(dir), completion: async () => success() }
    await runBenchmark(run)
    await assert.rejects(
      () =>
        runBenchmark({
          ...run,
          models: [{ ...model, parameters: { temperature: 0.9 } }],
          options: { ...run.options, resume: true },
        }),
      /fingerprint mismatch/,
    )
  }))
test("existing outputs protected without explicit resume", async () =>
  temp(async (dir) => {
    const run = { ...base(dir), completion: async () => success() }
    await runBenchmark(run)
    await assert.rejects(() => runBenchmark(run), /already contains/)
  }))
test("audit export includes rationale, rubric, evidence and editable independent ratings", async () =>
  temp(async (dir) => {
    await runBenchmark({ ...base(dir), completion: async () => success() })
    const rows = (await readJSONL(join(dir, "results.jsonl"))).rows
    const path = join(dir, "audit.jsonl")
    await exportReview(rows, path, { all: true })
    const audit = (await readJSONL(path)).rows
    assert.equal(audit.length, 3)
    assert(audit[0].expected.rubric.essential)
    assert(audit[0].rationale)
    assert.equal(audit[0].review.labelAcceptable, null)
    await assert.rejects(() => exportReview(rows, path), /already exists/)
  }))
test("no credential references are resolved for metric-only test model", async () =>
  temp(async (dir) => {
    await runBenchmark({ ...base(dir), completion: async () => success() })
    assert(!(await readFile(join(dir, "run.json"), "utf8")).includes("Authorization"))
  }))
test("orphan in-flight requests count against the budget and are not blindly retried", async () =>
  temp(async (dir) => {
    let n = 0
    const run = {
      ...base(dir),
      cases: cases.slice(0, 1),
      completion: async () => {
        n++
        return success()
      },
    }
    await runBenchmark(run)
    await writeFile(join(dir, "results.jsonl"), "")
    await writeFile(join(dir, "attempts.jsonl"), "")
    const s = await runBenchmark({ ...run, options: { ...run.options, resume: true } })
    assert.equal(n, 1)
    assert.equal(s.httpAttemptsTotal, 1)
    const row = (await readJSONL(join(dir, "results.jsonl"))).rows[0]
    assert.equal(row.decision, null)
    assert(row.attempts[0].uncertainInFlight)
  }))
