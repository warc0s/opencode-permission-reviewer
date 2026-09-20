import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import type { OpenCodeClient } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import { V2ReviewerBackend } from "../src/opencode/v2/reviewer-backend.ts"
import { ReviewAttempt } from "../src/core/review-attempt.ts"
import type { ReviewEnvelope, ReviewerConfig } from "../src/types.ts"
import { config, decision, request } from "./helpers.ts"

type Context = Parameters<Plugin.Plugin["setup"]>[0]
type Tool = {
  input: { parse(value: unknown): unknown }
  execute(value: unknown, event: { sessionID: string }): Promise<unknown>
}
type ContextEvent = {
  sessionID: string
  system: unknown[]
  messages: unknown[]
  tools: Record<string, unknown>
}

function fixture(
  options: {
    format?: ReviewerConfig["outputFormat"]
    invalid?: boolean
    ambiguous?: boolean
    foreignResponse?: boolean
    missingModel?: boolean
    noTools?: boolean
    variant?: string
    retain?: boolean
    wrongLocation?: boolean
    activationFailed?: boolean
    activationDelayed?: boolean
    activationRepresentation?: "directory-slash" | "file-url" | "id-only" | "id-new-path"
  } = {},
) {
  let tool!: Tool
  let contextHook!: (event: ContextEvent) => void
  let toolHook!: (event: { sessionID: string; tool: string }) => void
  let directory = ""
  let sessionID = ""
  let removed = false
  let prompts = 0
  let disposed = 0
  let checks = 0
  let setups = 0
  let pluginID = ""
  const registration = () => ({
    dispose: async () => {
      disposed++
    },
  })
  const ctx = {
    location: { directory: "/workspace/operational" },
    tool: {
      transform: async (callback: (editor: { add(definition: Tool): void }) => void) => {
        callback({
          add: (definition) => {
            tool = definition
          },
        })
        return registration()
      },
      hook: async (_name: string, callback: typeof toolHook) => {
        toolHook = callback
        return registration()
      },
    },
    session: {
      hook: async (_name: string, callback: typeof contextHook) => {
        contextHook = callback
        return registration()
      },
    },
  } as unknown as Context
  const client = {
    plugin: {
      list: async (input: { location: { directory: string } }) => {
        directory = input.location.directory
        checks++
        if (setups === 0) {
          const plugin = await import(pathToFileURL(directory + "/index.js").href)
          pluginID = plugin.default.id
          await plugin.default.setup({ ...ctx, location: { directory } })
          setups++
        }
        if (options.activationFailed)
          return {
            data: [
              {
                source: { type: "local", path: directory + "/index.js" },
                state: { status: "failed", error: "Fixture activation failure" },
              },
            ],
          }
        if (options.activationDelayed && checks < 3) return { data: [] }
        const sourcePath =
          options.activationRepresentation === "directory-slash"
            ? directory + "/"
            : options.activationRepresentation === "file-url"
              ? pathToFileURL(directory + "/index.js").href
              : options.activationRepresentation === "id-new-path"
                ? `plugin://${pluginID}`
                : directory + "/index.js"
        return {
          data: [
            {
              id: pluginID,
              source:
                options.activationRepresentation === "id-only"
                  ? { type: "local" }
                  : { type: "local", path: sourcePath },
              state: { status: "active" },
            },
          ],
        }
      },
    },
    model: {
      list: async () => ({
        data: options.missingModel
          ? []
          : [
              {
                providerID: "fixture",
                id: "reviewer",
                capabilities: { tools: !options.noTools },
                variants: [{ id: "max" }],
              },
            ],
      }),
    },
    session: {
      create: async (input: {
        id: string
        location: { directory: string }
        permissions: unknown[]
      }) => {
        sessionID = input.id
        expect(input.permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" })
        return {
          id: sessionID,
          location: { directory: options.wrongLocation ? "/workspace/operational" : directory },
        }
      },
      prompt: async () => {
        prompts++
        const event: ContextEvent = {
          sessionID,
          system: ["UNTRUSTED_SYSTEM"],
          messages: ["UNTRUSTED_HISTORY"],
          tools: { permission_reviewer_result: tool, shell: {} },
        }
        contextHook(event)
        expect(JSON.stringify(event.system)).not.toContain("UNTRUSTED_SYSTEM")
        expect(JSON.stringify(event.messages)).not.toContain("UNTRUSTED_HISTORY")
        expect(event.tools.shell).toBeUndefined()
        expect(() => toolHook({ sessionID, tool: "shell" })).toThrow("Operational tools")
        if (options.format !== "text" && !options.invalid) {
          await tool.execute(tool.input.parse(decision("allow")), { sessionID })
          if (options.ambiguous)
            await expect(tool.execute(decision("deny"), { sessionID })).rejects.toThrow("ambiguous")
        }
        return { id: "inbox_fixture" }
      },
      wait: async () => {},
      context: async () => [
        {
          type: "user",
          id: options.foreignResponse ? "inbox_other" : "inbox_fixture",
          text: "evidence",
        },
        {
          type: "assistant",
          id: "message_result",
          content:
            options.format === "text"
              ? [
                  {
                    type: "text",
                    text: options.invalid ? "not a decision" : JSON.stringify(decision("allow")),
                  },
                ]
              : [
                  {
                    type: "tool",
                    id: "call_result",
                    name: "permission_reviewer_result",
                    state: { status: "completed" },
                  },
                ],
        },
      ],
      interrupt: async () => {},
      remove: async () => {
        removed = true
      },
      get: async () => {
        if (removed) throw { _tag: "SessionNotFoundError" }
        return { id: sessionID }
      },
    },
  } as unknown as OpenCodeClient
  const backend = new V2ReviewerBackend(
    ctx,
    config({
      model: "fixture/reviewer",
      ...(options.variant ? { variant: options.variant } : {}),
      outputFormat: options.format ?? "json_schema",
      retainReviewSessions: options.retain ?? false,
    }),
  )
  const attempt = new ReviewAttempt("generation_fixture", 5000)
  const envelope: ReviewEnvelope = {
    request: request(),
    directory: "/workspace/operational",
    worktree: "/workspace/operational",
    transcript: "Run printf safe",
    intentHistory: "Run printf safe",
    enrichment: "",
    sshAudit: [],
  }
  return {
    backend,
    attempt,
    run: () => backend.review(envelope, attempt, client),
    state: () => ({ directory, sessionID, removed, prompts, disposed, setups }),
    unrelated: () => {
      const event: ContextEvent = {
        sessionID: "ses_other",
        system: [],
        messages: [],
        tools: { permission_reviewer_result: tool, shell: {} },
      }
      contextHook(event)
      expect(event.tools.permission_reviewer_result).toBeUndefined()
      expect(event.tools.shell).toBeDefined()
      toolHook({ sessionID: "ses_other", tool: "shell" })
      return tool.execute(decision("allow"), { sessionID: "ses_other" })
    },
    cleanup: async () => {
      attempt.close("cancelled")
      await backend.waitForIdle()
      if (directory && existsSync(directory)) await rm(directory, { recursive: true })
    },
  }
}

test("isolated structured and text backends preserve scope, variant, and retention", async () => {
  for (const format of ["json_schema", "text"] as const) {
    const harness = fixture({ format, variant: "max", retain: format === "text" })
    try {
      expect((await harness.run()).kind).toBe("allow")
      const state = harness.state()
      expect(state.prompts).toBe(1)
      expect(state.removed).toBe(format !== "text")
      expect(state.disposed).toBe(3)
      expect(harness.backend.owns(state.sessionID)).toBe(false)
      expect(existsSync(state.directory + "/index.js")).toBe(false)
      await expect(harness.unrelated()).rejects.toThrow("Not an active")
    } finally {
      await harness.cleanup()
    }
  }
})

test("invalid, ambiguous, and foreign execution outputs never become approvals", async () => {
  for (const options of [
    { invalid: true },
    { format: "text" as const, invalid: true },
    { ambiguous: true },
    { foreignResponse: true },
    { format: "text" as const, foreignResponse: true },
  ]) {
    const harness = fixture(options)
    try {
      expect((await harness.run()).kind).toBe("escalate")
      expect(harness.state().prompts).toBeLessThanOrEqual(3)
      expect(harness.state().removed).toBe(true)
    } finally {
      await harness.cleanup()
    }
  }
})

test("isolation activation waits for the host report and fails loudly", async () => {
  const delayed = fixture({ activationDelayed: true })
  try {
    expect((await delayed.run()).kind).toBe("allow")
    expect(delayed.state().prompts).toBe(1)
    expect(delayed.state().setups).toBe(1)
  } finally {
    await delayed.cleanup()
  }
  const failed = fixture({ activationFailed: true })
  try {
    const result = await failed.run()
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("failed to activate")
    expect(failed.state().prompts).toBe(0)
  } finally {
    await failed.cleanup()
  }
})

test("isolation activation accepts normalized local plugin representations", async () => {
  for (const activationRepresentation of [
    "directory-slash",
    "file-url",
    "id-only",
    "id-new-path",
  ] as const) {
    const harness = fixture({ activationRepresentation })
    try {
      expect((await harness.run()).kind).toBe("allow")
      expect(harness.state().prompts).toBe(1)
    } finally {
      await harness.cleanup()
    }
  }
})

test("unavailable model, unsupported format or variant, and wrong isolation fail before prompting", async () => {
  for (const options of [
    { missingModel: true },
    { noTools: true },
    { variant: "unsupported" },
    { wrongLocation: true },
  ]) {
    const harness = fixture(options)
    try {
      expect((await harness.run()).kind).toBe("escalate")
      expect(harness.state().prompts).toBe(0)
      expect(existsSync(harness.state().directory)).toBe(false)
    } finally {
      await harness.cleanup()
    }
  }
})
