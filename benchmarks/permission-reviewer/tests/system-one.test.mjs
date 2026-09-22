import test from "node:test"
import assert from "node:assert/strict"
import { requestSystemOne } from "../lib/system-one.mjs"

const model = {
  model: "jev-1.13-free",
  endpoint: "https://opencode.ai/zen",
  apiKeyEnv: "PRB_SYSTEM_ONE_TEST_KEY",
}

test("System One transport sends only typed state and questions", async () => {
  process.env.PRB_SYSTEM_ONE_TEST_KEY = "synthetic-test-credential"
  let request
  try {
    const result = await requestSystemOne(
      model,
      {
        systemOne: {
          state: {
            trustedPolicy: { reviewer: "policy", tenant: "tenant" },
            untrustedEvidence: "evidence",
          },
          questions: {
            outcome: {
              type: "choice",
              instructions: "Decide",
              criteria: { allow: "allow", deny: "deny" },
            },
          },
        },
      },
      {
        fetchImpl: async (url, options) => {
          request = { url: String(url), options, body: JSON.parse(String(options.body)) }
          return new Response(
            JSON.stringify({
              model: "jev-1.13-free",
              answers: {
                outcome: {
                  type: "choice",
                  choice: "deny",
                  confidence: 0.9,
                  probabilities: { allow: 0.1, deny: 0.9 },
                },
              },
              usage: { input_tokens: 12, output_tokens: 4 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        },
      },
    )
    assert(result.ok)
    assert.equal(request.url, "https://opencode.ai/zen/v1/systemone")
    assert.equal(request.body.model, "jev-1.13-free")
    assert.deepEqual(request.body.state, {
      trustedPolicy: { reviewer: "policy", tenant: "tenant" },
      untrustedEvidence: "evidence",
    })
    assert.deepEqual(Object.keys(request.body.questions), ["outcome"])
    assert.equal(
      new Headers(request.options.headers).get("authorization"),
      "Bearer synthetic-test-credential",
    )
    assert.deepEqual(result.usage, { prompt_tokens: 12, completion_tokens: 4 })
  } finally {
    delete process.env.PRB_SYSTEM_ONE_TEST_KEY
  }
})

test("System One transport redacts a credential echoed by an error", async () => {
  process.env.PRB_SYSTEM_ONE_TEST_KEY = "synthetic-test-credential"
  try {
    const result = await requestSystemOne(
      model,
      { systemOne: { state: {}, questions: {} } },
      {
        fetchImpl: async () =>
          new Response("synthetic-test-credential", {
            status: 401,
            headers: { "content-type": "text/plain" },
          }),
      },
    )
    assert(!result.ok)
    assert(!result.error.includes("synthetic-test-credential"))
  } finally {
    delete process.env.PRB_SYSTEM_ONE_TEST_KEY
  }
})
