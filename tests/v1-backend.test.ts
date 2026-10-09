import { expect, test } from "bun:test"
import { constants as fsConstants, existsSync, mkdtempSync } from "node:fs"
import {
  chmod,
  link,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile as write,
} from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { V1ReviewerBackend } from "../src/opencode/v1/reviewer-backend.ts"
import { ReviewAttempt } from "../src/core/review-attempt.ts"
import type { ReviewEnvelope, ReviewerConfig } from "../src/types.ts"
import type { RuntimeContext } from "../src/opencode/types.ts"
import { config, request } from "./helpers.ts"

/** A V1 fixture mirroring `v2-backend.test.ts`: the client exposes only the V1
 *  surface (session/tool/mcp.status) and the backend runs against a scratch
 *  isolation base so the real HOME is never touched. */
function fixture(
  options: {
    format?: ReviewerConfig["outputFormat"]
    mcpServers?: boolean | "after-first"
    mcpError?: boolean
    withoutMcp?: boolean
    base?: string
    inventory?: unknown
    timeoutMs?: number
  } = {},
) {
  const base = options.base ?? mkdtempSync(join(tmpdir(), "reviewer-v1-isolation-"))
  const directories: string[] = []
  let sessionID = ""
  const sessionIDs: string[] = []
  let prompts = 0
  let mcpStatuses = 0
  let directoriesRead = 0
  const removed = new Set<string>()

  const client = {
    session: {
      create: async (input: { query?: { directory?: string } }) => {
        const directory = input.query?.directory ?? ""
        directories.push(directory)
        directoriesRead++
        sessionID = `ses_review_${directoriesRead}`
        sessionIDs.push(sessionID)
        return { data: { id: sessionID } }
      },
      messages: async () => ({ data: [] }),
      prompt: async () => {
        prompts++
        return {
          data:
            (options.format ?? "json_schema") === "text"
              ? { info: {}, parts: [{ type: "text", text: JSON.stringify(decision("allow")) }] }
              : { info: { structured: decision("allow") } },
        }
      },
      delete: async ({ path }: { path: { id: string } }) => {
        removed.add(path.id)
        return { data: true }
      },
    },
    tool: { ids: async () => ({ data: ["bash", "read", "write", "webfetch", "task"] }) },
    mcp: options.withoutMcp
      ? undefined
      : {
          status: async () => {
            mcpStatuses++
            if (options.mcpError) return { error: { message: "mcp status unavailable" } }
            return {
              data:
                "inventory" in options
                  ? options.inventory
                  : options.mcpServers === true ||
                      (options.mcpServers === "after-first" && mcpStatuses > 1)
                    ? { fixture: { status: "connected" } }
                    : {},
            }
          },
        },
  } as unknown as RuntimeContext["client"]

  const ctx: RuntimeContext = {
    client,
    directory: "/workspace/operational",
    worktree: "/workspace/operational",
    reviewerDirectoryBase: base,
    capabilities: {
      publicPermissionReply: false,
      permissionReplyMessage: false,
      rawAuthenticatedTransport: true,
      sessionGet: true,
      sessionParentID: true,
      assistantAgentMetadata: false,
      assistantModeMetadata: false,
      effectivePermissions: false,
      tuiPublish: false,
    },
  } as RuntimeContext

  const backend = new V1ReviewerBackend(
    ctx,
    config({
      model: "fixture/reviewer",
      outputFormat: options.format ?? "json_schema",
      timeoutMs: options.timeoutMs ?? 5000,
    }),
    () => {},
    () => {},
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
    client,
    base,
    run: async (attempt = new ReviewAttempt("generation_fixture", 5000)) => {
      try {
        return await backend.review(envelope, attempt)
      } finally {
        attempt.close("cancelled")
      }
    },
    state: () => ({ directories, sessionIDs, prompts, mcpStatuses, removed }),
    cleanup: async () => {
      await backend.waitForIdle()
      if (existsSync(base)) await rm(base, { recursive: true, force: true })
    },
  }
}

function decision(outcome: "allow" | "deny" | "escalate") {
  return {
    version: 2,
    outcome,
    risk_level: "low",
    user_authorization: "high",
    scope_alignment: "aligned",
    evidence_completeness: "sufficient",
    rationale: "The action is narrow, reversible, and explicitly requested.",
    confidence: 0.95,
  }
}

