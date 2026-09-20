import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Run one synthetic request in a fresh official Command Code headless process. */
export async function requestCommandCodeCli(
  model,
  prepared,
  { timeoutMs = 120000, retryNote, signal } = {},
) {
  const started = performance.now()
  const binary = process.env[model.commandCodeBinEnv]
  if (!binary)
    throw new Error(`Missing Command Code binary environment variable ${model.commandCodeBinEnv}`)
  const directory = await mkdtemp(join(tmpdir(), "prb-command-code-"))
  const query =
    `<reviewer_system>\n${prepared.system}\n</reviewer_system>\n\n` +
    `<permission_request>\n${prepared.user}${retryNote ? `\n\n${retryNote}` : ""}\n</permission_request>`
  const args = [
    "--no-auto-update",
    "--no-session",
    "--no-skills",
    "--skip-onboarding",
    "--trust",
    "--permission-mode",
    "dont-ask",
    "--max-turns",
    "1",
    "--model",
    model.model,
    "--effort",
    model.variant,
    "--output-format",
    "json",
    "-p",
  ]
  const env = { ...process.env, NO_COLOR: "1" }
  delete env.COMMAND_CODE_API_KEY
  delete env.CMD_API_KEY
  let child
  let timer
  let killTimer
  let timedOut = false
  let aborted = false
  let outputTooLarge = false
  let outputBytes = 0
  let buffer = ""
  let finalResult
  let returnedModel
  let toolEvents = 0
  const terminate = () => {
    if (!child || child.exitCode !== null) return
    child.kill("SIGTERM")
    killTimer = setTimeout(() => child.kill("SIGKILL"), 3000)
    killTimer.unref()
  }
  const onAbort = () => {
    aborted = true
    terminate()
  }
  try {
    if (signal?.aborted) {
      aborted = true
      throw new Error("Benchmark request was interrupted")
    }
    child = spawn(binary, args, {
      cwd: directory,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    })
    signal?.addEventListener("abort", onAbort, { once: true })
    timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
    timer.unref()
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > 32 * 1024 * 1024) {
        outputTooLarge = true
        terminate()
        return
      }
      buffer += chunk
      for (;;) {
        const end = buffer.indexOf("\n")
        if (end < 0) break
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        try {
          const frame = JSON.parse(line)
          if (frame.type === "result") finalResult = frame
          if (frame.type === "event" && frame.event?.type === "model_request_start")
            returnedModel = frame.event.model
          if (frame.type === "event" && /^tool_/.test(frame.event?.type ?? "")) toolEvents++
        } catch {
          // Ignore diagnostic lines and unknown forward-compatible frames.
        }
      }
    })
    child.stderr.resume()
    child.stdin.on("error", () => {
      // An early CLI exit is reported through its exit code, not a pipe error.
    })
    child.stdin.end(query)
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("close", resolve)
    })
    if (timedOut || aborted || outputTooLarge || exitCode !== 0) {
      const reason = timedOut
        ? "Command Code request timed out."
        : aborted
          ? "Command Code request was interrupted."
          : outputTooLarge
            ? "Command Code emitted excessive output."
            : `Command Code exited with code ${exitCode}.`
      throw new Error(reason)
    }
    if (returnedModel !== model.model) throw new Error("Command Code returned a different model.")
    if (toolEvents > 0) throw new Error("Command Code attempted a tool action.")
    if (finalResult?.subtype !== "success" || finalResult.stopReason !== "end_turn")
      throw new Error("Command Code did not return one completed answer.")
    const response = finalResult.finalText
    const usage = finalResult.usage
    const raw = {
      host: "command-code-cli",
      model: returnedModel,
      variant: model.variant,
      usage: usage ?? null,
      finalText: response,
    }
    return {
      ok: true,
      status: 200,
      raw,
      rawText: JSON.stringify(raw),
      extracted: {
        text: typeof response === "string" ? response : "",
        ...(typeof response === "string" && response ? {} : { protocolError: "No final text." }),
      },
      latencyMs: performance.now() - started,
      returnedModel,
      usage: usage
        ? {
            prompt_tokens: usage.inputTokens ?? null,
            completion_tokens: usage.outputTokens ?? null,
            cache_read_tokens: usage.cacheReadTokens ?? null,
          }
        : null,
    }
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : "Command Code request failed.",
      rawText: "",
      latencyMs: performance.now() - started,
      halt: true,
    }
  } finally {
    clearTimeout(timer)
    clearTimeout(killTimer)
    signal?.removeEventListener("abort", onAbort)
    await rm(directory, { recursive: true, force: true })
  }
}
