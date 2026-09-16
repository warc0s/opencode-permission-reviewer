/** Manual host smoke: real OpenCode V1, synthetic local model, no subscription usage. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { requestOpenCodeV1 } from "../lib/opencode-v1.mjs"

const binary = process.env.OPENCODE_V1_BIN
assert(binary, "Set OPENCODE_V1_BIN to an installed OpenCode V1 executable.")
const hostPassword = "synthetic-local-password"
process.env.PRB_TEST_HOST_PASSWORD = hostPassword
const root = await mkdtemp(join(tmpdir(), "prb-live-host-"))
const providerCalls = []
const provider = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  providerCalls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
  const decision = {
    version: 2,
    outcome: "deny",
    risk_level: "high",
    user_authorization: "low",
    scope_alignment: "misaligned",
    evidence_completeness: "sufficient",
    rationale: "Synthetic provider response for the real-host transport smoke.",
    confidence: 0.95,
  }
  const event = (delta, finish_reason) =>
    JSON.stringify({
      id: "synthetic-completion",
      object: "chat.completion.chunk",
      created: 1,
      model: "reviewer",
      choices: [{ index: 0, delta, finish_reason }],
    })
  response.writeHead(200, { "Content-Type": "text/event-stream" })
  response.end(
    `data: ${event({ content: JSON.stringify(decision) }, null)}\n\ndata: ${event({}, "stop")}\n\ndata: [DONE]\n\n`,
  )
})
let host
try {
  await mkdir(join(root, "config", "opencode"), { recursive: true })
  await mkdir(join(root, "workspace"))
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve))
  const configPath = join(root, "config", "opencode", "opencode.json")
  await writeFile(
    configPath,
    JSON.stringify({
      provider: {
        synthetic: {
          npm: "@ai-sdk/openai-compatible",
          name: "Synthetic provider",
          options: {
            baseURL: `http://127.0.0.1:${provider.address().port}/v1`,
            apiKey: "synthetic",
          },
          models: {
            reviewer: {
              name: "reviewer",
              limit: { context: 100000, output: 4096 },
              variants: { low: {} },
            },
          },
        },
      },
      model: "synthetic/reviewer",
      small_model: "synthetic/reviewer",
      permission: "deny",
    }),
  )
  const reservation = createServer()
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve))
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  const env = {
    ...process.env,
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    OPENCODE_CONFIG: configPath,
    OPENCODE_CONFIG_CONTENT: "{}",
    OPENCODE_SERVER_PASSWORD: hostPassword,
  }
  delete env.OPENCODE_CONFIG_DIR
  host = spawn(binary, ["serve", "--pure", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: join(root, "workspace"),
    env,
    stdio: "ignore",
  })
  const baseUrl = `http://127.0.0.1:${port}/`
  let ready = false
  for (let attempt = 0; attempt < 300; attempt++) {
    ready = await fetch(new URL("/global/health", baseUrl), {
      headers: {
        Authorization: `Basic ${Buffer.from(`opencode:${hostPassword}`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(500),
    })
      .then((response) => response.ok)
      .catch(() => false)
    if (ready) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert(ready, "Isolated OpenCode V1 host did not start.")
  const response = await requestOpenCodeV1(
    {
      id: "synthetic-low",
      model: "synthetic/reviewer",
      endpoint: baseUrl,
      transport: "opencode-v1",
      hostPasswordEnv: "PRB_TEST_HOST_PASSWORD",
      variant: "low",
      format: "text",
    },
    { system: "SYSTEM TEST", user: "BENCHMARK EVIDENCE" },
    { timeoutMs: 45000 },
  )
  assert(response.ok, response.error)
  assert.equal(JSON.parse(response.extracted.text).outcome, "deny")
  assert.equal(providerCalls.length, 1)
  const request = JSON.stringify(providerCalls[0])
  assert(request.includes("SYSTEM TEST"))
  assert(request.includes("BENCHMARK EVIDENCE"))
  assert(!request.includes("gold-oracle"))
  console.log(
    JSON.stringify({
      pass: true,
      host: "opencode-v1",
      variant: "low",
      providerCalls: providerCalls.length,
      operationalTools: providerCalls[0].tools?.length ?? 0,
    }),
  )
} finally {
  if (host && host.exitCode === null) {
    host.kill()
    await new Promise((resolve) => host.once("exit", resolve))
  }
  if (provider.listening) await new Promise((resolve) => provider.close(resolve))
  await rm(root, { recursive: true })
}
