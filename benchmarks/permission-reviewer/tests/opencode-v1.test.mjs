import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { requestOpenCodeV1 } from "../lib/opencode-v1.mjs"
import { validateModel } from "../lib/providers.mjs"
import { decision } from "./helpers.mjs"

const model = {
  id: "grok-low",
  model: "xai/grok-4.6",
  endpoint: "http://127.0.0.1:4096/",
  transport: "opencode-v1",
  hostPasswordEnv: "PRB_TEST_HOST_PASSWORD",
  variant: "low",
  format: "text",
}
process.env.PRB_TEST_HOST_PASSWORD = "synthetic-local-password"

test("OpenCode subscription configuration requires loopback, an explicit variant, and no API key", () => {
  assert.equal(validateModel(model).variant, "low")
  assert.throws(() => validateModel({ ...model, endpoint: "https://api.x.ai/v1" }), /loopback/)
  assert.throws(() => validateModel({ ...model, apiKeyEnv: "XAI_API_KEY" }), /credentials/)
  assert.throws(() => validateModel({ ...model, variant: undefined }), /variant/)
  assert.throws(() => validateModel({ ...model, format: "tool" }), /tool profile/)
  assert.throws(() => validateModel({ ...model, hostPasswordEnv: undefined }), /hostPasswordEnv/)
})

test("OpenCode host receives the exact prompt with low variant and no operational tools", async () => {
  const seen = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null
    seen.push({
      method: request.method,
      url: request.url,
      body,
      authorization: request.headers.authorization,
    })
    response.setHeader("Content-Type", "application/json")
    if (request.method === "POST" && request.url.startsWith("/session?")) {
      response.end(JSON.stringify({ id: "ses_synthetic" }))
    } else if (
      request.method === "POST" &&
      request.url.startsWith("/session/ses_synthetic/message?")
    ) {
      response.end(
        JSON.stringify({
          info: {
            providerID: "xai",
            modelID: "grok-4.6",
            tokens: { input: 60, output: 20, reasoning: 5 },
          },
          parts: [{ type: "text", text: JSON.stringify(decision("deny")) }],
        }),
      )
    } else if (request.method === "DELETE") {
      response.end("true")
    } else {
      response.statusCode = 404
      response.end("{}")
    }
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const result = await requestOpenCodeV1(
      { ...model, endpoint: `http://127.0.0.1:${server.address().port}/` },
      { system: "SYSTEM POLICY", user: "SYNTHETIC EVIDENCE" },
    )
    assert(result.ok)
    assert.equal(result.usage.prompt_tokens, 60)
    assert.equal(JSON.parse(result.extracted.text).outcome, "deny")
    assert.equal(seen.length, 3)
    assert(
      seen.every(
        (request) =>
          request.authorization ===
          `Basic ${Buffer.from("opencode:synthetic-local-password").toString("base64")}`,
      ),
    )
    assert(
      seen.every((request) =>
        new URL(request.url, model.endpoint).searchParams
          .get("directory")
          ?.startsWith("/tmp/prb-opencode-v1-"),
      ),
    )
    assert.equal(seen[1].body.variant, "low")
    assert.deepEqual(seen[1].body.tools, { "*": false })
    assert.equal(seen[1].body.system, "SYSTEM POLICY")
    assert.deepEqual(seen[1].body.parts, [{ type: "text", text: "SYNTHETIC EVIDENCE" }])
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test("OpenCode transport errors request a stop rather than exhausting a subscription", async () => {
  const server = createServer((_request, response) => {
    response.statusCode = 429
    response.end("{}")
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const result = await requestOpenCodeV1(
      { ...model, endpoint: `http://127.0.0.1:${server.address().port}/` },
      { system: "POLICY", user: "SYNTHETIC EVIDENCE" },
    )
    assert(!result.ok)
    assert(result.halt)
    assert.equal(result.status, 429)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