test("the isolated location is created with config that excludes MCP", async () => {
  const harness = fixture()
  try {
    expect((await harness.run()).kind).toBe("allow")
    const configText = await readFile(join(harness.base, "opencode.json"), "utf8")
    const isolated = JSON.parse(configText) as { plugin: string[] }
    expect(isolated.plugin).toEqual(["./reviewer-isolation.js"])
    const bootstrap = await readFile(join(harness.base, "reviewer-isolation.js"), "utf8")
    expect(bootstrap).toContain('Object.defineProperty(cfg, "mcp"')
    const configMode = (await stat(join(harness.base, "opencode.json"))).mode & 0o777
    expect(configMode).toBe(0o600)
    const bootstrapMode = (await stat(join(harness.base, "reviewer-isolation.js"))).mode & 0o777
    expect(bootstrapMode).toBe(0o600)
  } finally {
    await harness.cleanup()
  }
})

test("the isolation bootstrap drops MCP servers added before and after its config hook", async () => {
  const harness = fixture()
  const pluginDir = await mkdtemp(join(tmpdir(), "reviewer-v1-later-plugin-"))
  try {
    expect((await harness.run()).kind).toBe("allow")
    const url = pathToFileURL(join(harness.base, "reviewer-isolation.js"))
    const plugin = (await import(`${url.href}?case=${Date.now()}`)) as {
      default: () => Promise<{ config(cfg: Record<string, unknown>): Promise<void> }>
    }
    // A plugin whose hook ran earlier already added a server.
    const cfg: Record<string, unknown> = {
      model: "fixture/model",
      mcp: { earlier: { type: "local", command: ["earlier"] } },
    }
    await (await plugin.default()).config(cfg)
    // Hooks from config sources the host applies later write in every usual way,
    // from a strict-mode module like a real plugin.
    const laterPath = join(pluginDir, "later.mjs")
    await write(
      laterPath,
      `export default (cfg) => {
  cfg.mcp ??= {}
  cfg.mcp.later ??= { type: "remote", url: "https://later.invalid/mcp" }
  cfg.mcp = { replaced: { type: "local", command: ["replaced"] } }
  Object.assign(cfg.mcp, { assigned: { type: "local", command: ["assigned"] } })
}
`,
    )
    const later = (await import(pathToFileURL(laterPath).href)) as {
      default: (cfg: Record<string, unknown>) => void
    }
    expect(() => later.default(cfg)).not.toThrow()
    expect(cfg.mcp).toEqual({})
    expect(JSON.parse(JSON.stringify(cfg))).toEqual({ model: "fixture/model", mcp: {} })
  } finally {
    await harness.cleanup()
    await rm(pluginDir, { recursive: true, force: true })
  }
})

test("concurrent first reviews share one location and keep sessions independent", async () => {
  const harness = fixture()
  try {
    const [first, second] = await Promise.all([harness.run(), harness.run()])
    expect(first.kind).toBe("allow")
    expect(second.kind).toBe("allow")
    expect(new Set(harness.state().directories).size).toBe(1)
    expect(new Set(harness.state().sessionIDs).size).toBe(2)
    const configPath = join(harness.base, "opencode.json")
    const isolated = JSON.parse(await readFile(configPath, "utf8")) as { plugin: string[] }
    expect(isolated.plugin).toEqual(["./reviewer-isolation.js"])
    expect((await stat(configPath)).mode & 0o777).toBe(0o600)
    const bootstrap = await readFile(join(harness.base, "reviewer-isolation.js"), "utf8")
    expect(bootstrap).toContain('Object.defineProperty(cfg, "mcp"')
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
    expect(harness.state().prompts).toBe(0)
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
    expect(harness.state().mcpStatuses).toBe(2)
  } finally {
    await harness.cleanup()
  }
})

test("an MCP status failure escalates instead of proceeding", async () => {
  const harness = fixture({ mcpError: true })
  try {
    const result = await harness.run()
    expect(result.kind).toBe("escalate")
    expect(result.reason).toContain("reviewer isolation")
    expect(harness.state().sessionIDs).toHaveLength(0)
    expect(harness.state().prompts).toBe(0)
  } finally {
    await harness.cleanup()
  }
})

test("a client without an MCP surface escalates instead of proceeding", async () => {
  const harness = fixture({ withoutMcp: true })
  try {
    const result = await harness.run()
    expect(result.kind).toBe("escalate")
    expect(harness.state().sessionIDs).toHaveLength(0)
  } finally {
    await harness.cleanup()
  }
})

