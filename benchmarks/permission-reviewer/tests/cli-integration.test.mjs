import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { decision } from "./helpers.mjs"

const exec = promisify(execFile)
const benchmark = fileURLToPath(new URL("../", import.meta.url))

test("CLI errors do not echo private argument values", async () => {
  const privateValue = "synthetic-private-value"
  await assert.rejects(
    exec("node", ["cli.mjs", "validate", `--${privateValue}`], { cwd: benchmark }),
    (error) => {
      assert.match(error.stderr, /benchmark command failed/)
      assert(!error.stderr.includes(privateValue))
      return true
    },
  )
})

test("CLI runs real plugin replay through a local HTTP provider and exports safe results", async () => {
  let calls = 0
  const server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    assert.equal(JSON.parse(body).messages.length, 2)
    calls++
    response.setHeader("Content-Type", "application/json")
    response.end(
      JSON.stringify({
        model: "synthetic-provider",
        choices: [
          { finish_reason: "stop", message: { content: JSON.stringify(decision("deny")) } },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
    )
  })
  const scratch = await mkdtemp(join(tmpdir(), "prb-cli-"))
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const models = join(scratch, "models.json")
    const run = join(scratch, "run")
    const report = join(scratch, "public.json")
    await writeFile(
      models,
      JSON.stringify({
        models: [
          {
            id: "synthetic-provider",
            model: "synthetic-provider",
            format: "text",
            endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
          },
        ],
      }),
    )
    await exec(
      "bun",
      [
        "cli.mjs",
        "run",
        "--repo",
        "../..",
        "--models",
        models,
        "--limit",
        "3",
        "--out",
        run,
        "--max-calls",
        "3",
        "--http-retries",
        "0",
        "--format-retries",
        "0",
        "--bootstrap",
        "0",
      ],
      { cwd: benchmark, timeout: 120_000 },
    )
    assert.equal(calls, 3)
    const full = JSON.parse(await readFile(join(run, "results.json"), "utf8"))
    assert.equal(full.results.length, 3)
    assert(full.summary.complete)
    assert(full.run.source.match)
    await exec("node", ["cli.mjs", "export-public", "--run", run, "--out", report], {
      cwd: benchmark,
      timeout: 30_000,
    })
    const published = JSON.parse(await readFile(report, "utf8"))
    assert.equal(published.results.length, 3)
    assert(!JSON.stringify(published).includes("127.0.0.1"))
    assert(!JSON.stringify(published).includes("Test-only output"))
    assert(!("prompt" in published.results[0]))
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await rm(scratch, { recursive: true, force: true })
  }
}, 120_000)
