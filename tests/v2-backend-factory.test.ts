import { expect, test } from "bun:test"
import type { OpenCodeClient } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import { resolveConfig } from "../src/config.ts"
import { ReviewAttempt } from "../src/core/review-attempt.ts"
import { createV2ReviewerBackend } from "../src/opencode/v2/backend-factory.ts"
import type { ReviewEnvelope } from "../src/types.ts"

type Context = Parameters<Plugin.Plugin["setup"]>[0]
type Provider = { id: string; name: string; integrationID?: string }
type Connection =
  | {
      type: "credential"
      id: string
      label: string
      method: "key" | "oauth" | "external"
    }
  | { type: "env"; name: string }
type Credential =
  { type: "key"; key: string } | { type: "oauth"; access: string; refresh: string; expires: number }

const SAVED_KEY = "synthetic-saved-liquid-key"
const ENV_KEY = "synthetic-env-liquid-key"
const PROVIDER: Provider = { id: "liquid", name: "Liquid Inference", integrationID: "liquid" }
// Distinct from the provider ID to prove the metadata field is followed.
const SELECTED_PROVIDER: Provider = {
  id: "liquid",
  name: "Liquid Inference",
  integrationID: "liquid-saved-account",
}
const CONNECTION: Connection = {
  type: "credential",
  id: "cred_synthetic",
  label: "Synthetic Liquid account",
  method: "key",
}

function envelope(): ReviewEnvelope {
  return {
    request: {
      id: "req_liquid_factory",
      sessionID: "ses_liquid_factory",
      permission: "bash",
      patterns: ["printf ok"],
      metadata: { command: "printf ok" },
      always: [],
    },
    directory: "/workspace",
    worktree: "/workspace",
    transcript: "USER: Run the harmless marker command.",
    intentHistory: "Run the harmless marker command.",
    enrichment: "",
    sshAudit: [],
  }
}

function factoryContext(options: {
  provider: Provider | Error
  connection: Connection | undefined | Error
  credential: Credential | undefined | Error
}) {
  const calls = {
    provider: [] as Array<{ providerID: string }>,
    active: [] as string[],
    resolve: [] as unknown[],
  }
  const context = {
    provider: {
      get: async (input: { providerID: string }) => {
        calls.provider.push(input)
        if (options.provider instanceof Error) throw options.provider
        return { data: options.provider }
      },
    },
    integration: {
      connection: {
        active: async (integrationID: string) => {
          calls.active.push(integrationID)
          if (options.connection instanceof Error) throw options.connection
          return options.connection
        },
        resolve: async (connection: unknown) => {
          calls.resolve.push(connection)
          if (options.credential instanceof Error) throw options.credential
          return options.credential
        },
      },
    },
  } as unknown as Context
  return { context, calls }
}

async function review(context: Context) {
  const backend = createV2ReviewerBackend(context, resolveConfig({ model: "liquid-ai/d1-ultra" }))
  const attempt = new ReviewAttempt("generation_fixture", 5_000)
  try {
    return await backend.review(envelope(), attempt, {} as OpenCodeClient)
  } finally {
    attempt.close("cancelled")
    await backend.dispose()
  }
}

async function withLiquidEnv(value: string | undefined, run: () => Promise<void>) {
  const previous = process.env.LIQUID_API_KEY
  if (value === undefined) delete process.env.LIQUID_API_KEY
  else process.env.LIQUID_API_KEY = value
  try {
    await run()
  } finally {
    if (previous === undefined) delete process.env.LIQUID_API_KEY
    else process.env.LIQUID_API_KEY = previous
  }
}

