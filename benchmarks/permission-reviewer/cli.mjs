#!/usr/bin/env bun
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { writeFile } from "node:fs/promises"
import {
  assert,
  atomicJSON,
  exists,
  numberArg,
  privateDir,
  readJSON,
  readJSONL,
} from "./lib/util.mjs"
import { loadDataset, modelInput, selectCases } from "./lib/dataset.mjs"
import { openPlugin } from "./lib/plugin.mjs"
import { validateModel } from "./lib/providers.mjs"
import { runBenchmark, rowBase } from "./lib/run.mjs"
import { compareRows, printSummary, summarize } from "./lib/metrics.mjs"
import { exportReview } from "./lib/audit.mjs"
import { publicReport } from "./lib/publication.mjs"
const ROOT = dirname(fileURLToPath(import.meta.url))
const BOOLS = new Set([
  "resume",
  "allow-drift",
  "all",
  "no-prompts",
  "oracle",
  "allow-profile-diff",
])
const VALUES = new Set([
  "data",
  "repo",
  "models",
  "out",
  "run",
  "left",
  "right",
  "left-model",
  "right-model",
  "layer",
  "split",
  "category",
  "id",
  "limit",
  "repeats",
  "concurrency",
  "seed",
  "max-calls",
  "min-request-delay-ms",
  "max-request-delay-ms",
  "timeout-ms",
  "http-retries",
  "format-retries",
  "bootstrap",
  "sample",
  "track",
])
function args(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    assert(key.startsWith("--"), "Unexpected argument " + key)
    const name = key.slice(2)
    assert(BOOLS.has(name) || VALUES.has(name), "Unknown option " + key)
    assert(out[name] === undefined, "Duplicate option " + key)
    if (BOOLS.has(name)) out[name] = true
    else {
      assert(argv[i + 1] !== undefined && !argv[i + 1].startsWith("--"), "Missing value for " + key)
      out[name] = argv[++i]
    }
  }
  return out
}
async function rowsAt(path) {
  assert(path, "Specify the run path.")
  const resolved = resolve(path)
  if (path.endsWith(".jsonl")) return (await readJSONL(resolved)).rows
  if (path.endsWith(".json")) {
    const x = await readJSON(resolved)
    return x.results ?? x
  }
  return (await readJSONL(resolve(resolved, "results.jsonl"))).rows
}
async function main() {
  const command = process.argv[2] ?? "help"
  if (["help", "--help", "-h"].includes(command)) {
    console.log(
      `PRB-600: permission model benchmark, audited source/core replay.\n\nCommands:\n  node cli.mjs validate\n  node cli.mjs baseline --out runs/smoke [--oracle]\n  bun cli.mjs render --repo /path/plugin --models models.local.json --out runs/render\n  bun cli.mjs run --repo /path/plugin --models models.local.json --out runs/comparison\n  node cli.mjs score --run runs/comparison\n  node cli.mjs audit --run runs/comparison --out reviews/manual.jsonl\n  node cli.mjs compare --left RUN --left-model ID --right RUN --right-model ID\n  node cli.mjs export-public --run runs/comparison --out reviews/public.json\n\nrun: --split all|dev|validation|holdout, --category NAME, --id ID, --limit N,\n     --repeats 1, --concurrency 2, --seed 17, --max-calls 1200,\n     --min-request-delay-ms 0, --max-request-delay-ms 0,\n     --timeout-ms 120000, --http-retries 1, --format-retries 1,\n     --track reviewer|system, --bootstrap 500, --resume, --allow-drift\nAll fixture commands are inert data. Requests go only to configured provider or local OpenCode host URLs.\nLive evaluation requires Bun and the plugin checkout.\nbaseline is a metric-only test, NOT model performance or host integration.\n`,
    )
    return
  }
  const a = args(process.argv.slice(3)),
    seed = numberArg(a.seed, 17, 0, 2147483647, "seed"),
    bootstrap = numberArg(a.bootstrap, 500, 0, 10000, "bootstrap")
  if (["score", "audit", "compare", "export-public"].includes(command)) {
    if (command === "export-public") {
      assert(a.run && a.out, "Specify --run RUN and --out FILE.")
      assert(!(await exists(resolve(a.out))), "Public export already exists; choose a new path.")
      const report = publicReport(await readJSON(resolve(a.run, "results.json")))
      await atomicJSON(resolve(a.out), report)
      console.log(
        `Synthetic public report: ${resolve(a.out)} (${report.results.length} cases). Review it before publication.`,
      )
      return
    }
    if (command === "score") {
      const rows = await rowsAt(a.run),
        s = summarize(rows, { bootstrap, seed })
      printSummary(s)
      if (a.out) await atomicJSON(resolve(a.out), s)
      return
    }
    if (command === "audit") {
      assert(a.out, "Specify --out reviews/file.jsonl")
      console.log(
        await exportReview(await rowsAt(a.run), resolve(a.out), {
          sample: numberArg(a.sample, 30, 0, 100000, "sample"),
          seed,
          all: !!a.all,
        }),
      )
      return
    }
    let left = await rowsAt(a.left),
      right = await rowsAt(a.right)
    if (a["left-model"]) left = left.filter((r) => r.modelId === a["left-model"])
    if (a["right-model"]) right = right.filter((r) => r.modelId === a["right-model"])
    assert(left.length && right.length, "Selected model has no rows.")
    const incompatible =
      new Set(left.map((r) => r.profile)).size !== 1 ||
      new Set(right.map((r) => r.profile)).size !== 1 ||
      left[0].profile !== right[0].profile ||
      left[0].pluginSourceSha256 !== right[0].pluginSourceSha256 ||
      left[0].runMode !== right[0].runMode
    assert(
      !incompatible || a["allow-profile-diff"],
      "Profiles, source or run modes differ. Explicit --allow-profile-diff is needed for a descriptive, not controlled, comparison.",
    )
    const result = {
      ...compareRows(left, right, {
        layer: a.layer ?? "model",
        iterations: bootstrap || 500,
        seed,
      }),
      controlledProfileComparison: !incompatible,
    }
    console.log(JSON.stringify(result, null, 2))
    if (a.out) await atomicJSON(resolve(a.out), result)
    return
  }
  const data = await loadDataset(resolve(a.data ?? resolve(ROOT, "data/cases.jsonl")))
  const limit =
    a.limit === undefined ? undefined : numberArg(a.limit, 1, 1, data.cases.length, "limit")
  const cases = selectCases(data.cases, {
    split: a.split ?? "all",
    category: a.category,
    id: a.id,
    limit,
  })
  if (command === "validate") {
    const manifest = await readJSON(resolve(ROOT, "data/manifest.json"))
    if (!a.data)
      assert(
        manifest.sha256 === data.hash,
        "Materialized corpus digest differs from manifest; rebuild and review changes.",
      )
    console.log(
      JSON.stringify(
        {
          ...data.validation,
          selected: cases.length,
          sha256: data.hash,
          source: "synthetic, labels pending independent adjudication",
          fixtureExecution: false,
        },
        null,
        2,
      ),
    )
    return
  }
  if (command === "baseline") {
    assert(a.out, "Specify --out runs/smoke")
    assert(!(await exists(resolve(a.out, "results.jsonl"))), "Baseline output already exists.")
    const choices = [
        "always-allow",
        "always-deny",
        "always-escalate",
        ...(a.oracle ? ["gold-oracle-SELF-TEST"] : []),
      ],
      rows = []
    for (const id of choices)
      for (const c of cases) {
        const label = id.startsWith("gold-oracle") ? c.gold.outcome : id.replace("always-", "")
        const decision = {
          version: 2,
          outcome: label,
          risk_level: "low",
          user_authorization: "high",
          scope_alignment: "aligned",
          evidence_completeness: "sufficient",
          rationale: "Synthetic metric self-test, NOT a real model response.",
          confidence: 1,
        }
        rows.push({
          ...rowBase(
            c,
            { id, model: "NO_MODEL_CALLS", format: "metric-only" },
            0,
            "offline-" + data.hash,
          ),
          runMode: "metric-only-baseline",
          status: "valid",
          reachable: true,
          decision,
          firstDecision: decision,
          effective: {
            kind: label,
            reason: "Synthetic identity mapping; production gates NOT applied.",
          },
          attempts: [],
          evidence: "No prompt was sent. This is a scoring self-test only.",
        })
      }
    await privateDir(resolve(a.out))
    await writeFile(
      resolve(a.out, "results.jsonl"),
      rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      { mode: 0o600 },
    )
    const summary = summarize(rows, { bootstrap, seed })
    summary.liveModelCalls = 0
    summary.warning =
      "SYNTHETIC BASELINES ONLY. Gold oracle deliberately reads labels to self-test the metric. Never a model ranking."
    await atomicJSON(resolve(a.out, "summary.json"), summary)
    printSummary(summary)
    return
  }
  assert(["run", "render", "parity"].includes(command), "Unknown command: " + command)
  const adapter = await openPlugin(a.repo, { allowDrift: !!a["allow-drift"] })
  if (command === "parity") {
    console.log(JSON.stringify(adapter.snapshot, null, 2))
    return
  }
  assert(a.models, "Specify --models examples/models.local.example.json (copy and edit first).")
  const config = await readJSON(resolve(a.models))
  const models = (Array.isArray(config) ? config : config.models).map(validateModel)
  assert(a.out, "Specify a new output directory via --out.")
  if (command === "render") {
    assert(!(await exists(resolve(a.out, "requests.jsonl"))), "Render file already exists.")
    await privateDir(resolve(a.out))
    const lines = []
    for (const c of cases)
      for (const model of models) {
        const p = await adapter.prepare(modelInput(c), model)
        lines.push(
          JSON.stringify({
            caseId: c.id,
            modelId: model.id,
            reachable: p.reachable,
            promptHash: p.promptHash,
            evidenceHash: p.evidenceHash,
            actionEvidenceComplete: p.actionEvidenceComplete,
            system: p.system,
            user: p.user,
            schema: p.schema,
          }),
        )
      }
    await writeFile(resolve(a.out, "requests.jsonl"), lines.join("\n") + "\n", { mode: 0o600 })
    await atomicJSON(resolve(a.out, "render-manifest.json"), {
      cases: cases.length,
      models: models.length,
      source: adapter.snapshot,
      datasetHash: data.hash,
      promptVersion: adapter.promptVersion,
    })
    console.log(
      `${lines.length} rendered requests; ZERO network calls and ZERO fixture executions.`,
    )
    return
  }
  const repeats = numberArg(a.repeats, 1, 1, 100, "repeats"),
    total = cases.length * models.length * repeats
  const options = {
    repeats,
    concurrency: numberArg(a.concurrency, 2, 1, 32, "concurrency"),
    seed,
    track: a.track ?? "reviewer",
    maxCalls: numberArg(a["max-calls"], 1200, 1, 1000000, "max-calls"),
    minRequestDelayMs: numberArg(a["min-request-delay-ms"], 0, 0, 60000, "min-request-delay-ms"),
    maxRequestDelayMs: numberArg(a["max-request-delay-ms"], 0, 0, 60000, "max-request-delay-ms"),
    timeoutMs: numberArg(a["timeout-ms"], 120000, 100, 1800000, "timeout-ms"),
    httpRetries: numberArg(a["http-retries"], 1, 0, 3, "http-retries"),
    formatRetries: numberArg(a["format-retries"], 1, 0, 2, "format-retries"),
    bootstrap,
    resume: !!a.resume,
    storePrompts: !a["no-prompts"],
  }
  console.log(
    `${cases.length} cases x ${models.length} models x ${repeats} repetitions = ${total} decisions before retries; transport request cap ${options.maxCalls}.`,
  )
  let last = 0
  const summary = await runBenchmark({
    cases,
    datasetHash: data.hash,
    models,
    adapter,
    out: a.out,
    options,
    onProgress: (p) => {
      if (p.finished === p.total || Date.now() - last > 3000) {
        console.log(`${p.finished}/${p.total}, requests ${p.calls}, ${p.status}`)
        last = Date.now()
      }
    },
  })
  printSummary(summary)
  console.log(`Full results: ${resolve(a.out, "results.json")}`)
  if (!summary.complete) {
    console.error("Run incomplete: inspect budget, interruption and harness status.")
    process.exitCode = 2
  }
}
main().catch((error) => {
  console.error("ERROR:", error.message)
  process.exitCode = 1
})
