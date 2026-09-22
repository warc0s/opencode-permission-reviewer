import { TypeSafeClient } from "@typesafe-ai/sdk"
import { safeError } from "./util.mjs"

/** Send one typed System One request. Fixture commands remain inert data. */
export async function requestSystemOne(
  model,
  prepared,
  { timeoutMs = 120000, signal, fetchImpl } = {},
) {
  const started = performance.now()
  const key = process.env[model.apiKeyEnv]
  if (!key) throw new Error(`Missing credential environment variable ${model.apiKeyEnv}`)
  try {
    const client = new TypeSafeClient({
      apiKey: key,
      baseURL: model.endpoint,
      defaultModel: model.model,
      logLevel: "off",
      timeout: timeoutMs,
      retry: { maxRetries: 0 },
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    })
    const { data, response, requestId } = await client
      .systemOne(
        {
          model: model.model,
          state: prepared.systemOne.state,
          questions: prepared.systemOne.questions,
        },
        { signal, timeout: timeoutMs, retry: { maxRetries: 0 } },
      )
      .withResponse()
    return {
      ok: true,
      status: response.status,
      raw: data,
      rawText: JSON.stringify(data),
      extracted: { systemOne: true },
      latencyMs: performance.now() - started,
      requestId,
      returnedModel: data.model,
      usage: {
        prompt_tokens: data.usage.input_tokens,
        completion_tokens: data.usage.output_tokens,
      },
    }
  } catch (error) {
    const message = safeError(error).split(key).join("[REDACTED:provider_api_key]")
    return {
      ok: false,
      status: typeof error?.status === "number" ? error.status : null,
      error: message,
      rawText: "",
      latencyMs: performance.now() - started,
    }
  }
}