test("a second backend re-asserts the config in the shared, persistent location", async () => {
  const first = fixture()
  const base = first.base
  const configPath = join(base, "opencode.json")
  try {
    expect((await first.run()).kind).toBe("allow")
    // The location survives across processes, so a stale/tampered file must be
    // overwritten rather than failing the second backend closed on EEXIST.
    await write(configPath, JSON.stringify({ plugin: [] }), { mode: 0o644 })
    await chmod(configPath, 0o644)
    const bootstrapPath = join(base, "reviewer-isolation.js")
    await write(bootstrapPath, "export default async () => ({})")
    await chmod(bootstrapPath, 0o644)
    await chmod(base, 0o755)
    const second = fixture({ base })
    try {
      expect((await second.run()).kind).toBe("allow")
      const configFile = await open(configPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      try {
        const isolated = JSON.parse(await configFile.readFile("utf8")) as { plugin: string[] }
        expect(isolated.plugin).toEqual(["./reviewer-isolation.js"])
        expect((await configFile.stat()).mode & 0o777).toBe(0o600)
      } finally {
        await configFile.close()
      }
      expect((await stat(bootstrapPath)).mode & 0o777).toBe(0o600)
      expect(await readFile(bootstrapPath, "utf8")).toContain('Object.defineProperty(cfg, "mcp"')
      expect((await stat(base)).mode & 0o777).toBe(0o700)
    } finally {
      await second.cleanup()
    }
  } finally {
    if (existsSync(base)) await rm(base, { recursive: true, force: true })
  }
})

test("an uncreatable isolation directory escalates without a reviewer session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reviewer-v1-isolation-failure-"))
  const file = join(dir, "file")
  await write(file, "not a directory")
  const harness = fixture()
  const client = harness.client
  try {
    const backend = new V1ReviewerBackend(
      {
        client,
        directory: "/workspace/operational",
        worktree: "/workspace/operational",
        reviewerDirectoryBase: join(file, "child"),
      } as RuntimeContext,
      config({ model: "fixture/reviewer" }),
      () => {},
      () => {},
    )
    const attempt = new ReviewAttempt("generation_fixture", 5000)
    try {
      const result = await backend.review(
        {
          request: request(),
          directory: "/workspace/operational",
          worktree: "/workspace/operational",
          transcript: "Run printf safe",
          intentHistory: "Run printf safe",
          enrichment: "",
          sshAudit: [],
        },
        attempt,
      )
      expect(result.kind).toBe("escalate")
      expect(result.reason).toContain("reviewer isolation unavailable")
      expect(harness.state().sessionIDs).toHaveLength(0)
      expect(harness.state().prompts).toBe(0)
    } finally {
      attempt.close("cancelled")
      await backend.waitForIdle()
    }
  } finally {
    await harness.cleanup()
    await rm(dir, { recursive: true, force: true })
  }
})

for (const [label, inventory] of [
  ["null", null],
  ["missing", undefined],
  ["boolean", false],
  ["number", 0],
  ["string", ""],
  ["array", []],
  ["non-record object", new Date(0)],
] as const) {
  test(`a malformed MCP inventory (${label}) fails closed`, async () => {
    const harness = fixture({ inventory })
    try {
      const result = await harness.run()
      expect(result.kind).toBe("escalate")
      expect(harness.state().sessionIDs).toHaveLength(0)
      expect(harness.state().prompts).toBe(0)
    } finally {
      await harness.cleanup()
    }
  })
}

for (const name of ["opencode.json", "reviewer-isolation.js"]) {
  for (const kind of ["symlink", "hardlink", "fifo", "directory"] as const) {
    test(`a ${kind} at ${name} is refused without changing its target`, async () => {
      const root = await mkdtemp(join(tmpdir(), "reviewer-v1-file-refusal-"))
      const base = join(root, "isolated")
      const harness = fixture({ base })
      const outside = join(root, "outside")
      const target = join(base, name)
      try {
        expect((await harness.run()).kind).toBe("allow")
        await rm(target)
        await write(outside, "preserve synthetic fixture")
        if (kind === "symlink") await symlink(outside, target)
        else if (kind === "hardlink") await link(outside, target)
        else if (kind === "fifo") execFileSync("mkfifo", [target])
        else {
          const { mkdir } = await import("node:fs/promises")
          await mkdir(target)
        }
        const second = fixture({ base })
        const result = await second.run()
        expect(result.kind).toBe("escalate")
        expect(second.state().sessionIDs).toHaveLength(0)
        expect(await readFile(outside, "utf8")).toBe("preserve synthetic fixture")
        expect((await readdir(base)).some((file) => file.endsWith(".tmp"))).toBe(false)
        await rm(target, { recursive: true, force: true })
        expect((await second.run()).kind).toBe("allow")
      } finally {
        await harness.backend.waitForIdle()
        await rm(root, { recursive: true, force: true })
      }
    }, 30_000)
  }
}

