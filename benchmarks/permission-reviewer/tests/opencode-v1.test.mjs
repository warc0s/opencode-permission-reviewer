import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { requestOpenCodeV1 } from "../lib/opencode-v1.mjs"
import { validateModel } from "../lib/providers.mjs"
import { decision } from "./helpers.mjs"
import { tmpdir } from "node:os"

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
    } else if (request.method === "POST" && request.url.startsWith("/instance/dispose?")) {
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
    assert.equal(seen.length, 4)
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
          ?.startsWith(`${tmpdir()}/prb-opencode-v1-`),
      ),
    )
    assert.equal(seen[1].body.variant, "low")
    assert.deepEqual(seen[1].body.tools, { "*": false })
    assert.equal(seen[1].body.system, "SYSTEM POLICY")
    assert.deepEqual(seen[1].body.parts, [{ type: "text", text: "SYNTHETIC EVIDENCE" }])
    assert.equal(seen[2].method, "DELETE")
    assert(seen[2].url.startsWith("/session/ses_synthetic?"))
    assert.equal(seen[3].method, "POST")
    assert(seen[3].url.startsWith("/instance/dispose?"))
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test("OpenCode transport errors request a stop rather than exhausting a subscription", async () => {
  const seen = []
  const server = createServer((request, response) => {
    seen.push({ method: request.method, url: request.url })
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
    assert.equal(seen.length, 4)
    assert.equal(seen[0].method, "POST")
    assert(seen[0].url.startsWith("/session?"))
    assert(
      seen
        .slice(1)
        .every(
          (request) => request.method === "POST" && request.url.startsWith("/instance/dispose?"),
        ),
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test("OpenCode instance disposal still runs when session deletion fails", async () => {
  const seen = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    seen.push({ method: request.method, url: request.url })
    response.setHeader("Content-Type", "application/json")
    if (request.method === "POST" && request.url.startsWith("/session?")) {
      response.end(JSON.stringify({ id: "ses_cleanup" }))
    } else if (
      request.method === "POST" &&
      request.url.startsWith("/session/ses_cleanup/message?")
    ) {
      response.end(
        JSON.stringify({
          info: {
            providerID: "xai",
            modelID: "grok-4.6",
            tokens: { input: 1, output: 1, reasoning: 0 },
          },
          parts: [{ type: "text", text: JSON.stringify(decision("allow")) }],
        }),
      )
    } else if (request.method === "DELETE") {
      response.statusCode = 500
      response.end("{}")
    } else if (request.method === "POST" && request.url.startsWith("/instance/dispose?")) {
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
      { system: "POLICY", user: "SYNTHETIC EVIDENCE" },
    )
    assert(result.ok)
    assert.equal(seen.length, 4)
    assert.equal(seen[2].method, "DELETE")
    assert.equal(seen[3].method, "POST")
    assert(seen[3].url.startsWith("/instance/dispose?"))
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test("OpenCode instance disposal failure requests a global safety stop", async () => {
  const seen = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    seen.push({ method: request.method, url: request.url })
    response.setHeader("Content-Type", "application/json")
    if (request.method === "POST" && request.url.startsWith("/session?")) {
      response.end(JSON.stringify({ id: "ses_disposal_failure" }))
    } else if (
      request.method === "POST" &&
      request.url.startsWith("/session/ses_disposal_failure/message?")
    ) {
      response.end(
        JSON.stringify({
          info: {
            providerID: "xai",
            modelID: "grok-4.6",
            tokens: { input: 1, output: 1, reasoning: 0 },
          },
          parts: [{ type: "text", text: JSON.stringify(decision("allow")) }],
        }),
      )
    } else if (request.method === "DELETE") {
      response.end("true")
    } else if (request.method === "POST" && request.url.startsWith("/instance/dispose?")) {
      response.statusCode = 500
      response.end("{}")
    } else {
      response.statusCode = 404
      response.end("{}")
    }
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const result = await requestOpenCodeV1(
      { ...model, endpoint: `http://127.0.0.1:${server.address().port}/` },
      { system: "POLICY", user: "SYNTHETIC EVIDENCE" },
    )
    assert(!result.ok)
    assert(result.halt)
    assert.equal(result.status, 500)
    assert.match(result.error, /instance cleanup failed after 3 attempts/)
    assert.equal(seen.length, 6)
    assert(
      seen
        .slice(3)
        .every(
          (request) => request.method === "POST" && request.url.startsWith("/instance/dispose?"),
        ),
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test("OpenCode instance disposal retries transient failures without stopping the run", async () => {
  const seen = []
  let disposalAttempts = 0
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    seen.push({ method: request.method, url: request.url })
    response.setHeader("Content-Type", "application/json")
    if (request.method === "POST" && request.url.startsWith("/session?")) {
      response.end(JSON.stringify({ id: "ses_disposal_retry" }))
    } else if (
      request.method === "POST" &&
      request.url.startsWith("/session/ses_disposal_retry/message?")
    ) {
      response.end(
        JSON.stringify({
          info: {
            providerID: "xai",
            modelID: "grok-4.6",
            tokens: { input: 1, output: 1, reasoning: 0 },
          },
          parts: [{ type: "text", text: JSON.stringify(decision("allow")) }],
        }),
      )
    } else if (request.method === "DELETE") {
      response.end("true")
    } else if (request.method === "POST" && request.url.startsWith("/instance/dispose?")) {
      disposalAttempts++
      if (disposalAttempts < 3) {
        response.statusCode = 503
        response.end("{}")
      } else response.end("true")
    } else {
      response.statusCode = 404
      response.end("{}")
    }
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const result = await requestOpenCodeV1(
      { ...model, endpoint: `http://127.0.0.1:${server.address().port}/` },
      { system: "POLICY", user: "SYNTHETIC EVIDENCE" },
    )
    assert(result.ok)
    assert.equal(disposalAttempts, 3)
    assert.equal(seen.length, 6)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
