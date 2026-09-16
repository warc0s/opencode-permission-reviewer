import { assert, safeError } from "./util.mjs"
const RESERVED = new Set([
  "model",
  "messages",
  "stream",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "response_format",
  "n",
  "api_key",
  "authorization",
])
const FORMATS = new Set(["text", "json_schema", "tool"])
export function validateModel(model) {
  assert(
    model && typeof model.id === "string" && /^[a-zA-Z0-9_.-]+$/.test(model.id),
    "Model id must be a safe unique label.",
  )
  assert(
    typeof model.model === "string" && model.model.length > 0,
    `${model.id}: model identifier missing`,
  )
  const transport = model.transport ?? "chat-completions"
  assert(
    ["chat-completions", "opencode-v1"].includes(transport),
    `${model.id}: unsupported transport`,
  )
  assert(typeof model.endpoint === "string", `${model.id}: endpoint missing`)
  const url = new URL(model.endpoint)
  assert(
    !url.username && !url.password && !url.search && !url.hash,
    "Do not put credentials, query strings or fragments in endpoint URLs.",
  )
  assert(
    url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)),
    "Use HTTPS, except for loopback local servers.",
  )
  assert(
    FORMATS.has(model.format ?? "text"),
    `${model.id}: format must be text, json_schema or tool`,
  )
  if (transport === "opencode-v1") {
    assert(
      url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
        url.pathname === "/",
      "OpenCode host must be a loopback HTTP server root.",
    )
    assert(
      /^[a-z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(model.model),
      "OpenCode model must use provider/model.",
    )
    assert(
      typeof model.variant === "string" && model.variant.length > 0,
      "OpenCode variant is required.",
    )
    assert(
      (model.format ?? "text") !== "tool",
      "OpenCode V1 transport does not support the tool profile.",
    )
    assert(
      model.apiKeyEnv === undefined && model.parameters === undefined,
      "OpenCode transport uses the host's credentials and variants, not direct API parameters.",
    )
    assert(
      typeof model.hostPasswordEnv === "string" &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(model.hostPasswordEnv),
      "OpenCode transport requires a hostPasswordEnv environment variable for local server authentication.",
    )
  } else {
    assert(model.hostPasswordEnv === undefined, "hostPasswordEnv is only for OpenCode transport.")
  }
  if (model.apiKeyEnv !== undefined)
    assert(
      typeof model.apiKeyEnv === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(model.apiKeyEnv),
      "apiKeyEnv must name an environment variable, not contain a key.",
    )
  for (const k of Object.keys(model.parameters ?? {}))
    assert(!RESERVED.has(k), `Reserved provider parameter: ${k}`)
  const allowed = new Set([
    "id",
    "model",
    "endpoint",
    "apiKeyEnv",
    "format",
    "parameters",
    "variant",
    "pricesPerMillion",
    "notes",
    "transport",
    "hostPasswordEnv",
  ])
  for (const k of Object.keys(model))
    assert(
      allowed.has(k),
      `Unknown model configuration key ${k}. Use parameters for provider options; secrets only via apiKeyEnv.`,
    )
  if (model.pricesPerMillion)
    for (const v of Object.values(model.pricesPerMillion))
      assert(Number.isFinite(v) && v >= 0, "Prices must be nonnegative numbers.")
  return { ...model, transport, format: model.format ?? "text" }
}
export function buildBody(model, prepared, retryNote) {
  const messages = [
    { role: "system", content: prepared.system },
    { role: "user", content: prepared.user + (retryNote ? "\n\n" + retryNote : "") },
  ]
  const body = { ...model.parameters, model: model.model, messages, stream: false, n: 1 }
  if (model.format === "json_schema")
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "permission_decision", strict: true, schema: prepared.schema },
    }
  if (model.format === "tool") {
    body.tools = [
      {
        type: "function",
        function: {
          name: "permission_reviewer_result",
          description:
            "Return exactly one final permission review decision matching the required schema.",
          parameters: prepared.schema,
        },
      },
    ]
    // No forced selection: missing/extra calls are visible failures, not silently repaired approvals.
    body.tool_choice = "auto"
    body.parallel_tool_calls = false
  }
  return body
}
export function extractResponse(raw, format) {
  if (!Array.isArray(raw?.choices) || raw.choices.length !== 1)
    return { text: "", protocolError: "Expected exactly one completion choice." }
  const choice = raw.choices[0]
  if (!choice || typeof choice !== "object")
    return { text: "", protocolError: "Malformed completion choice." }
  const message = choice.message
  if (!message || typeof message !== "object")
    return { text: "", protocolError: "Missing completion message." }
  if (message.refusal)
    return {
      text: typeof message.content === "string" ? message.content : "",
      protocolError: "Provider refusal.",
      refusal: message.refusal,
    }
  const content = message.content
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((p) => p && p.type === "text" && typeof p.text === "string")
            .map((p) => p.text)
            .join("\n")
        : ""
  if (["length", "content_filter"].includes(choice.finish_reason))
    return { text, protocolError: `Incomplete completion: ${choice.finish_reason}` }
  if (format === "tool") {
    const calls = message.tool_calls
    if (
      !Array.isArray(calls) ||
      calls.length !== 1 ||
      calls[0].type !== "function" ||
      calls[0].function?.name !== "permission_reviewer_result"
    )
      return {
        text,
        protocolError:
          "Expected exactly one inert result tool call; no operational calls are accepted.",
      }
    if (typeof calls[0].function.arguments !== "string")
      return { text, protocolError: "Tool arguments must be a JSON string." }
    // V2 may finish with text around a successful call, so keep it for audit, not as a second decision.
    return {
      text: calls[0].function.arguments ?? "",
      visibleText: text,
      exposedReasoning: message.reasoning_content ?? message.reasoning ?? null,
    }
  }
  if (message.tool_calls?.length || message.function_call)
    return { text, protocolError: "Unexpected tool call in text/schema profile." }
  return { text, exposedReasoning: message.reasoning_content ?? message.reasoning ?? null }
}
async function boundedText(response, maxBytes) {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const chunks = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new Error(`Provider response exceeds ${maxBytes} bytes.`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}
/** Only this function contacts a provider. Fixture URLs, commands and tool calls are NEVER executed. */
export async function requestCompletion(
  model,
  prepared,
  {
    timeoutMs = 120000,
    maxResponseBytes = 4 * 1024 * 1024,
    retryNote,
    signal,
    fetchImpl = fetch,
  } = {},
) {
  const body = buildBody(model, prepared, retryNote),
    start = performance.now()
  const key = model.apiKeyEnv ? process.env[model.apiKeyEnv] : undefined
  if (model.apiKeyEnv && !key)
    throw new Error(`Missing credential environment variable ${model.apiKeyEnv}`)
  const headers = {
    "Content-Type": "application/json",
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
  }
  let response,
    rawText = ""
  try {
    response = await fetchImpl(model.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
      redirect: "error",
    })
    rawText = await boundedText(response, maxResponseBytes)
    // Defend against a provider echoing the literal Authorization secret in an error body.
    if (key) rawText = rawText.split(key).join("[REDACTED:provider_api_key]")
    if (!response.ok)
      return {
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}`,
        rawText,
        latencyMs: performance.now() - start,
        requestId: response.headers.get("x-request-id"),
      }
    let raw
    try {
      raw = JSON.parse(rawText)
    } catch {
      return {
        ok: false,
        status: response.status,
        error: "Non-JSON provider response.",
        rawText,
        latencyMs: performance.now() - start,
      }
    }
    return {
      ok: true,
      status: response.status,
      raw,
      rawText,
      latencyMs: performance.now() - start,
      requestId: response.headers.get("x-request-id"),
      extracted: extractResponse(raw, model.format),
      usage: raw.usage ?? null,
      returnedModel: raw.model ?? null,
      systemFingerprint: raw.system_fingerprint ?? null,
      finishReason: raw.choices?.[0]?.finish_reason ?? null,
    }
  } catch (error) {
    const message = safeError(error)
    return {
      ok: false,
      error: key ? message.split(key).join("[REDACTED:provider_api_key]") : message,
      rawText,
      latencyMs: performance.now() - start,
      status: response?.status ?? null,
    }
  }
}
export const TEXT_RETRY_NOTE =
  "Your previous response could not be parsed as a decision. Respond again with exactly one JSON object conforming to the schema and nothing else - no prose, no Markdown code fences, no commentary, and no copy of the schema."
