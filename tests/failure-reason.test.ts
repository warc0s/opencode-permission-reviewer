import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import { formatFailureReason } from "../src/failure-reason.ts"
import { V2ReviewerBackend } from "../src/opencode/v2/reviewer-backend.ts"
import { setupWithServices } from "../src/opencode/v2/server.ts"
import { normalizeV2Permission } from "../src/opencode/v2/permission-codec.ts"
import { ReviewAttempt } from "../src/core/review-attempt.ts"
import type { ReviewEnvelope } from "../src/types.ts"
import { MockClient, config, request, runtime } from "./helpers.ts"

type V2Context = Parameters<Plugin.Plugin["setup"]>[0]
type V2Input = Parameters<typeof normalizeV2Permission>[0] & { message?: string }

function clientError(): Error {
  const cause = new Error("socket hang up")
  const error = new Error("Transport") as Error & { reason?: string }
  error.name = "ClientError"
  error.reason = "Transport"
  error.cause = cause
  return error
}

test("helper keeps phase, name, reason, message, and cause", () => {
  const reason = formatFailureReason("reviewer backend", clientError())
  expect(reason).toContain("reviewer backend")
  expect(reason).toContain("ClientError")
  expect(reason).toContain("reason=Transport")
  expect(reason).toContain("Transport")
  expect(reason).toContain("socket hang up")
  expect(reason.startsWith("reviewer backend failed (ClientError")).toBe(true)
})

test("helper handles plain errors and non-error throws", () => {
  const plain = formatFailureReason("review coordination", new Error("boom"))
  expect(plain).toContain("review coordination")
  expect(plain).toContain("boom")
  expect(plain).not.toContain("reason=")

  const thrown = formatFailureReason("review coordination", "string failure")
  expect(thrown).toContain("review coordination")
  expect(thrown).toContain("string failure")

  const empty = formatFailureReason("review coordination", undefined)
  expect(empty).toContain("review coordination")
})

test("helper caps cause depth and total length and never throws", () => {
  const level3 = new Error("level three")
  const level2 = new Error("level two") as Error & { cause?: unknown }
  level2.cause = level3
  const level1 = new Error("level one") as Error & { cause?: unknown }
  level1.cause = level2
  const top = new Error("top") as Error & { cause?: unknown }
  top.name = "ClientError"
  top.cause = level1
  const reason = formatFailureReason("reviewer backend", top)
  expect(reason).toContain("level one")
  expect(reason).toContain("level two")
  expect(reason).not.toContain("level three")

  const long = formatFailureReason("reviewer backend", new Error("x".repeat(2000)))
  expect(long.length).toBeLessThanOrEqual(500)
  expect(long.endsWith("...")).toBe(true)

  const evil = {
    get name(): string {
      throw new Error("bad name")
    },
    get message(): string {
      throw new Error("bad message")
    },
  }
  expect(() => formatFailureReason("reviewer backend", evil as unknown as Error)).not.toThrow()
  const fallback = formatFailureReason("reviewer backend", evil as unknown as Error)
  expect(typeof fallback).toBe("string")
  expect(fallback).toContain("reviewer backend")
})

test("v1 reviewer backend failure keeps deny and failure-safe with cause", async () => {
  const client = new MockClient()
  client.promptImpl = async () => {
    throw clientError()
  }
  const harness = runtime(client, { escalationMode: "deny" })
  try {
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("deny")
    expect(result.decisionSource).toBe("failure-safe")
    expect(result.reason).toContain("reviewer backend")
    expect(result.reason).toContain("ClientError")
    expect(result.reason).toContain("socket hang up")
    expect(result.reviewerOutcome).toBeUndefined()
    expect(result.decision).toBeUndefined()
  } finally {
    await harness.runtime.dispose()
  }
})

test("review coordination failure audits deny with phase and cause", async () => {
  const client = new MockClient()
  client.messagesImpl = async () => {
    throw clientError()
  }
  const harness = runtime(client, { escalationMode: "deny" })
  try {
    await expect(harness.runtime.process(request())).rejects.toThrow("Transport")
    const audits = (harness.ctx as unknown as { auditRecords: Array<Record<string, unknown>> })
      .auditRecords
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ outcome: "deny", decisionSource: "failure-safe" })
    const reason = audits[0]!["reason"] as string
    expect(reason).toContain("review coordination")
    expect(reason).toContain("ClientError")
    expect(reason).toContain("socket hang up")
  } finally {
    await harness.runtime.dispose()
  }
})

