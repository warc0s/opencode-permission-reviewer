import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile, rm } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import type { OpenCodeClient } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import { V2ReviewerBackend } from "../src/opencode/v2/reviewer-backend.ts"
import { ReviewAttempt } from "../src/core/review-attempt.ts"
import type { ReviewEnvelope, ReviewerConfig } from "../src/types.ts"
import { config, decision, request } from "./helpers.ts"

type Context = Parameters<Plugin.Plugin["setup"]>[0]
type McpEditor = Parameters<Parameters<Context["mcp"]["transform"]>[0]>[0]
type McpServer = NonNullable<ReturnType<McpEditor["get"]>>
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
    failFirstActivation?: boolean
    activationDelayed?: boolean
    activationRepresentation?: "directory-slash" | "file-url" | "id-only" | "id-new-path"
    mcpServers?: boolean | "after-first"
    pluginMcp?: boolean
  } = {},
) {
  let tool!: Tool
  let contextHook!: (event: ContextEvent) => void
  let toolHook!: (event: { sessionID: string; tool: string }) => void
  let directory = ""
  const directories: string[] = []
  const activated = new Set<string>()
  let sessionID = ""
  const sessionIDs: string[] = []
  const removed = new Set<string>()
  const messagesBySession = new Map<string, string>()
  const attempts: ReviewAttempt[] = []
  let prompts = 0
  let mcpLists = 0
  const mcpTransforms: Array<(editor: McpEditor) => void> = []
  let disposed = 0
  let checks = 0
  let setups = 0
  let pluginID = ""
  let hostCleanup: (() => Promise<void>) | undefined
  // Registrations made by the current bootstrap setup, which the host disposes on unload.
  const scope: Array<{ dispose(): Promise<void> }> = []
  const registration = (onDispose = () => void disposed++) => {
    let active = true
    const handle = {
      dispose: async () => {
        if (active) onDispose()
        active = false
      },
    }
    scope.push(handle)
    return handle
  }
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
    mcp: {
      transform: async (callback: (editor: McpEditor) => void) => {
        mcpTransforms.push(callback)
        return registration(() => void mcpTransforms.splice(mcpTransforms.indexOf(callback), 1))
      },
    },
  } as unknown as Context
  const client = {
    plugin: {
      list: async (input: { location: { directory: string } }) => {
        directory = input.location.directory
        checks++
        if (!activated.has(directory)) {
          const plugin = await import(pathToFileURL(directory + "/index.js").href)
          pluginID = plugin.default.id
          scope.length = 0
          hostCleanup = await plugin.default.setup({ ...ctx, location: { directory } })
          activated.add(directory)
          directories.push(directory)
          setups++
        }
        if (options.activationFailed || (options.failFirstActivation && setups === 1))
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
    mcp: {
      list: async (input: { location: { directory: string } }) => {
        expect(input.location.directory).toBe(directory)
        mcpLists++
        const servers = new Map<string, McpServer>()
        const editor: McpEditor = {
          list: () => [...servers],
          get: (name) => servers.get(name),
          // The host stores a mutable copy of each config, so the fixture does too.
          set: (name, config) => void servers.set(name, structuredClone(config) as McpServer),
          update: () => {},
          remove: (name) => void servers.delete(name),
        }
        // A global plugin set up earlier adds a server, as @upstash/context7-opencode does.
        if (options.pluginMcp)
          editor.set("context7", { type: "remote", url: "https://mcp.invalid/mcp" })
        for (const transform of mcpTransforms) transform(editor)
        // Added after every transform, so the fail-closed inventory tests still see a server.
        if (options.mcpServers === true || (options.mcpServers === "after-first" && mcpLists > 1))
          servers.set("fixture", { type: "remote", url: "https://fixture.invalid/mcp" })
        return { location: input.location, data: [...servers.keys()].map((name) => ({ name })) }
      },
    },
    session: {
      create: async (input: {
        id: string
        location: { directory: string }
        permissions: unknown[]
      }) => {
        sessionID = input.id
        sessionIDs.push(sessionID)
        expect(input.permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" })
        return {
          id: sessionID,
          location: { directory: options.wrongLocation ? "/workspace/operational" : directory },
        }
      },
      prompt: async ({ sessionID: current }: { sessionID: string }) => {
        prompts++
        const event: ContextEvent = {
          sessionID: current,
          system: ["UNTRUSTED_SYSTEM"],
          messages: ["UNTRUSTED_HISTORY"],
          tools: { permission_reviewer_result: tool, shell: {} },
        }
        contextHook(event)
        messagesBySession.set(current, JSON.stringify(event.messages))
        expect(JSON.stringify(event.system)).not.toContain("UNTRUSTED_SYSTEM")
        expect(JSON.stringify(event.messages)).not.toContain("UNTRUSTED_HISTORY")
        expect(event.tools.shell).toBeUndefined()
        expect(() => toolHook({ sessionID: current, tool: "shell" })).toThrow("Operational tools")
        if (options.format !== "text" && !options.invalid) {
          await tool.execute(tool.input.parse(decision("allow")), { sessionID: current })
          if (options.ambiguous)
            await expect(tool.execute(decision("deny"), { sessionID: current })).rejects.toThrow(
              "ambiguous",
            )
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
      remove: async ({ sessionID: current }: { sessionID: string }) => {
        removed.add(current)
      },
      get: async ({ sessionID: current }: { sessionID: string }) => {
        if (removed.has(current)) throw { _tag: "SessionNotFoundError" }
        return { id: current }
      },
    },
  } as unknown as OpenCodeClient
  const backend = new V2ReviewerBackend(
    ctx,
    config({
      model: "fixture/reviewer",
      variant: options.variant ?? "max",
      outputFormat: options.format ?? "json_schema",
      retainReviewSessions: options.retain ?? false,
    }),
  )
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
    run: (command = "Run printf safe") => {
      const attempt = new ReviewAttempt("generation_fixture", 5000)
      attempts.push(attempt)
      return backend.review(
        { ...envelope, transcript: command, intentHistory: command },
        attempt,
        client,
      )
    },
    state: () => ({
      directory,
      directories: [...directories],
      sessionID,
      sessionIDs,
      removed: removed.has(sessionID),
      messagesBySession,
      prompts,
      mcpLists,
      mcpTransforms: mcpTransforms.length,
      disposed,
      setups,
    }),
    mcp: async () => (await client.mcp.list({ location: { directory } })).data,
    reload: async () => {
      await hostCleanup?.()
      await Promise.all(scope.splice(0).map((handle) => handle.dispose()))
      const plugin = await import(pathToFileURL(directory + "/index.js").href)
      hostCleanup = await plugin.default.setup({ ...ctx, location: { directory } })
      setups++
    },
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
      for (const attempt of attempts) attempt.close("cancelled")
      await backend.dispose()
      for (const path of directories) if (existsSync(path)) await rm(path, { recursive: true })
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
      expect(state.disposed).toBe(0)
      expect(harness.backend.owns(state.sessionID)).toBe(false)
      expect(existsSync(state.directory + "/index.js")).toBe(true)
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

test("a failed isolation bootstrap is retried in a new location", async () => {
  const harness = fixture({ failFirstActivation: true })
  try {
    const first = await harness.run()
    expect(first.kind).toBe("escalate")
    expect(first.reason).toContain("failed to activate")
    expect(harness.state().directories).toHaveLength(1)
    expect(harness.state().disposed).toBe(3)
    const failedDirectory = harness.state().directory

    expect((await harness.run()).kind).toBe("allow")
    const recovered = harness.state()
    expect(recovered.setups).toBe(2)
    expect(recovered.disposed).toBe(3)
    expect(recovered.directories).toHaveLength(2)
    expect(recovered.directory).not.toBe(failedDirectory)
    expect(existsSync(failedDirectory + "/opencode.json")).toBe(true)
  } finally {
    await harness.cleanup()
  }
})

test("backend disposal releases hooks registered by a later location activation", async () => {
  const harness = fixture()
  try {
    expect((await harness.run()).kind).toBe("allow")
    await harness.reload()
    expect(harness.state().disposed).toBe(3)
    expect((await harness.run()).kind).toBe("allow")
    await harness.backend.dispose()
    expect(harness.state().disposed).toBe(6)
    expect(existsSync(harness.state().directory + "/opencode.json")).toBe(true)
  } finally {
    await harness.cleanup()
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
      expect(existsSync(harness.state().directory + "/opencode.json")).toBe(true)
    } finally {
      await harness.cleanup()
    }
  }
})

test("review sessions share one MCP-free location without mixing concurrent evidence", async () => {
  const harness = fixture()
  try {
    const commands = Array.from({ length: 16 }, (_, index) => `Review unique marker[${index}]`)
    const results = await Promise.all(commands.map((command) => harness.run(command)))
    expect(results.every((result) => result.kind === "allow")).toBe(true)
    const state = harness.state()
    expect(state.setups).toBe(1)
    expect(new Set(state.sessionIDs).size).toBe(commands.length)
    const captured = state.sessionIDs.map((id) => state.messagesBySession.get(id) ?? "")
    const markers = captured.map((message) => {
      const matches = commands.filter((command) => message.includes(command))
      expect(matches).toHaveLength(1)
      return matches[0]
    })
    expect(new Set(markers)).toEqual(new Set(commands))
    const isolatedConfig = JSON.parse(await readFile(state.directory + "/opencode.json", "utf8"))
    expect(isolatedConfig.plugins).toEqual(["-opencode.config.mcp", state.directory])
    expect((await harness.run("Review one more unique marker")).kind).toBe("allow")
    expect(harness.state().directory).toBe(state.directory)
    expect(harness.state().setups).toBe(1)
    await harness.backend.dispose()
    expect(harness.state().disposed).toBe(3)
    expect(existsSync(state.directory + "/opencode.json")).toBe(true)
    expect(() => harness.run()).toThrow("shutting down")
  } finally {
    await harness.cleanup()
  }
})

test("reviewer fails closed when its isolated location contains MCP servers", async () => {
  const harness = fixture({ mcpServers: true })
  try {
    const result = await harness.run()
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("contains MCP servers")
    expect(harness.state().sessionIDs).toHaveLength(0)
  } finally {
    await harness.cleanup()
  }
})

test("a later MCP addition prevents another review in the shared location", async () => {
  const harness = fixture({ mcpServers: "after-first" })
  try {
    expect((await harness.run()).kind).toBe("allow")
    const result = await harness.run()
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("contains MCP servers")
    expect(harness.state().sessionIDs).toHaveLength(1)
    expect(harness.state().mcpLists).toBe(2)
  } finally {
    await harness.cleanup()
  }
})

test("plugin-added MCP servers are stripped from the isolated location", async () => {
  const harness = fixture({ pluginMcp: true })
  try {
    const result = await harness.run()
    expect(result.kind).toBe("allow")
    expect(result.decisionSource).toBe("llm-reviewer")
    expect(harness.state().mcpTransforms).toBe(1)
    expect(harness.state().sessionIDs).toHaveLength(1)
  } finally {
    await harness.cleanup()
  }
})

test("an inert bootstrap reload keeps stripping MCP after the backend releases it", async () => {
  const harness = fixture({ pluginMcp: true })
  try {
    expect((await harness.run()).kind).toBe("allow")
    await harness.backend.dispose()
    await harness.reload()
    expect(harness.state().mcpTransforms).toBe(1)
    expect(await harness.mcp()).toEqual([])
  } finally {
    await harness.cleanup()
  }
})