function stubFetch(response: () => Response = () => Response.json({})) {
  const original = globalThis.fetch
  const requests: Array<{ url: string; authorization: string | null }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: input instanceof Request ? input.url : String(input),
      authorization: new Headers(init?.headers).get("authorization"),
    })
    return response()
  }) as typeof globalThis.fetch
  return {
    requests,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

test("uses only the configured provider's active saved Liquid key", async () => {
  await withLiquidEnv(undefined, async () => {
    const { context, calls } = factoryContext({
      provider: SELECTED_PROVIDER,
      connection: CONNECTION,
      credential: { type: "key", key: ` ${SAVED_KEY} ` },
    })
    const { requests, restore } = stubFetch()
    try {
      const result = await review(context)
      // The synthetic empty response cannot become an approval.
      expect(result.kind).toBe("escalate")
      expect(calls.provider).toEqual([{ providerID: "liquid" }])
      expect(calls.active).toEqual(["liquid-saved-account"])
      expect(calls.resolve).toEqual([CONNECTION])
      expect(requests).toHaveLength(1)
      expect(requests[0]?.url).toBe("https://api.liquid.ai/decisions/v1/systemone")
      expect(requests[0]?.authorization).toBe(`Bearer ${SAVED_KEY}`)
    } finally {
      restore()
    }
  })
})

test("trims an explicit LIQUID_API_KEY and skips the saved account", async () => {
  await withLiquidEnv(` ${ENV_KEY} `, async () => {
    const { context, calls } = factoryContext({
      provider: PROVIDER,
      connection: CONNECTION,
      credential: { type: "key", key: SAVED_KEY },
    })
    const { requests, restore } = stubFetch()
    try {
      await review(context)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.authorization).toBe(`Bearer ${ENV_KEY}`)
      expect(calls.provider).toHaveLength(0)
      expect(calls.active).toHaveLength(0)
      expect(calls.resolve).toHaveLength(0)
    } finally {
      restore()
    }
  })
})

test("treats a blank LIQUID_API_KEY as unset and uses the saved account", async () => {
  await withLiquidEnv("   ", async () => {
    const { context, calls } = factoryContext({
      provider: PROVIDER,
      connection: CONNECTION,
      credential: { type: "key", key: SAVED_KEY },
    })
    const { requests, restore } = stubFetch()
    try {
      await review(context)
      expect(calls.provider).toHaveLength(1)
      expect(calls.active).toEqual(["liquid"])
      expect(requests[0]?.authorization).toBe(`Bearer ${SAVED_KEY}`)
    } finally {
      restore()
    }
  })
})

test("resolves a key from an active env connection", async () => {
  await withLiquidEnv(undefined, async () => {
    const envConnection: Connection = { type: "env", name: "LIQUID_API_KEY" }
    const { context, calls } = factoryContext({
      provider: PROVIDER,
      connection: envConnection,
      credential: { type: "key", key: SAVED_KEY },
    })
    const { requests, restore } = stubFetch()
    try {
      await review(context)
      expect(calls.resolve).toEqual([envConnection])
      expect(requests[0]?.authorization).toBe(`Bearer ${SAVED_KEY}`)
    } finally {
      restore()
    }
  })
})

test("stops after cancellation during deferred credential resolution", async () => {
  await withLiquidEnv(undefined, async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const calls = { provider: 0, active: [] as string[] }
    const context = {
      provider: {
        get: async () => {
          calls.provider++
          await gate
          return { data: PROVIDER }
        },
      },
      integration: {
        connection: {
          active: async (integrationID: string) => {
            calls.active.push(integrationID)
            return CONNECTION
          },
          resolve: async () => ({ type: "key", key: SAVED_KEY }),
        },
      },
    } as unknown as Context
    const { requests, restore } = stubFetch()
    const backend = createV2ReviewerBackend(context, resolveConfig({ model: "liquid-ai/d1-ultra" }))
    const attempt = new ReviewAttempt("generation_fixture", 5_000)
    try {
      const pending = backend.review(envelope(), attempt, {} as OpenCodeClient)
      attempt.close("cancelled")
      release()
      const result = await pending
      expect(calls.provider).toBe(1)
      expect(calls.active).toHaveLength(0)
      expect(requests).toHaveLength(0)
      expect(result.kind).toBe("escalate")
      expect(result.reason).toContain("cancelled")
    } finally {
      attempt.close("cancelled")
      restore()
      await backend.dispose()
    }
  })
})

test("does not expose a Liquid key echoed in an API error response", async () => {
  for (const route of ["env", "saved"] as const) {
    const key = route === "env" ? ENV_KEY : SAVED_KEY
    await withLiquidEnv(route === "env" ? ENV_KEY : undefined, async () => {
      const { context } = factoryContext({
        provider: PROVIDER,
        connection: CONNECTION,
        credential: { type: "key", key: SAVED_KEY },
      })
      const { requests, restore } = stubFetch(() =>
        Response.json({ error: `Invalid API key ${key}` }, { status: 401 }),
      )
      try {
        const result = await review(context)
        expect(requests).toHaveLength(1)
        expect(result.kind).toBe("escalate")
        expect(result.reason).toContain("Liquid reviewer request failed")
        expect(JSON.stringify(result)).not.toContain(key)
      } finally {
        restore()
      }
    })
  }
})

