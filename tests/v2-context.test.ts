import { expect, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode/client"
import { normalizeV2Permission } from "../src/opencode/v2/permission-codec.ts"
import { createV2ContextReader } from "../src/opencode/v2/context-reader.ts"
import { V2AskDecisions } from "../src/opencode/v2/event-codec.ts"

test("native resources are never promoted into commands and shared source IDs do not deduplicate", () => {
  const input = {
    action: "shell",
    sessionID: "ses_operation",
    effect: "ask" as const,
    resources: ["printf *"],
    source: { type: "tool" as const, messageID: "message_shared", id: "call_shared" },
    metadata: {},
  }
  const scope = {
    reviewID: "review_first",
    generation: "generation",
    directory: "/workspace",
    hostVersion: "2.0.3",
  }
  const incomplete = normalizeV2Permission(input, scope)
  expect(incomplete.request.permission).toBe("bash")
  expect(incomplete.actionEvidenceComplete).toBe(false)
  expect(incomplete.request.metadata.command).toBeUndefined()
  expect(incomplete.hostRequestID).toBeUndefined()
  const exact = { command: "printf safe" }
  const complete = normalizeV2Permission(input, { ...scope, reviewID: "review_second" }, exact)
  exact.command = "changed after capture"
  expect(complete.request.metadata.command).toBe("printf safe")
  expect(complete.actionEvidenceComplete).toBe(true)
  expect(complete.reviewID).not.toBe(incomplete.reviewID)
  expect(complete.request.tool).toEqual(incomplete.request.tool)
  expect(
    normalizeV2Permission({ ...input, action: "subagent" }, scope, { prompt: "Inspect only" })
      .request.permission,
  ).toBe("task")
  expect(normalizeV2Permission({ ...input, action: "edit" }, scope).actionEvidenceComplete).toBe(
    false,
  )
})

test("context preserves fork provenance and marks omitted history without inventing user orders", async () => {
  const controller = new AbortController()
  const ctx = {
    session: {
      get: async (_input: unknown, options: { signal: AbortSignal }) => {
        expect(options.signal).toBe(controller.signal)
        return {
          id: "ses_child",
          location: { directory: "/workspace" },
          fork: { sessionID: "ses_parent" },
          time: { created: 100 },
        }
      },
      context: async () => [
        { type: "compaction", id: "compact" },
        { type: "user", id: "inherited", text: "Old instruction", time: { created: 50 } },
        { type: "user", id: "current", text: "Current instruction", time: { created: 150 } },
        { type: "synthetic", text: "Injected instruction" },
        {
          type: "assistant",
          id: "assistant",
          agent: "build",
          time: { created: 200 },
          content: [
            { type: "text", text: "Inspecting" },
            {
              type: "tool",
              id: "tool_call",
              name: "shell",
              state: { input: { command: "printf safe" } },
            },
          ],
        },
      ],
    },
  } as unknown as Parameters<typeof createV2ContextReader>[0]
  const reader = createV2ContextReader(ctx, controller.signal)
  const result = (await reader.messages("ses_child", "/workspace", 5)) as Array<{
    info: Record<string, unknown>
    parts: Array<Record<string, unknown>>
  }>
  expect(result[0]?.info.role).toBe("system")
  expect(result[1]?.info).toMatchObject({
    role: "assistant",
    synthetic: true,
    originSessionID: "ses_parent",
  })
  expect(result[2]?.info.role).toBe("user")
  expect(JSON.stringify(result)).not.toContain("Injected instruction")
  expect(result[3]?.parts[1]).toMatchObject({ callID: "tool_call", tool: "shell" })
  expect(await reader.session("ses_child", "/workspace")).toHaveProperty("id", "ses_child")
  await expect(reader.session("ses_child", "/other")).rejects.toThrow("location mismatch")
  await expect(reader.messages("ses_child", "/other", 5)).rejects.toThrow("location mismatch")
  expect(((await reader.messages("ses_child", "/workspace", 1)) as unknown[]).length).toBe(2)
})

test("native forms retain labels, scope, redaction, cancellation, and orphan protection", () => {
  const registry = new V2AskDecisions()
  const observe = (type: string, data: unknown, directory = "/workspace") =>
    registry.observe({ type, data, location: { directory } } as OpenCodeEvent, "/workspace")
  const form = {
    id: "form_fixture",
    sessionID: "ses_main",
    title: "Scope",
    fields: [
      {
        key: "scope",
        title: "Choose scope",
        type: "string",
        options: [{ value: "read", label: "Read only" }],
      },
    ],
  }
  observe("form.replied", { id: form.id, sessionID: form.sessionID, answer: { scope: "read" } })
  expect(registry.recentFor([form.sessionID])).toEqual([])
  observe("form.created", { form }, "/other")
  observe("form.replied", { id: form.id, sessionID: form.sessionID, answer: { scope: "read" } })
  expect(registry.recentFor([form.sessionID])).toEqual([])
  observe("form.created", { form })
  observe("form.created", { form })
  observe("form.replied", { id: form.id, sessionID: "ses_sibling", answer: { scope: "read" } })
  observe("form.replied", { id: form.id, sessionID: form.sessionID, answer: { scope: "read" } })
  expect(registry.recentFor([form.sessionID])[0]?.answer).toBe("Read only")
  expect(registry.recentFor(["ses_sibling"])).toEqual([])
  observe("form.created", { form: { ...form, id: "form_cancel" } })
  observe("form.cancelled", { id: "form_cancel", sessionID: form.sessionID })
  expect(registry.recentFor([form.sessionID]).at(-1)?.answer).toBe("Dismissed by user")
  observe("form.created", { form: { ...form, id: "form_secret" } })
  const secret = "gh" + "p_" + "synthetic".repeat(6)
  observe("form.replied", {
    id: "form_secret",
    sessionID: form.sessionID,
    answer: { scope: secret },
  })
  expect(JSON.stringify(registry.recentFor([form.sessionID]))).not.toContain(secret)
})