test("v2 reviewer session call failure keeps deny and failure-safe with cause", async () => {
  const ctx = {} as unknown as V2Context
  const backend = new V2ReviewerBackend(
    ctx,
    config({ model: "fixture/reviewer", escalationMode: "deny" }),
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
  const client = {
    plugin: {
      awaitActivation: async () => {
        throw clientError()
      },
    },
    model: { list: async () => ({ data: [] }) },
    session: {
      create: async () => ({ id: "ses_never", location: { directory: "/tmp/never" } }),
      prompt: async () => ({ id: "inbox_never" }),
      wait: async () => {},
      context: async () => [],
      interrupt: async () => {},
      remove: async () => {},
      get: async () => {
        throw { _tag: "SessionNotFoundError" }
      },
    },
  } as unknown as OpenCodeClient
  try {
    const result = await backend.review(envelope, attempt, client)
    expect(result.kind).toBe("deny")
    expect(result.decisionSource).toBe("failure-safe")
    expect(result.reason).toContain("reviewer session call")
    expect(result.reason).toContain("ClientError")
    expect(result.reason).toContain("socket hang up")
  } finally {
    attempt.close("cancelled")
    await backend.waitForIdle()
  }
})

test("v2 permission review hook failure denies with phase and cause", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reviewer-hook-failure-"))
  const auditPath = join(directory, "audit.jsonl")
  let evaluate!: (input: V2Input) => Promise<void>
  let resume: (() => void) | undefined
  let ended = false
  const events: OpenCodeEvent[] = []
  const ctx = {
    app: { version: "2.0.3" },
    options: {},
    location: { directory, project: { directory } },
    rpc: {
      register: async () => ({ events: { emit: async () => {} } }),
    },
    tool: { hook: async () => {} },
    permission: {
      hook: async (_name: string, callback: typeof evaluate) => {
        evaluate = callback
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        location: { directory },
        time: { created: 1 },
      }),
    },
    event: {
      subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        const wake = () => resume?.()
        signal.addEventListener("abort", wake)
        try {
          while (!signal.aborted && !ended) {
            if (events.length) yield events.shift()!
            else
              await new Promise<void>((resolve) => {
                resume = resolve
              })
          }
        } finally {
          signal.removeEventListener("abort", wake)
        }
      },
    },
  } as unknown as Parameters<typeof setupWithServices>[0]
  const client = {
    session: {
      get: ctx.session.get,
      context: async () => [
        { type: "user", id: "msg_user", text: "Run printf safe", time: { created: 2 } },
      ],
    },
  } as unknown as OpenCodeClient
  const dispose = await setupWithServices(ctx, {
    loadConfig: () =>
      config({ audit: true, auditPath, escalationMode: "deny", reviewBudgetMs: 5000 }),
    connect: async () => client,
    createBackend: () => ({
      owns: () => false,
      waitForIdle: async () => {},
      review: async () => {
        throw clientError()
      },
    }),
  })
  try {
    const input: V2Input = {
      action: "shell",
      resources: ["printf *"],
      metadata: { command: "printf safe" },
      sessionID: "ses_main",
      effect: "ask",
    }
    await evaluate(input)
    expect(input.effect).toBe("deny")
    expect(input.message).toContain("permission review hook")
    expect(input.message).toContain("ClientError")
    expect(input.message).toContain("socket hang up")
    ended = true
    resume?.()
    await dispose()
    const records = (await readFile(auditPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ outcome: "deny", decisionSource: "failure-safe" })
    expect(String(records[0]!["reason"])).toContain("permission review hook")
    expect(String(records[0]!["reason"])).toContain("ClientError")
    expect(String(records[0]!["reason"])).toContain("socket hang up")
  } finally {
    ended = true
    resume?.()
    await dispose().catch(() => {})
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
})