test("a symlinked isolation directory fails closed without writing outside it", async () => {
  const first = fixture()
  const root = await mkdtemp(join(tmpdir(), "reviewer-v1-directory-link-"))
  const base = join(root, "isolated")
  const second = fixture({ base })
  try {
    await symlink(first.base, base)
    expect((await second.run()).kind).toBe("escalate")
    expect(second.state().sessionIDs).toHaveLength(0)
    expect(await readdir(first.base)).toEqual([])
  } finally {
    await first.cleanup()
    await second.backend.waitForIdle()
    await rm(root, { recursive: true, force: true })
  }
})

test("an MCP transport timeout fails closed before creating a session", async () => {
  const harness = fixture({ timeoutMs: 30 })
  harness.client.mcp!.status = async () => new Promise(() => {})
  try {
    expect((await harness.run()).kind).toBe("escalate")
    expect(harness.state().sessionIDs).toHaveLength(0)
    expect(harness.state().prompts).toBe(0)
  } finally {
    await harness.cleanup()
  }
})

test("a cancelled review never asks the host to boot its isolation location", async () => {
  const harness = fixture()
  const attempt = new ReviewAttempt("fixture", 5000)
  attempt.close("cancelled")
  try {
    expect((await harness.run(attempt)).kind).toBe("escalate")
    expect(harness.state().mcpStatuses).toBe(0)
    expect(harness.state().sessionIDs).toHaveLength(0)
    // Setup is shared and may finish after the cancelled waiter. Await it
    // through a later review before removing the fixture directory.
    expect((await harness.run()).kind).toBe("allow")
  } finally {
    await harness.cleanup()
  }
})

test("independent backends never expose empty or partial isolation files", async () => {
  const first = fixture()
  try {
    expect((await first.run()).kind).toBe("allow")
    const paths = [join(first.base, "opencode.json"), join(first.base, "reviewer-isolation.js")]
    const expected = await Promise.all(paths.map((path) => readFile(path, "utf8")))
    let writing = true
    const writers = Promise.all(
      Array.from({ length: 30 }, () => fixture({ base: first.base }).run()),
    ).finally(() => {
      writing = false
    })
    const observed: string[][] = []
    while (writing) observed.push(await Promise.all(paths.map((path) => readFile(path, "utf8"))))
    expect((await writers).every((result) => result.kind === "allow")).toBe(true)
    expect(observed.length).toBeGreaterThan(0)
    for (const contents of observed) expect(contents).toEqual(expected)
    expect((await readdir(first.base)).sort()).toEqual(["opencode.json", "reviewer-isolation.js"])
  } finally {
    await first.cleanup()
  }
}, 30_000)

test("separate processes replace shared isolation files without partial reads", async () => {
  const first = fixture()
  const children: ReturnType<typeof Bun.spawn>[] = []
  try {
    expect((await first.run()).kind).toBe("allow")
    const paths = [join(first.base, "opencode.json"), join(first.base, "reviewer-isolation.js")]
    const expected = await Promise.all(paths.map((path) => readFile(path, "utf8")))
    for (let index = 0; index < 2; index++) {
      children.push(
        Bun.spawn(
          [process.execPath, join(import.meta.dir, "fixtures/v1-isolation.ts"), first.base],
          {
            stdout: "pipe",
            stderr: "pipe",
          },
        ),
      )
    }
    let writing = true
    const exits = Promise.all(children.map((child) => child.exited)).finally(() => {
      writing = false
    })
    const observed: string[][] = []
    while (writing) observed.push(await Promise.all(paths.map((path) => readFile(path, "utf8"))))
    const errors = await Promise.all(
      children.map((child) => {
        const stderr = child.stderr
        if (typeof stderr === "number") throw new Error("Missing fixture stderr pipe")
        return new Response(stderr).text()
      }),
    )
    expect(errors).toEqual(["", ""])
    expect(await exits).toEqual([0, 0])
    for (const contents of observed) expect(contents).toEqual(expected)
    expect((await readdir(first.base)).sort()).toEqual(["opencode.json", "reviewer-isolation.js"])
  } finally {
    for (const child of children) {
      child.kill()
      await child.exited
    }
    await first.cleanup()
  }
}, 30_000)
