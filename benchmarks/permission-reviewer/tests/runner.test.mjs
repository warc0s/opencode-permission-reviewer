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
import { decision, fakeAdapter, model, success } from "./helpers.mjs"
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
test("a host safety stop prevents further benchmark requests", async () =>
  temp(async (dir) => {
    let calls = 0
    const result = await runBenchmark({
      ...base(dir),
      completion: async () => {
        calls++
        return { ok: false, status: 429, error: "Limit reached", halt: true, latencyMs: 1 }
      },
    })
    assert.equal(calls, 1)
    assert.equal(result.complete, false)
    assert.equal(result.completedRows, 1)
  }))
test(
  "OpenCode transport permits three concurrent workers and caps the pool",
  { timeout: 30000 },
  async () =>
    temp(async (dir) => {
      process.env.PRB_TEST_CONCURRENT_PASSWORD = "synthetic-local-password"
      const hostModel = {
        id: "luna-medium",
        model: "openai/gpt-5.6-luna",
        endpoint: "http://127.0.0.1:1/",
        transport: "opencode-v1",
        variant: "medium",
        format: "text",
        hostPasswordEnv: "PRB_TEST_CONCURRENT_PASSWORD",
      }
      let active = 0
      let peak = 0
      let releaseAll
      let timer
      const allStarted = new Promise((resolve, reject) => {
        releaseAll = resolve
        timer = setTimeout(() => reject(new Error("Concurrent workers did not overlap")), 10000)
      })
      const configured = {
        ...base(dir),
        cases: cases.slice(0, 3),
        models: [hostModel],
        options: { ...base(dir).options, concurrency: 3 },
        completion: async () => {
          active++
          peak = Math.max(peak, active)
          if (active === 3) {
            clearTimeout(timer)
            releaseAll()
          }
          try {
            await allStarted
            return success("allow")
          } finally {
            active--
          }
        },
      }
      try {
        const result = await runBenchmark(configured)
        assert(result.complete)
        assert.equal(peak, 3)
        await assert.rejects(
          runBenchmark({
            ...configured,
            out: join(dir, "rejected"),
            options: { ...configured.options, concurrency: 4 },
          }),
          /at most three workers/,
        )
      } finally {
        clearTimeout(timer)
        delete process.env.PRB_TEST_CONCURRENT_PASSWORD
      }
    }),
)
test("System One runner stores typed inputs, difficulty, and caps workers", async () =>
  temp(async (dir) => {
    process.env.PRB_TEST_SYSTEM_ONE_KEY = "synthetic-test-credential"
    const systemOneModel = {
      id: "jev-private",
      model: "jev-1.13-free",
      endpoint: "https://opencode.ai/zen",
      apiKeyEnv: "PRB_TEST_SYSTEM_ONE_KEY",
      transport: "system-one",
      format: "system_one",
    }
    const adapter = {
      ...fakeAdapter,
      parseSystemOne: () => ({
        decision: decision("escalate"),
        difficultReason: "Synthetic difficult decision.",
        reasoningRecommended: true,
      }),
      prepare: async (input) => {
        const prepared = await fakeAdapter.prepare(input)
        return {
          ...prepared,
          systemOne: {
            state: { trustedPolicy: "TEST ONLY", untrustedEvidence: prepared.evidence },
            questions: { outcome: { type: "choice", criteria: { allow: "yes", deny: "no" } } },
          },
        }
      },
    }
    const run = {
      ...base(dir),
      cases: cases.slice(0, 1),
      models: [systemOneModel],
      adapter,
      options: { ...base(dir).options, concurrency: 2, formatRetries: 0 },
      completion: async () => ({
        ok: true,
        status: 200,
        latencyMs: 1,
        extracted: { systemOne: true },
        raw: { model: "jev-1.13-free", answers: {} },
      }),
    }
    try {
      const result = await runBenchmark(run)
      assert(result.complete)
      const row = (await readJSONL(join(dir, "results.jsonl"))).rows[0]
      assert.equal(row.runMode, "system-one-core-replay")
      assert.equal(row.systemOneDifficulty, "Synthetic difficult decision.")
      assert.equal(row.systemOneReasoningRecommended, true)
      assert.equal(row.prompt.state.trustedPolicy, "TEST ONLY")
      assert(!("system" in row.prompt))
      await assert.rejects(
        runBenchmark({
          ...run,
          out: join(dir, "rejected"),
          options: { ...run.options, concurrency: 3 },
        }),
        /at most two workers/,
      )
    } finally {
      delete process.env.PRB_TEST_SYSTEM_ONE_KEY
    }
  }))
test("invalid System One output stays an invalid row instead of entering the text parser", async () =>
  temp(async (dir) => {
    process.env.PRB_TEST_SYSTEM_ONE_KEY = "synthetic-test-credential"
    const adapter = {
      ...fakeAdapter,
      parseSystemOne: () => undefined,
      prepare: async (input) => ({
        ...(await fakeAdapter.prepare(input)),
        systemOne: { state: {}, questions: {} },
      }),
    }
    try {
      const result = await runBenchmark({
        ...base(dir),
        cases: cases.slice(0, 1),
        models: [
          {
            id: "jev-invalid",
            model: "jev-1.13-free",
            endpoint: "https://opencode.ai/zen",
            apiKeyEnv: "PRB_TEST_SYSTEM_ONE_KEY",
            transport: "system-one",
            format: "system_one",
          },
        ],
        adapter,
        completion: async () => ({
          ok: true,
          status: 200,
          latencyMs: 1,
          extracted: { systemOne: true },
          raw: { model: "jev-1.13-free", answers: {} },
        }),
      })
      assert(result.complete)
      const row = (await readJSONL(join(dir, "results.jsonl"))).rows[0]
      assert.equal(row.status, "invalid")
      assert.equal(row.decision, null)
    } finally {
      delete process.env.PRB_TEST_SYSTEM_ONE_KEY
    }
  }))
test("a random serial delay stays within bounds between provider requests", async () =>
  temp(async (dir) => {
    const started = []
    const result = await runBenchmark({
      ...base(dir),
      options: { ...base(dir).options, minRequestDelayMs: 20, maxRequestDelayMs: 30 },
      completion: async () => {
        started.push(performance.now())
        return success("allow")
      },
    })
    assert(result.complete)
    assert.equal(started.length, 3)
    const waits = (await readJSONL(join(dir, "events.jsonl"))).rows.filter(
      (event) => event.event === "request-wait",
    )
    assert.equal(waits.length, 2)
    assert(waits.every((event) => event.waitMs >= 20 && event.waitMs <= 30))
    assert(started[1] - started[0] >= 19)
    assert(started[2] - started[1] >= 19)
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
