import { beforeAll, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import type { ReviewAuditRecord } from "../src/types.ts"
import { DEFAULT_CONFIG } from "../src/config.ts"
import { decision, MockClient, request, runtime } from "./helpers.ts"

beforeAll(async () => {
  await mkdir("/tmp/opencode", { recursive: true })
})

describe("characterization gaps (baseline prereq)", () => {
  test("session.create transport failure escalates without reviewer call", async () => {
    const client = new MockClient()
    client.createError = { message: "database unavailable" }
    const harness = runtime(client)
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("session.create failed")
    expect(client.creates).toHaveLength(1)
    expect(client.prompts).toHaveLength(0)
    expect(client.replies).toHaveLength(0)
    expect(client.deletes).toHaveLength(0)
    expect(client.uiStatuses.map((s) => s.phase)).toEqual(["reviewing", "manual"])
  })

  test("session.create failure via handle emits manual", async () => {
    const client = new MockClient()
    client.createError = { message: "create failed" }
    const harness = runtime(client)
    harness.runtime.handle(request())
    await harness.runtime.waitForIdle()
    expect(client.uiStatuses.map((s) => s.phase)).toEqual(["reviewing", "manual"])
    expect(client.replies).toHaveLength(0)
  })

  test("tool.ids transport failure escalates and still cleans up the review session", async () => {
    const client = new MockClient()
    client.toolIdsError = { message: "tool discovery failed" }
    const harness = runtime(client)
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("tool.ids failed")
    expect(client.creates).toHaveLength(1)
    expect(client.prompts).toHaveLength(0)
    expect(client.replies).toHaveLength(0)
    // runReviewer finally deletes the session even when tool.ids failed (reviewSessionID was set)
    expect(client.deletes).toHaveLength(1)
  })

  test("retainReviewSessions true keeps the review session on disk", async () => {
    const client = new MockClient()
    const harness = runtime(client, { retainReviewSessions: true })
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("allow")
    expect(client.deletes).toHaveLength(0)
    expect(client.creates).toHaveLength(1)
  })

  test("retainReviewSessions false deletes the review session (default)", async () => {
    const client = new MockClient()
    const harness = runtime(client, { retainReviewSessions: false })
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("allow")
    expect(client.deletes).toHaveLength(1)
  })

  test("publishUiStatus returning {error} does not change the safety decision", async () => {
    const client = new MockClient()
    // Return an error response (not a throw) — emit() must ignore it and still allow.
    client.publishStatusError = { message: "publish failed" }
    const result = await runtime(client).runtime.process(request())
    expect(result.kind).toBe("allow")
    expect(client.replies).toHaveLength(1)
    // Both reviewing + approved phases are still emitted; error response is swallowed.
    expect(client.uiStatuses.map((s) => s.phase)).toEqual(["reviewing", "approved"])
  })

  test("publishUiStatus throwing is also fail-safe (existing guarantee, explicit)", async () => {
    const client = new MockClient()
    client.publishUiStatus = async (status) => {
      client.uiStatuses.push(status)
      throw new Error("no TUI attached")
    }
    const result = await runtime(client).runtime.process(request())
    expect(result.kind).toBe("allow")
    expect(client.replies).toHaveLength(1)
  })

  test("session.prompt transport error escalates", async () => {
    const client = new MockClient()
    client.promptError = { message: "model unavailable" }
    const harness = runtime(client)
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("session.prompt failed")
    expect(client.replies).toHaveLength(0)
    expect(client.deletes).toHaveLength(1)
  })

  test("session.prompt missing data escalates (response.data undefined path)", async () => {
    const client = new MockClient()
    // Force session.prompt to return { data: undefined } — responseData will throw "returned no data"
    client.promptImpl = async (options) => {
      client.prompts.push(options)
      return { data: undefined as unknown as Record<string, unknown> }
    }
    const result = await runtime(client).runtime.process(request())
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("session.prompt")
    expect(client.replies).toHaveLength(0)
  })

  test("session.prompt with no structured field escalates as invalid output", async () => {
    const client = new MockClient()
    client.promptImpl = async (options) => {
      client.prompts.push(options)
      return { data: { info: {} } }
    }
    const result = await runtime(client).runtime.process(request())
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("missing or invalid structured output")
    expect(client.replies).toHaveLength(0)
  })

  test("session.prompt with info missing entirely escalates as invalid output", async () => {
    const client = new MockClient()
    client.promptImpl = async (options) => {
      client.prompts.push(options)
      return { data: {} }
    }
    const result = await runtime(client).runtime.process(request())
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("missing or invalid structured output")
  })

  test("session.create returning non-string id escalates and does not leak session", async () => {
    const client = new MockClient()
    // Override to return a numeric id.
    client.session.create = async (options: unknown) => {
      client.creates.push(options)
      return { data: { id: 123 as unknown as string } }
    }
    const result = await runtime(client).runtime.process(request())
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("session.create returned an invalid session ID")
    expect(client.deletes).toHaveLength(0)
    expect(client.prompts).toHaveLength(0)
    expect(client.replies).toHaveLength(0)
  })

  test("session.create returning undefined id escalates", async () => {
    const client = new MockClient()
    client.session.create = async (options: unknown) => {
      client.creates.push(options)
      return { data: {} as Record<string, unknown> }
    }
    const result = await runtime(client).runtime.process(request())
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("invalid session ID")
  })

  test("tool.ids failure via direct override still escalates", async () => {
    const client = new MockClient()
    client.tool.ids = async (options?: unknown) => {
      client.toolQueries.push(options)
      return { error: { message: "tool discovery broken" } }
    }
    const result = await runtime(client).runtime.process(request())
    expect(result.kind).toBe("escalate")
    expect(result.reason).toMatch(/tool\.ids failed/i)
  })

  test("invalid structured output variants escalate (null, string)", async () => {
    for (const bad of [null, "not an object", 123, { outcome: "allow" }]) {
      const client = new MockClient()
      client.nextStructured = bad
      const result = await runtime(client).runtime.process(request())
      expect(result.kind).toBe("escalate")
      expect(client.replies).toHaveLength(0)
    }
  })

  test("text mode with a response lacking text parts escalates", async () => {
    const client = new MockClient()
    client.promptImpl = async () => ({ data: { info: { id: "msg_review", role: "assistant" } } })
    const result = await runtime(client, { outputFormat: "text" }).runtime.process(request())
    expect(result.kind).toBe("escalate")
    expect(result.reason).toMatch(/unparseable text output/i)
    expect(client.replies).toHaveLength(0)
  })

  test("low structured output still cleans up review session", async () => {
    const client = new MockClient()
    client.nextStructured = decision("allow", { confidence: 0.1 })
    const harness = runtime(client)
    const result = await harness.runtime.process(request())
    expect(result.kind).toBe("escalate")
    // Review session is still deleted on escalate path.
    expect(client.deletes).toHaveLength(1)
  })

  test("audit on the error path still carries the ssh summary after collectEnvelope ran", async () => {
    // collectEnvelope runs and populates the ssh bridge; afterwards safeReply
    // throws (non-404 transport failure), so process() rejects and the catch
    // branch writes an audit. That audit must still include the ssh summary —
    // parity we must preserve when the coordinator moves.
    const client = new MockClient()
    client.replyError = { message: "permission transport down" }
    const harness = runtime(client)
    await expect(
      harness.runtime.process(
        request({
          metadata: { command: "ssh -p 2222 ubuntu@203.0.113.8 'docker ps'" },
          patterns: ["ssh -p 2222 ubuntu@203.0.113.8 'docker ps'"],
        }),
      ),
    ).rejects.toThrow("permission.reply failed")
    const audits = (harness.ctx as unknown as { auditRecords: unknown[] }).auditRecords
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      outcome: "escalate",
      schemaVersion: 2,
      decisionSource: "failure-safe",
      ssh: [{ destination: "ubuntu@203.0.113.8", port: "2222" }],
    })
  })

  test("audit records carry schemaVersion 2 and the v2 fields on the success path", async () => {
    const harness = runtime()
    await harness.runtime.process(request())
    const audits = (harness.ctx as unknown as { auditRecords: ReviewAuditRecord[] }).auditRecords
    expect(audits).toHaveLength(1)
    expect(audits[0]!.schemaVersion).toBe(2)
    expect(audits[0]!.decisionSchemaVersion).toBe(2)
    expect(audits[0]!.promptVersion).toBe("2.2.0")
    expect(audits[0]!.decisionSource).toBe("llm-reviewer")
    expect(audits[0]!.actionHash).toMatch(/^[0-9a-f]{64}$/)
    expect(audits[0]!.scopeAlignment).toBe("aligned")
    expect(audits[0]!.reviewerModel).toBe(DEFAULT_CONFIG.model)
    expect(audits[0]!.timings).toBeDefined()
    expect(audits[0]!.timings?.reviewerMs).toBeGreaterThanOrEqual(0)
  })
})

