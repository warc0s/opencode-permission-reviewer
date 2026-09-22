import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { safeError } from "./util.mjs"

const INSTANCE_DISPOSE_ATTEMPTS = 3

/** Send a benchmark prompt through an actual OpenCode V1 host, never through its OAuth tokens. */
export async function requestOpenCodeV1(
  model,
  prepared,
  { timeoutMs = 120000, retryNote, signal, fetchImpl = fetch } = {},
) {
  const started = performance.now()
  const directory = await mkdtemp(join(tmpdir(), "prb-opencode-v1-"))
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs)
  let sessionID
  let outcome
  const password = process.env[model.hostPasswordEnv]
  if (!password) {
    await rm(directory, { recursive: true })
    throw new Error(`Missing OpenCode host password environment variable ${model.hostPasswordEnv}`)
  }
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  const call = async (method, path, body, currentSignal = requestSignal) => {
    const url = new URL(path, model.endpoint)
    url.searchParams.set("directory", directory)
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: authorization,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: currentSignal,
      redirect: "error",
    })
    if (!response.ok)
      throw Object.assign(new Error(`OpenCode HTTP ${response.status}`), {
        status: response.status,
      })
    return response.status === 204 ? null : response.json()
  }
  try {
    const created = await call("POST", "/session", { title: "Synthetic permission benchmark" })
    sessionID = created?.id
    if (typeof sessionID !== "string" || !sessionID.startsWith("ses_"))
      throw new Error("OpenCode returned an invalid session ID")
    const [providerID, modelID] = model.model.split("/")
    const result = await call("POST", `/session/${encodeURIComponent(sessionID)}/message`, {
      model: { providerID, modelID },
      variant: model.variant,
      tools: { "*": false },
      system: prepared.system,
      format:
        model.format === "json_schema"
          ? { type: "json_schema", schema: prepared.schema, retryCount: 0 }
          : { type: "text" },
      parts: [{ type: "text", text: prepared.user + (retryNote ? `\n\n${retryNote}` : "") }],
    })
    const info = result?.info
    const parts = result?.parts
    if (info?.error) throw new Error(`OpenCode model error: ${info.error.name ?? "unknown"}`)
    if (info?.providerID !== providerID || info?.modelID !== modelID)
      throw new Error("OpenCode returned a different provider or model")
    if (!Array.isArray(parts)) throw new Error("OpenCode response has no parts")
    if (parts.some((part) => part?.type === "tool"))
      throw new Error("OpenCode returned a tool action despite disabled tools")
    const textParts = parts.filter((part) => part?.type === "text" && typeof part.text === "string")
    const text =
      model.format === "json_schema"
        ? JSON.stringify(info.structured ?? null)
        : textParts.map((part) => part.text).join("\n")
    const usage = info.tokens && {
      prompt_tokens: info.tokens.input ?? null,
      completion_tokens: info.tokens.output ?? null,
      reasoning_tokens: info.tokens.reasoning ?? null,
    }
    const raw = {
      host: "opencode-v1",
      model: `${info.providerID}/${info.modelID}`,
      variant: model.variant,
      sessionID,
      tokens: info.tokens ?? null,
      parts: textParts.map((part) => ({ type: "text", text: part.text })),
    }
    outcome = {
      ok: true,
      status: 200,
      raw,
      rawText: JSON.stringify(raw),
      extracted: {
        text,
        ...(text ? {} : { protocolError: "OpenCode returned no decision text." }),
      },
      latencyMs: performance.now() - started,
      returnedModel: raw.model,
      usage: usage ?? null,
    }
  } catch (error) {
    outcome = {
      ok: false,
      status: typeof error.status === "number" ? error.status : null,
      error: safeError(error),
      rawText: "",
      latencyMs: performance.now() - started,
      halt: true,
    }
  } finally {
    if (sessionID) {
      try {
        await call(
          "DELETE",
          `/session/${encodeURIComponent(sessionID)}`,
          undefined,
          AbortSignal.timeout(5000),
        )
      } catch {
        // The benchmark never converts cleanup failures into an approval.
      }
    }
    let disposalError
    for (let attempt = 0; attempt < INSTANCE_DISPOSE_ATTEMPTS; attempt++) {
      try {
        await call("POST", "/instance/dispose", undefined, AbortSignal.timeout(5000))
        disposalError = undefined
        break
      } catch (error) {
        disposalError = error
      }
    }
    if (disposalError) {
      outcome = {
        ok: false,
        status: typeof disposalError.status === "number" ? disposalError.status : null,
        error: `OpenCode instance cleanup failed after ${INSTANCE_DISPOSE_ATTEMPTS} attempts: ${safeError(disposalError)}`,
        rawText: "",
        latencyMs: performance.now() - started,
        halt: true,
      }
    }
    await rm(directory, { recursive: true })
  }
  return outcome
}
