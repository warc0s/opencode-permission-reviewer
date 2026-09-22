import { open, writeFile, readFile, readdir } from "node:fs/promises"
import { randomInt } from "node:crypto"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  assert,
  atomicJSON,
  delay,
  exists,
  lockDirectory,
  readJSON,
  readJSONL,
  sha256,
  shuffle,
} from "./util.mjs"
import { caseDigest, modelInput } from "./dataset.mjs"
import { requestCompletion, TEXT_RETRY_NOTE, validateModel } from "./providers.mjs"
import { requestOpenCodeV1 } from "./opencode-v1.mjs"
import { requestCommandCodeCli } from "./command-code-cli.mjs"
import { summarize } from "./metrics.mjs"
export const HARNESS_VERSION = "0.1.0"
export function rowBase(c, model, repeat, fingerprint) {
  return {
    schemaVersion: 1,
    runFingerprint: fingerprint,
    caseId: c.id,
    caseHash: caseDigest(c),
    modelId: model.id,
    model: model.model,
    profile: model.format ?? "text",
    family: c.family,
    category: c.category,
    split: c.split,
    origin: c.origin,
    variant: c.variant,
    difficulty: c.difficulty,
    repeat,
    gold: structuredClone(c.gold),
    attack: c.attack,
    metamorphic: c.metamorphic,
    trajectory: c.trajectory,
  }
}
/** A serializing JSONL writer. Each completed HTTP attempt is persisted before parsing/retrying. */
async function writer(path) {
  const file = await open(path, "a", 0o600)
  await file.chmod(0o600)
  let pending = Promise.resolve()
  return {
    write: (value) => {
      pending = pending.then(async () => {
        await file.write(JSON.stringify(value) + "\n")
        await file.sync()
      })
      return pending
    },
    close: async () => {
      await pending
      await file.close()
    },
  }
}
async function recover(path) {
  if (!(await exists(path))) return []
  const read = await readJSONL(path, { recoverTail: true })
  if (read.truncatedBytes) {
    await writeFile(
      path + ".recovered-tail.txt",
      "A final incomplete JSONL record was discarded during explicit resume. Bytes: " +
        read.truncatedBytes +
        "\n",
      { mode: 0o600 },
    )
    await writeFile(path, read.validText, { mode: 0o600 })
  }
  return read.rows
}
function publicModels(models) {
  return models.map(validateModel)
}
async function harnessHash() {
  const root = fileURLToPath(new URL("../", import.meta.url))
  const files = [
    "cli.mjs",
    ...(await readdir(resolve(root, "lib")))
      .filter((x) => x.endsWith(".mjs"))
      .map((x) => "lib/" + x),
  ].sort()
  const hashes = {}
  for (const path of files) hashes[path] = sha256(await readFile(resolve(root, path), "utf8"))
  return sha256(hashes)
}
export async function runBenchmark({
  cases,
  datasetHash,
  models,
  adapter,
  out,
  options = {},
  completion = (model, prepared, request) =>
    model.transport === "opencode-v1"
      ? requestOpenCodeV1(model, prepared, request)
      : model.transport === "command-code-cli"
        ? requestCommandCodeCli(model, prepared, request)
        : requestCompletion(model, prepared, request),
  onProgress = () => {},
}) {
  const cfg = {
    repeats: 1,
    concurrency: 2,
    seed: 17,
    track: "reviewer",
    timeoutMs: 120000,
    maxCalls: 1200,
    minRequestDelayMs: 0,
    maxRequestDelayMs: 0,
    httpRetries: 1,
    formatRetries: 1,
    bootstrap: 500,
    storePrompts: true,
    resume: false,
    ...options,
  }
  assert(["reviewer", "system"].includes(cfg.track), "track must be reviewer or system")
  assert(Number.isInteger(cfg.repeats) && cfg.repeats > 0, "repeats")
  assert(Number.isInteger(cfg.concurrency) && cfg.concurrency > 0, "concurrency")
  assert(Number.isInteger(cfg.minRequestDelayMs) && cfg.minRequestDelayMs >= 0, "minRequestDelayMs")
  assert(
    Number.isInteger(cfg.maxRequestDelayMs) &&
      cfg.maxRequestDelayMs >= cfg.minRequestDelayMs &&
      cfg.maxRequestDelayMs <= 60000,
    "maxRequestDelayMs",
  )
  if (cfg.maxRequestDelayMs > 0)
    assert(cfg.concurrency === 1, "A request delay requires --concurrency 1.")
  const safeModels = publicModels(models)
  assert(new Set(safeModels.map((m) => m.id)).size === safeModels.length, "Duplicate model id.")
  assert(safeModels.length > 0, "No models configured.")
  if (safeModels.some((model) => model.transport === "opencode-v1"))
    assert(cfg.concurrency <= 3, "OpenCode subscription runs permit at most three workers.")
  if (safeModels.some((model) => model.transport === "command-code-cli"))
    assert(cfg.concurrency <= 2, "Command Code subscription runs permit at most two workers.")
  for (const m of safeModels)
    if (m.apiKeyEnv)
      assert(process.env[m.apiKeyEnv], `Missing credential environment variable ${m.apiKeyEnv}`)
  for (const m of safeModels)
    if (m.hostPasswordEnv)
      assert(
        process.env[m.hostPasswordEnv],
        `Missing host password environment variable ${m.hostPasswordEnv}`,
      )
  for (const m of safeModels)
    if (m.commandCodeBinEnv)
      assert(
        process.env[m.commandCodeBinEnv],
        `Missing Command Code binary environment variable ${m.commandCodeBinEnv}`,
      )
  const resume = cfg.resume
  const semanticConfig = { ...cfg }
  delete semanticConfig.resume
  delete semanticConfig.bootstrap
  const manifest = {
    schemaVersion: 1,
    harnessVersion: HARNESS_VERSION,
    harnessSha256: await harnessHash(),
    environment: {
      node: process.version,
      bun: process.versions.bun ?? null,
      platform: process.platform,
      arch: process.arch,
    },
    source: adapter.snapshot,
    promptVersion: adapter.promptVersion,
    datasetHash,
    caseIds: cases.map((c) => c.id),
    caseHashes: cases.map(caseDigest),
    models: safeModels,
    options: semanticConfig,
    protocol: safeModels.some((model) => model.transport === "command-code-cli")
      ? "Command Code CLI headless transport with role-folded user prompt + actual plugin evidence/parser/core replay; NOT controlled with OpenCode V1 or permission lifecycle E2E"
      : safeModels.some((model) => model.transport === "opencode-v1")
        ? "OpenCode V1 session transport + actual plugin evidence/prompt/parser/core replay; NOT permission lifecycle E2E"
        : "direct-chat-completions + actual plugin evidence/prompt/parser/core replay; NOT native OpenCode host E2E",
  }
  const fingerprint = sha256(manifest),
    directory = resolve(out)
  const unlock = await lockDirectory(directory)
  let rowsWriter, attemptWriter, eventWriter
  const abort = new AbortController()
  const interrupt = () => abort.abort(new Error("Interrupted by user"))
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", interrupt)
  try {
    const manifestPath = resolve(directory, "run.json"),
      rowsPath = resolve(directory, "results.jsonl"),
      attemptPath = resolve(directory, "attempts.jsonl")
    if (await exists(manifestPath)) {
      assert(
        resume,
        "Output directory already contains a run. Use a new directory or explicit --resume.",
      )
      const prior = await readJSON(manifestPath)
      assert(
        prior.fingerprint === fingerprint,
        "Resume fingerprint mismatch: dataset, labels, sources, profiles or settings changed.",
      )
    } else {
      assert(!resume, "Cannot resume: run.json is absent.")
      assert(
        !(await exists(rowsPath)) && !(await exists(attemptPath)),
        "Orphan result files exist; use another output directory.",
      )
      await atomicJSON(manifestPath, {
        ...manifest,
        fingerprint,
        createdAt: new Date().toISOString(),
      })
    }
    let rows = resume ? await recover(rowsPath) : []
    const journal = resume ? await recover(attemptPath) : []
    const previousEvents = resume ? await recover(resolve(directory, "events.jsonl")) : []
    const startedCalls = previousEvents.filter((e) => e.event === "http-start")
    const completed = new Set()
    for (const r of rows) {
      assert(r.runFingerprint === fingerprint, "Unexpected row fingerprint.")
      const key = `${r.modelId}/${r.caseId}/${r.repeat}`
      assert(!completed.has(key), "Duplicate completed result: " + key)
      completed.add(key)
    }
    rowsWriter = await writer(rowsPath)
    attemptWriter = await writer(attemptPath)
    eventWriter = await writer(resolve(directory, "events.jsonl"))
    let calls = startedCalls.length,
      issuedCalls = 0,
      finished = rows.length
    assert(calls >= journal.length, "Attempt journal is inconsistent with started HTTP calls.")
    const journalByKey = new Map()
    for (const a of journal) {
      assert(a.runFingerprint === fingerprint, "Unexpected attempt fingerprint.")
      if (!journalByKey.has(a.key)) journalByKey.set(a.key, [])
      journalByKey.get(a.key).push(a)
    }
    // A crash after sending a request but before journaling its response has
    // uncertain billing. Count it and fail that request without blind retry.
    for (const e of startedCalls) {
      const saved = journalByKey.get(e.key) ?? []
      if (!saved.some((a) => a.ordinal === e.ordinal)) {
        const recovered = {
          schemaVersion: 1,
          runFingerprint: fingerprint,
          key: e.key,
          ordinal: e.ordinal,
          at: new Date().toISOString(),
          attempt: {
            ok: false,
            status: null,
            error:
              "Response lost after an in-flight HTTP request; billing/outcome unknown. Not automatically retried.",
            uncertainInFlight: true,
            latencyMs: 0,
          },
        }
        saved.push(recovered)
        saved.sort((a, b) => a.ordinal - b.ordinal)
        journalByKey.set(e.key, saved)
        await attemptWriter.write(recovered)
      }
    }
    const jobs = []
    for (let rep = 0; rep < cfg.repeats; rep++)
      for (const c of cases)
        for (const m of safeModels) jobs.push({ c, m, rep, key: `${m.id}/${c.id}/${rep}` })
    const queue = shuffle(jobs, cfg.seed).filter((j) => !completed.has(j.key))
    let cursor = 0
    await eventWriter.write({
      event: "run-start",
      fingerprint,
      at: new Date().toISOString(),
      resume,
      remaining: queue.length,
      previousHTTPAttempts: calls,
    })
    async function execute(job) {
      const { c, m, rep, key } = job,
        start = performance.now()
      const p = await adapter.prepare(modelInput(c), m)
      const base = {
        ...rowBase(c, m, rep, fingerprint),
        runMode:
          m.transport === "opencode-v1"
            ? "opencode-v1-session-core-replay"
            : "live-provider-core-replay",
        pluginSourceSha256: adapter.snapshot.sourceSha256,
        reachable: p.reachable,
        promptHash: p.promptHash,
        evidenceHash: p.evidenceHash,
        actionEvidenceComplete: p.actionEvidenceComplete,
      }
      if (cfg.storePrompts) base.prompt = { system: p.system, user: p.user }
      base.evidence = p.evidence
      let attempts = [],
        parsed = null,
        firstDecision = null,
        status,
        errorKind = "invalid",
        transportRetries = 0,
        parseRetries = 0,
        retryNote
      if (!p.reachable && cfg.track === "system") {
        return {
          ...base,
          status: "bypass",
          attempts,
          decision: null,
          firstDecision: null,
          gated: null,
          effective: p.bypass,
          elapsedMs: performance.now() - start,
        }
      }
      const saved = journalByKey.get(key) ?? []
      let savedIndex = 0
      while (true) {
        if (abort.signal.aborted) {
          status = "interrupted"
          errorKind = "transport"
          break
        }
        let a
        if (savedIndex < saved.length) {
          a = saved[savedIndex++].attempt
        } else {
          if (calls >= cfg.maxCalls) {
            status = "budget-exhausted"
            errorKind = "transport"
            break
          }
          if (issuedCalls > 0 && cfg.maxRequestDelayMs > 0) {
            const waitMs = randomInt(cfg.minRequestDelayMs, cfg.maxRequestDelayMs + 1)
            await eventWriter.write({
              event: "request-wait",
              key,
              waitMs,
              at: new Date().toISOString(),
            })
            await delay(waitMs)
          }
          if (abort.signal.aborted) {
            status = "interrupted"
            errorKind = "transport"
            break
          }
          calls++
          issuedCalls++
          await eventWriter.write({
            event: "http-start",
            key,
            ordinal: attempts.length + 1,
            at: new Date().toISOString(),
          })
          a = await completion(m, p, { timeoutMs: cfg.timeoutMs, retryNote, signal: abort.signal })
          await attemptWriter.write({
            schemaVersion: 1,
            runFingerprint: fingerprint,
            key,
            ordinal: attempts.length + 1,
            at: new Date().toISOString(),
            attempt: a,
          })
        }
        attempts.push(a)
        if (a.halt) {
          abort.abort(new Error("Transport requested a safety stop."))
          errorKind = "transport"
          status = "transport-error"
          break
        }
        if (!a.ok) {
          errorKind = "transport"
          status = "transport-error"
          const retryable =
            !a.uncertainInFlight &&
            (a.status === null ||
              a.status === undefined ||
              a.status === 408 ||
              a.status === 429 ||
              a.status >= 500)
          if (retryable && transportRetries < cfg.httpRetries) {
            transportRetries++
            if (savedIndex >= saved.length)
              await delay(Math.min(500 * 2 ** (transportRetries - 1), 4000))
            continue
          }
          break
        }
        const extracted = a.extracted ?? { text: "", protocolError: "No extracted output." }
        const d = extracted.protocolError ? null : (adapter.parse(extracted.text) ?? null)
        if (attempts.length === 1) firstDecision = d
        if (d) {
          parsed = d
          status = "valid"
          break
        }
        errorKind = "invalid"
        status = "invalid"
        if (parseRetries < cfg.formatRetries) {
          parseRetries++
          retryNote = TEXT_RETRY_NOTE
          continue
        }
        break
      }
      const final = await adapter.finish(p, parsed, errorKind)
      return {
        ...base,
        status,
        attempts,
        decision: parsed,
        firstDecision,
        exposedRationale: parsed?.rationale ?? null,
        ...final,
        elapsedMs: performance.now() - start,
      }
    }
    async function worker() {
      while (cursor < queue.length && !abort.signal.aborted) {
        const job = queue[cursor++]
        // Preparation/programming errors stop the run. Do not disguise harness defects as model failures.
        let row
        try {
          row = await execute(job)
        } catch (error) {
          abort.abort(error)
          throw error
        }
        await rowsWriter.write(row)
        rows.push(row)
        finished++
        onProgress({ finished, total: jobs.length, calls, last: job.key, status: row.status })
      }
    }
    const settled = await Promise.allSettled(
      Array.from({ length: Math.min(cfg.concurrency, queue.length) }, worker),
    )
    const failures = settled.filter((x) => x.status === "rejected")
    const summary = summarize(rows, { bootstrap: cfg.bootstrap, seed: cfg.seed })
    const complete =
      rows.length === jobs.length &&
      !rows.some((r) => ["budget-exhausted", "interrupted"].includes(r.status))
    Object.assign(summary, {
      runFingerprint: fingerprint,
      complete,
      expectedRows: jobs.length,
      completedRows: rows.length,
      httpAttemptsTotal: calls,
      interrupted: abort.signal.aborted,
      harnessErrors: failures.map((x) => String(x.reason?.message ?? x.reason)),
      source: adapter.snapshot,
      modelsConfig: safeModels,
    })
    for (const [id, s] of Object.entries(summary.models)) {
      const prices = safeModels.find((m) => m.id === id)?.pricesPerMillion,
        u = s.operational.usage
      s.operational.estimatedCost =
        prices && u.complete && Number.isFinite(prices.input) && Number.isFinite(prices.output)
          ? {
              amount: (u.inputTokens * prices.input + u.outputTokens * prices.output) / 1e6,
              currency: "USD",
              basis:
                "Configured uncached input/output rates, ignoring cache/reasoning/provider-specific price tiers.",
            }
          : null
    }
    await atomicJSON(resolve(directory, "summary.json"), summary)
    // Self-contained analysis document, including rows, returned rationales and all attempt logs.
    await atomicJSON(resolve(directory, "results.json"), {
      run: { ...manifest, fingerprint },
      summary,
      results: rows,
    })
    await eventWriter.write({
      event: "run-end",
      complete,
      at: new Date().toISOString(),
      completed: rows.length,
      expected: jobs.length,
    })
    if (failures.length)
      throw new Error(
        "Harness failure: " +
          summary.harnessErrors.join("; ") +
          ". Completed records are preserved.",
      )
    return summary
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", interrupt)
    await rowsWriter?.close()
    await attemptWriter?.close()
    await eventWriter?.close()
    await unlock()
  }
}