describe("actor-aware context threading", () => {
  test("audit record carries the resolved actor and root session", async () => {
    const client = new MockClient()
    // Assistant message that issued the tool call carries agent/mode; the
    // resolver reads them and records a confirmed actor in the audit record.
    client.messageData = [
      {
        info: { id: "msg_1", role: "assistant", agent: "build", mode: "build" },
        parts: [
          {
            type: "tool",
            tool: "bash",
            callID: "call_1",
            state: { input: { command: "printf safe" } },
          },
        ],
      },
    ]
    const harness = runtime(client)
    await harness.runtime.process(request())
    const audits = (harness.ctx as unknown as { auditRecords: ReviewAuditRecord[] }).auditRecords
    expect(audits).toHaveLength(1)
    expect(audits[0]!.actor).toMatchObject({
      name: "build",
      mode: "build",
      identityCompleteness: "complete",
    })
    expect(audits[0]!.rootSessionID).toBe("ses_main")
  })

  test("reviewer prompt includes actor and lineage evidence sections", async () => {
    const client = new MockClient()
    client.messageData = [
      {
        info: { id: "msg_1", role: "assistant", agent: "build", mode: "build" },
        parts: [
          {
            type: "tool",
            tool: "bash",
            callID: "call_1",
            state: { input: { command: "printf safe" } },
          },
        ],
      },
    ]
    const harness = runtime(client)
    await harness.runtime.process(request())
    const prompt = JSON.stringify(client.prompts[0])
    expect(prompt).toContain("ACTOR_CONTEXT")
    expect(prompt).toContain("SESSION_LINEAGE")
    expect(prompt).toContain("DIRECT_USER_INTENT")
    expect(prompt).toContain("DELEGATED_TASK")
  })

  test("unknown actor still produces an audit record without an actor name", async () => {
    // No agent/mode on the assistant message and no session.get on the mock.
    const harness = runtime()
    await harness.runtime.process(request())
    const audits = (harness.ctx as unknown as { auditRecords: ReviewAuditRecord[] }).auditRecords
    expect(audits).toHaveLength(1)
    expect(audits[0]!.actor).toMatchObject({
      profile: "unknown",
      identityCompleteness: "unknown",
    })
    expect(audits[0]!.actor).not.toHaveProperty("name")
  })

  test("capability assessment reaches the reviewer prompt for bash requests", async () => {
    const client = new MockClient()
    client.messageData = [
      {
        id: "msg_assistant",
        role: "assistant",
        agent: "build",
        mode: "build",
        parts: [{ type: "tool", tool: "bash", callID: "call_1" }],
      },
    ]
    const harness = runtime(client)
    await harness.runtime.process(
      request({
        permission: "bash",
        tool: { messageID: "msg_assistant", callID: "call_1" },
        metadata: { command: "pip install requests && curl http://example.com" },
      }),
    )
    const prompt = JSON.stringify(client.prompts[0])
    expect(prompt).toContain("CAPABILITY_ASSESSMENT")
    expect(prompt).toContain("package lifecycle scripts")
    expect(prompt).toContain("network")
  })

  test("capability summary reaches the audit record for bash requests", async () => {
    const harness = runtime()
    await harness.runtime.process(
      request({
        permission: "bash",
        metadata: { command: "rm -rf /tmp/scratch" },
      }),
    )
    const audits = (harness.ctx as unknown as { auditRecords: ReviewAuditRecord[] }).auditRecords
    expect(audits).toHaveLength(1)
    expect(audits[0]!.capability).toMatchObject({
      actionClass: "destruction",
      parserCompleteness: "complete-for-supported-form",
    })
    expect(audits[0]!.capability!.writeEffects).toMatchObject({ deletion: true })
  })

  test("capability is absent for non-bash permissions", async () => {
    const harness = runtime()
    await harness.runtime.process(request({ permission: "edit" }))
    const audits = (harness.ctx as unknown as { auditRecords: ReviewAuditRecord[] }).auditRecords
    expect(audits).toHaveLength(1)
    expect(audits[0]!.capability).toBeUndefined()
  })

  test("policy trace appears in audit records for bash requests", async () => {
    const harness = runtime()
    await harness.runtime.process(
      request({ permission: "bash", metadata: { command: "echo hello" } }),
    )
    const audits = (harness.ctx as unknown as { auditRecords: ReviewAuditRecord[] }).auditRecords
    expect(audits).toHaveLength(1)
    expect(audits[0]!.policyTrace).toMatchObject({
      finalRoute: "review",
      mode: "observe",
    })
    expect(audits[0]!.policyTrace!.effectivePolicyHash).toHaveLength(16)
  })

  test("enforce mode with a deny rule skips the LLM and returns deny", async () => {
    const client = new MockClient()
    client.nextStructured = decision("allow")
    const harness = runtime(client, {
      enforcementMode: "enforce",
      policyRules: [
        {
          id: "deny-all-bash",
          source: "global",
          when: { actionClass: ["read-only"] },
          effect: "deny",
          reason: "test deny rule",
        },
      ],
    })
    const result = await harness.runtime.process(
      request({ permission: "bash", metadata: { command: "echo safe" } }),
    )
    expect(result.kind).toBe("deny")
    expect(result.reason).toContain("Declarative policy route: deny")
    // No LLM call should have been made.
    expect(client.prompts).toHaveLength(0)
  })

  test("enforce mode with a manual rule skips the LLM and escalates", async () => {
    const client = new MockClient()
    const harness = runtime(client, {
      enforcementMode: "enforce",
      policyRules: [
        {
          id: "manual-bash",
          source: "global",
          when: { actionClass: ["read-only"] },
          effect: "manual",
          reason: "test manual rule",
        },
      ],
    })
    const result = await harness.runtime.process(
      request({ permission: "bash", metadata: { command: "echo safe" } }),
    )
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("Declarative policy route: manual")
    expect(client.prompts).toHaveLength(0)
  })

  test("enforce mode with a review route proceeds to the LLM normally", async () => {
    const client = new MockClient()
    client.nextStructured = decision("allow")
    const harness = runtime(client, {
      enforcementMode: "enforce",
      policyRules: [
        {
          id: "deny-destruction",
          source: "global",
          when: { actionClass: ["destruction"] },
          effect: "deny",
          reason: "deny destruction",
        },
      ],
    })
    // "echo safe" is read-only, so the deny rule does not match → proceeds to LLM.
    const result = await harness.runtime.process(
      request({ permission: "bash", metadata: { command: "echo safe" } }),
    )
    expect(client.prompts).toHaveLength(1)
    expect(result.kind).toBe("allow")
  })

  test("malformed policy rule (non-array when.actionClass) is dropped, not crashed", async () => {
    const client = new MockClient()
    client.nextStructured = decision("allow")
    const harness = runtime(client, {
      policyRules: [
        {
          id: "bad-rule",
          source: "global",
          when: { actionClass: 42 } as unknown as Record<string, unknown>,
          effect: "deny",
          reason: "should be dropped",
        },
      ],
    })
    const result = await harness.runtime.process(
      request({ permission: "bash", metadata: { command: "echo safe" } }),
    )
    // The malformed rule was dropped; review proceeds normally.
    expect(client.prompts).toHaveLength(1)
    expect(result.kind).toBe("allow")
  })
})
