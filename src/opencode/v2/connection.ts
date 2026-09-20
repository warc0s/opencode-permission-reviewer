import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { OpenCode, type OpenCodeClient } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { lt } from "semver"
import { ReviewerRpc } from "../../ui/rpc.ts"

interface ServiceEndpoint {
  url: string
  auth?: { type: "basic"; username: string; password: string }
}

export function validateHostEndpoint(url: string): URL {
  const endpoint = new URL(url)
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password)
    throw new Error("Reviewer host URL must be HTTP(S) without embedded credentials")
  if (
    endpoint.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
  )
    throw new Error("Reviewer host connections outside loopback require HTTPS")
  return endpoint
}

export function hostCompatibleFetch(
  version: string,
  delegate: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  if (!lt(version, "2.0.4")) return delegate
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const source = input instanceof Request ? input.url : input.toString()
    const url = new URL(source)
    const rewritten = url.pathname.match(/^\/api\/experimental\/session\/([^/]+)\/wait$/)
    if (!rewritten) return delegate(input, init)
    url.pathname = `/api/session/${rewritten[1]}/wait`
    return delegate(input instanceof Request ? new Request(url, input) : url, init)
  }) as typeof globalThis.fetch
}

async function discoverRegisteredService(version: string): Promise<ServiceEndpoint | undefined> {
  const path = join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "opencode",
    "service.json",
  )
  const text = await readFile(path, "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const info = value as { version?: unknown; url?: unknown; password?: unknown }
  if (info.version !== version || typeof info.url !== "string") return undefined
  const endpoint = validateHostEndpoint(info.url)
  return {
    url: endpoint.href,
    ...(typeof info.password === "string"
      ? {
          auth: {
            type: "basic" as const,
            username: "opencode",
            password: info.password,
          },
        }
      : {}),
  }
}

function makeClient(endpoint: ServiceEndpoint, version: string): OpenCodeClient {
  return OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
    fetch: hostCompatibleFetch(version),
  })
}

/** Discover without starting a host; prove identity before accessing sessions. */
export async function connectV2Host(
  directory: string,
  identity: string,
  version: string,
  signal: AbortSignal,
): Promise<OpenCodeClient> {
  const url = process.env.OPENCODE_PERMISSION_REVIEWER_HOST_URL
  let client: OpenCodeClient
  if (url !== undefined) {
    const endpoint = validateHostEndpoint(url)
    const password = process.env.OPENCODE_PASSWORD ?? process.env.OPENCODE_SERVER_PASSWORD
    if (!password) throw new Error("Reviewer explicit host connection requires OPENCODE_PASSWORD")
    client = makeClient(
      {
        url: endpoint.href,
        auth: { type: "basic", username: "opencode", password },
      },
      version,
    )
  } else {
    const discovered = await Service.discover({ version })
    const endpoint = discovered
      ? {
          url: discovered.url,
          ...(discovered.auth ? { auth: discovered.auth } : {}),
        }
      : await discoverRegisteredService(version)
    if (!endpoint)
      throw new Error(
        "Reviewer host connection unavailable: use the registered service or configure OPENCODE_PERMISSION_REVIEWER_HOST_URL and OPENCODE_PASSWORD",
      )
    if (!endpoint.auth) throw new Error("Reviewer discovered an unauthenticated host")
    client = makeClient(endpoint, version)
  }
  const actual = await client.rpc(ReviewerRpc).identity({}, { location: { directory }, signal })
  if (actual !== identity)
    throw new Error("Reviewer connection does not belong to this host generation")
  return client
}
