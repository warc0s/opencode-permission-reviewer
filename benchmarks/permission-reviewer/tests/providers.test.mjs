import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { validateModel, buildBody, extractResponse, requestCompletion } from "../lib/providers.mjs"
import { decision, model } from "./helpers.mjs"
const prepared = { system: "POLICY", user: "INERT DATA", schema: { type: "object" } }
test("endpoint permits loopback HTTP, rejects external HTTP and credential URLs", () => {
  assert(validateModel(model))
  for (const endpoint of [
    "http://external.example.invalid/v1",
    "https://key@provider.invalid/x",
    "https://provider.invalid/x?key=secret",
  ])
    assert.throws(() => validateModel({ ...model, endpoint }))
})
test("provider params cannot override instruction or tool boundary", () => {
  for (const key of ["messages", "tools", "model", "response_format", "api_key", "stream", "n"])
    assert.throws(() => validateModel({ ...model, parameters: { [key]: "x" } }), /Reserved/)
})
test("System One profile requires a Jev model and no chat-only options", () => {
  const systemOne = {
    id: "jev-private",
    model: "jev-1.13",
    endpoint: "https://opencode.ai/zen",
    apiKeyEnv: "OPENCODE_API_KEY",
    transport: "system-one",
    format: "system_one",
  }
  assert.equal(validateModel(systemOne).transport, "system-one")
  assert.equal(validateModel({ ...systemOne, model: "typesafe/jev" }).model, "typesafe/jev")
  assert.throws(() => validateModel({ ...systemOne, model: "other-model" }), /Jev/)
  assert.throws(() => validateModel({ ...systemOne, format: "text" }), /system_one/)
  assert.throws(() => validateModel({ ...systemOne, variant: "high" }), /reasoning variants/)
  assert.throws(() => validateModel({ ...systemOne, parameters: {} }), /parameters/)
})
test("body transmits only prompt, model, schema and declared parameters", () => {
  const p = { ...prepared, gold: "DO_NOT_SEND", family: "NO", expected: "NO" }
  const b = buildBody(model, p)
  assert(!JSON.stringify(b).includes("DO_NOT_SEND"))
  assert.deepEqual(b.messages, [
    { role: "system", content: "POLICY" },
    { role: "user", content: "INERT DATA" },
  ])
})
test("Granite thinking profiles change only the documented text prompt shape", () => {
  const granite = {
    ...model,
    id: "granite-local",
    model: "granite-4.2-8b",
    endpoint: "http://127.0.0.1:7860/v1/chat/completions",
    format: "text",
  }
  for (const mode of ["off", "low", "full"])
    assert.equal(validateModel({ ...granite, graniteThinkingMode: mode }).graniteThinkingMode, mode)
  const off = buildBody({ ...granite, graniteThinkingMode: "off" }, prepared)
  assert.deepEqual(off.messages, [
    { role: "system", content: "POLICY" },
    { role: "user", content: "INERT DATA" },
    { role: "assistant", content: "<think></think>" },
  ])
  const low = buildBody({ ...granite, graniteThinkingMode: "low" }, prepared)
  assert.deepEqual(low.messages, [
    { role: "system", content: "POLICY" },
    { role: "user", content: "INERT DATA\n\n{reasoning effort: low}" },
  ])
  const full = buildBody({ ...granite, graniteThinkingMode: "full" }, prepared)
  assert.deepEqual(full.messages, buildBody(granite, prepared).messages)
  assert.throws(
    () => validateModel({ ...granite, graniteThinkingMode: "bogus" }),
    /graniteThinkingMode/,
  )
  assert.throws(
    () => validateModel({ ...granite, format: "json_schema", graniteThinkingMode: "off" }),
    /local Granite/,
  )
  assert.throws(() => validateModel({ ...model, graniteThinkingMode: "off" }), /local Granite/)
})
test("structured JSON profile uses exact schema", () => {
  const b = buildBody({ ...model, format: "json_schema" }, prepared)
  assert.equal(b.response_format.json_schema.schema, prepared.schema)
  assert.equal(b.response_format.json_schema.strict, true)
  assert(!b.tools)
})
test("tool profile advertises only inert result capture", () => {
  const b = buildBody({ ...model, format: "tool" }, prepared)
  assert.equal(b.tools.length, 1)
  assert.equal(b.tools[0].function.name, "permission_reviewer_result")
  assert.equal(b.parallel_tool_calls, false)
})
test("multiple completion choices rejected", () =>
  assert(extractResponse({ choices: [{}, {}] }, "text").protocolError))