test("fails closed when the provider, connection, or key credential is unavailable", async () => {
  const cases: Array<{
    name: string
    options: Parameters<typeof factoryContext>[0]
    reason: string
    activeCalls: string[]
    resolveCalls: number
  }> = [
    {
      name: "provider without an integration",
      options: {
        provider: { id: "liquid", name: "Liquid Inference" },
        connection: CONNECTION,
        credential: { type: "key", key: SAVED_KEY },
      },
      reason: "No saved Liquid API key or LIQUID_API_KEY available",
      activeCalls: [],
      resolveCalls: 0,
    },
    {
      name: "missing active connection",
      options: {
        provider: PROVIDER,
        connection: undefined,
        credential: { type: "key", key: SAVED_KEY },
      },
      reason: "No saved Liquid API key or LIQUID_API_KEY available",
      activeCalls: ["liquid"],
      resolveCalls: 0,
    },
    {
      name: "unresolved credential",
      options: { provider: PROVIDER, connection: CONNECTION, credential: undefined },
      reason: "No saved Liquid API key or LIQUID_API_KEY available",
      activeCalls: ["liquid"],
      resolveCalls: 1,
    },
    {
      name: "non-key credential",
      options: {
        provider: PROVIDER,
        connection: { ...CONNECTION, method: "oauth" },
        credential: {
          type: "oauth",
          access: "synthetic-oauth-access",
          refresh: "synthetic-oauth-refresh",
          expires: 1,
        },
      },
      reason: "No saved Liquid API key or LIQUID_API_KEY available",
      activeCalls: ["liquid"],
      resolveCalls: 0,
    },
    {
      name: "blank saved key",
      options: {
        provider: PROVIDER,
        connection: CONNECTION,
        credential: { type: "key", key: "   " },
      },
      reason: "No saved Liquid API key or LIQUID_API_KEY available",
      activeCalls: ["liquid"],
      resolveCalls: 1,
    },
  ]

  for (const item of cases) {
    await withLiquidEnv(undefined, async () => {
      const { context, calls } = factoryContext(item.options)
      const { requests, restore } = stubFetch()
      try {
        const result = await review(context)
        expect(result.kind).toBe("escalate")
        expect(result.reason).toContain(item.reason)
        expect(calls.active).toEqual(item.activeCalls)
        expect(calls.resolve).toHaveLength(item.resolveCalls)
        expect(requests).toHaveLength(0)
        expect(JSON.stringify(result)).not.toContain("synthetic-oauth")
      } finally {
        restore()
      }
    })
  }
})

test("reports a fixed diagnostic when Liquid credential resolution fails", async () => {
  const cases: Array<{
    name: string
    options: Parameters<typeof factoryContext>[0]
    sensitiveMarker: string
  }> = [
    {
      name: "provider lookup",
      options: {
        provider: new Error("provider failure: synthetic-provider-secret"),
        connection: CONNECTION,
        credential: { type: "key", key: SAVED_KEY },
      },
      sensitiveMarker: "synthetic-provider-secret",
    },
    {
      name: "active connection lookup",
      options: {
        provider: PROVIDER,
        connection: new Error("connection failure: synthetic-connection-secret"),
        credential: { type: "key", key: SAVED_KEY },
      },
      sensitiveMarker: "synthetic-connection-secret",
    },
    {
      name: "credential resolve",
      options: {
        provider: PROVIDER,
        connection: CONNECTION,
        credential: new Error("resolve failure: synthetic-credential-secret"),
      },
      sensitiveMarker: "synthetic-credential-secret",
    },
  ]

  for (const item of cases) {
    await withLiquidEnv(undefined, async () => {
      const { context } = factoryContext(item.options)
      const { requests, restore } = stubFetch()
      try {
        const result = await review(context)
        expect(result.kind).toBe("escalate")
        expect(result.reason).toContain("Unable to resolve the saved Liquid API key")
        expect(JSON.stringify(result)).not.toContain(item.sensitiveMarker)
        expect(requests).toHaveLength(0)
      } finally {
        restore()
      }
    })
  }
})
