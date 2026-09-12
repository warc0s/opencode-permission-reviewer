/** Run manually with `bun tests/live-host-regressions.ts` after building.
 * Uses a fresh OpenCode host and a local deterministic provider to inspect the
 * actual provider request after host tool filtering, without paid inference. */
import { strict as assert } from "node:assert"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { ApprovalReviewerRuntime, resolveConfig, loadResolvedConfig } from "../dist/index.js"
import { probeCapabilities } from "../src/opencode/capability-detection.ts"
import { decision, request } from "./helpers.ts"
import type { OpenCodeClientLike } from "../src/opencode/types.ts"

const root = await mkdtemp(join(tmpdir(), "reviewer-host-regression-"))
// Unique directory for the host output so concurrent runs never share a path.
const logDirectory = await mkdtemp(join(tmpdir(), "reviewer-host-regression-log-"))
const captured: Array<{ tools?: Array<{ function: { name: string } }>; messages: unknown }> = []
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as (typeof captured)[number] & { stream?: boolean }
    captured.push(body)
    const tool = body.tools?.find((tool) => tool.function.name === "StructuredOutput")
    const delta = tool
      ? {
          tool_calls: [
            {
              index: 0,
              id: "call_structured",
              type: "function",
              function: { name: "StructuredOutput", arguments: JSON.stringify(decision("allow")) },
            },
          ],
        }
      : { content: JSON.stringify(decision("allow")) }
    const chunk = (delta: unknown, finish_reason: string | null) => ({
      id: "completion_synthetic",
      object: "chat.completion.chunk",
      created: 1,
      model: "reviewer",
      choices: [{ index: 0, delta, finish_reason }],
    })
    return new Response(
      [chunk(delta, null), chunk({}, tool ? "tool_calls" : "stop")]
        .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
        .join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
const configHome = join(root, "config")
await mkdir(join(configHome, "opencode"), { recursive: true })
const project = join(root, "project")
await mkdir(project)
// A real stdio MCP tool, outside the host's built-in tool registry.
const mcpPath = join(root, "mcp.ts")
await writeFile(
  mcpPath,
  `import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  const r = JSON.parse(line); if (r.id === undefined) continue;
  const result = r.method === "initialize" ? {protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"synthetic",version:"1"}} : r.method === "tools/list" ? {tools:[{name:"demo",description:"Synthetic operational tool",inputSchema:{type:"object",properties:{}}}]} : {};
  console.log(JSON.stringify({jsonrpc:"2.0",id:r.id,result}));
}`,
)
await writeFile(
  join(configHome, "opencode", "opencode.json"),
  JSON.stringify({
    provider: {
      synthetic: {
        npm: "@ai-sdk/openai-compatible",
        name: "Synthetic provider",
        options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "synthetic" },
        models: { reviewer: { name: "reviewer", limit: { context: 100000, output: 4096 } } },
      },
    },
    model: "synthetic/reviewer",
    small_model: "synthetic/reviewer",
    permission: "allow",
    mcp: { synthetic: { type: "local", command: ["bun", mcpPath], enabled: true } },
  }),
)
const portReservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
const port = portReservation.port
portReservation.stop(true)
const host = Bun.spawn(["opencode", "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: project,
  env: {
    ...process.env,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    OPENCODE_CONFIG: join(configHome, "opencode", "opencode.json"),
    OPENCODE_CONFIG_CONTENT: "{}",
    OPENCODE_SERVER_PASSWORD: "",
  },
  stdout: "pipe",
  stderr: "pipe",
})
const stdout = new Response(host.stdout).text()
const stderr = new Response(host.stderr).text()
try {
  const baseUrl = `http://127.0.0.1:${port}`
  let ready = false
  for (let attempt = 0; attempt < 200; attempt++) {
    ready = await fetch(`${baseUrl}/global/health`, { signal: AbortSignal.timeout(1000) })
      .then((r) => r.ok)
      .catch(() => false)
    if (ready) break
    await Bun.sleep(100)
  }
  assert(ready, "fresh host did not start")
  const sdk = createOpencodeClient({
    baseUrl,
    fetch: (req) => fetch(req, { signal: AbortSignal.timeout(45000) }),
  })
  const session = await sdk.session.create({
    query: { directory: project },
    body: { title: "Synthetic requester" },
  })
  assert(session.data?.id)
  const client: OpenCodeClientLike = {
    session: {
      create: sdk.session.create.bind(sdk.session),
      get: sdk.session.get.bind(sdk.session),
      messages: sdk.session.messages.bind(sdk.session),
      prompt: sdk.session.prompt.bind(sdk.session),
      delete: sdk.session.delete.bind(sdk.session),
    },
    tool: { ids: sdk.tool.ids.bind(sdk.tool) },
  } as OpenCodeClientLike
  const replies: unknown[] = []
  const config = resolveConfig({ model: "synthetic/reviewer", timeoutMs: 30000, audit: false })
  const ctx = {
    client,
    directory: project,
    worktree: project,
    reviewerDirectoryBase: join(root, "isolated"),
    capabilities: probeCapabilities(client),
    permissionReply: async (reply: unknown) => {
      replies.push(reply)
      return { data: true }
    },
  }
  const run = async (overrides = {}, context = ctx, command = "printf safe") => {
    replies.length = 0
    return new ApprovalReviewerRuntime(context, { ...config, ...overrides }, undefined, []).process(
      request({ sessionID: session.data!.id, metadata: { command }, patterns: [command] }),
    )
  }
  const result = await run()
  assert.equal(result.kind, "allow")
  assert.equal(replies.length, 1)
  const reviewRequests = captured.filter((r) =>
    JSON.stringify(r.messages).includes("PENDING_PERMISSION"),
  )
  assert(reviewRequests.length > 0)
  for (const r of reviewRequests)
    assert.deepEqual(
      r.tools?.map((t) => t.function.name),
      ["StructuredOutput"],
    )
  const mcp = (await fetch(
    `${baseUrl}/mcp?directory=${encodeURIComponent(ctx.reviewerDirectoryBase)}`,
  ).then((r) => r.json())) as Record<string, { status: string }>
  assert.equal(
    mcp.synthetic?.status,
    "connected",
    "MCP must be available before reviewer tool filtering",
  )

  const textResult = await run({ outputFormat: "text" })
  assert.equal(textResult.kind, "allow")
  assert.equal(captured.at(-1)?.tools?.length ?? 0, 0)
  const beforeFailure = captured.length
  const refused = {
    ...client,
    session: { ...client.session, create: async () => ({ error: "isolated directory refused" }) },
  } as OpenCodeClientLike
  assert.equal((await run({}, { ...ctx, client: refused })).kind, "escalate")
  assert.equal(replies.length, 0)
  await writeFile(join(root, "file"), "not a directory")
  assert.equal(
    (await run({}, { ...ctx, reviewerDirectoryBase: join(root, "file", "child") })).kind,
    "escalate",
  )
  assert.equal(replies.length, 0)
  assert.equal(captured.length, beforeFailure)
  assert.equal((await run({}, ctx, `printf '${"x".repeat(18000)}'`)).kind, "escalate")
  assert.equal(replies.length, 0)
  const configInvalid = loadResolvedConfig({ policyRules: { effect: "deny" } })
  assert.equal((await run({ configDegraded: configInvalid.configDegraded })).kind, "escalate")
  assert.equal(replies.length, 0)
  const largeMessages = [1, 2, 3].map((id) => ({
    info: { id: `user_${id}`, role: "user" },
    parts: [{ type: "text", text: "a".repeat(7900) }],
  }))
  const withMessages = {
    ...client,
    session: { ...client.session, messages: async () => ({ data: largeMessages }) },
  }
  assert.equal(
    (
      await run(
        {
          maxPartChars: 8000,
          maxContextChars: 4000,
          maxEnrichmentChars: 1000,
          maxIntentChars: 1000,
        },
        { ...ctx, client: withMessages },
      )
    ).kind,
    "allow",
  )
  assert(JSON.stringify(captured.at(-1)?.messages).includes("printf safe"))
  for (const origin of ["delegated", "unknown"]) {
    const child = {
      ...withMessages,
      session: {
        ...withMessages.session,
        get: async () =>
          origin === "unknown"
            ? { error: "metadata unavailable" }
            : { data: { id: session.data!.id, parentID: "ses_missing" } },
      },
    }
    await run({ maxParentSessions: 0 }, { ...ctx, client: child })
    const messages = JSON.stringify(captured.at(-1)?.messages)
    assert(!messages.includes('\\"actor\\": \\"user\\"'))
    assert(messages.includes(origin))
  }
  console.log(
    JSON.stringify({
      ok: true,
      providerRequests: captured.length,
      structuredTools: ["StructuredOutput"],
      mcpConnected: true,
      isolationFailuresBlocked: true,
      incompleteActionBlocked: true,
    }),
  )
} finally {
  host.kill()
  await host.exited
  const logs = (await stdout) + (await stderr)
  // Keep the host output for debugging; the path goes to stderr so the
  // success JSON on stdout stays machine-readable.
  const logPath = join(logDirectory, "host.log")
  await writeFile(logPath, logs)
  console.error("host regression logs:", logPath)
  provider.stop(true)
  await rm(root, { recursive: true, force: true })
}