test("multiple/operational tool calls rejected without execution", () => {
  for (const calls of [
    [{ type: "function", function: { name: "bash", arguments: "rm -rf /" } }],
    [
      { type: "function", function: { name: "permission_reviewer_result", arguments: "{}" } },
      { type: "function", function: { name: "permission_reviewer_result", arguments: "{}" } },
    ],
  ])
    assert(extractResponse({ choices: [{ message: { tool_calls: calls } }] }, "tool").protocolError)
})
test("length cutoff remains invalid even with a JSON-looking prefix", () =>
  assert(
    extractResponse(
      { choices: [{ finish_reason: "length", message: { content: JSON.stringify(decision()) } }] },
      "text",
    ).protocolError,
  ))
test("retains provider-visible rationale text separately from exposed reasoning", () => {
  const x = extractResponse(
    {
      choices: [
        {
          message: {
            content: JSON.stringify(decision()),
            reasoning_content: "provider-exposed diagnostic",
          },
        },
      ],
    },
    "text",
  )
  assert.equal(x.text, JSON.stringify(decision()))
  assert.equal(x.exposedReasoning, "provider-exposed diagnostic")
})
test("in-process provider stub exercises real HTTP serialization and logs", async () => {
  let body
  const server = createServer(async (req, res) => {
    let s = ""
    for await (const x of req) s += x
    body = JSON.parse(s)
    res.setHeader("Content-Type", "application/json")
    res.setHeader("x-request-id", "fake-id")
    res.end(
      JSON.stringify({
        model: "mock-returned",
        choices: [
          { finish_reason: "stop", message: { content: JSON.stringify(decision("deny")) } },
        ],
        usage: { prompt_tokens: 17, completion_tokens: 9 },
      }),
    )
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
    const result = await requestCompletion({ ...model, endpoint }, prepared)
    assert(result.ok)
    assert.equal(result.requestId, "fake-id")
    assert.equal(result.returnedModel, "mock-returned")
    assert.equal(JSON.parse(result.extracted.text).outcome, "deny")
    assert.equal(body.messages[1].content, "INERT DATA")
  } finally {
    await new Promise((r) => server.close(r))
  }
})
test("provider echo of API secret is redacted in persisted response", async () => {
  process.env.PRB_TEST_ONLY_KEY = "FAKE_CREDENTIAL_FOR_TEST"
  try {
    const result = await requestCompletion({ ...model, apiKeyEnv: "PRB_TEST_ONLY_KEY" }, prepared, {
      fetchImpl: async () => new Response("FAKE_CREDENTIAL_FOR_TEST", { status: 401 }),
    })
    assert.equal(result.rawText, "[REDACTED:provider_api_key]")
    assert(!result.ok)
  } finally {
    delete process.env.PRB_TEST_ONLY_KEY
  }
})
test("oversized response bounded", async () => {
  const result = await requestCompletion(model, prepared, {
    maxResponseBytes: 10,
    fetchImpl: async () => new Response("x".repeat(11)),
  })
  assert(!result.ok)
  assert.match(result.error, /exceeds/)
})
test("network failure returned separately from model decision", async () => {
  const result = await requestCompletion(model, prepared, {
    fetchImpl: async () => {
      throw new Error("mock disconnected")
    },
  })
  assert(!result.ok)
  assert(!result.extracted)
  assert.match(result.error, /disconnected/)
})
test("malformed choice and non-string tool arguments are protocol failures, not crashes", () => {
  assert(extractResponse({ choices: [null] }, "text").protocolError)
  assert(
    extractResponse(
      {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  type: "function",
                  function: { name: "permission_reviewer_result", arguments: { outcome: "allow" } },
                },
              ],
            },
          },
        ],
      },
      "tool",
    ).protocolError,
  )
})
