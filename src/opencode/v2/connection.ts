import { Buffer } from "node:buffer"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { OpenCode, type OpenCodeClient } from "@opencode/client"
import { ReviewerRpc } from "../../ui/rpc.ts"

interface ServiceEndpoint {
  url: string
  password: string
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

export function validateHostEndpoint(url: string): URL {
  const endpoint = new URL(url)
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password)
    throw new Error("Reviewer host URL must be HTTP(S) without embedded credentials")
  if (endpoint.protocol === "http:" && !LOOPBACK_HOSTS.has(endpoint.hostname))
    throw new Error("Reviewer host connections outside loopback require HTTPS")
  return endpoint
}

export function hostCompatibleFetch(
  delegate: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const source = input instanceof Request ? input.url : input.toString()
    const url = new URL(source)
    const session = url.pathname.match(/^\/api\/experimental\/session\/([^/]+)\/wait$/)
    if (!session) return delegate(input, init)
    const response = await delegate(input instanceof Request ? input.clone() : input, init)
    if (response.status !== 404 && response.status !== 405) return response
    await response.body?.cancel().catch(() => {})
    url.pathname = `/api/session/${session[1]}/wait`
    return delegate(input instanceof Request ? new Request(url, input) : url, init)
  }) as typeof globalThis.fetch
}

function assertLiveProcess(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("Reviewer service registration contains an invalid process ID")
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM")
      throw new Error("Reviewer service registration belongs to a process that is not running", {
        cause: error,
      })
  }
}

async function readRegisteredService(version: string): Promise<ServiceEndpoint | undefined> {
  const path = join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "opencode",
    "service.json",
  )
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (text === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error("Reviewer service registration is not valid JSON")
  }
  if (typeof value !== "object" || value === null)
    throw new Error("Reviewer service registration is invalid")
  const info = value as {
    version?: unknown
    url?: unknown
    pid?: unknown
    password?: unknown
  }
  if (info.version !== version)
    throw new Error("Reviewer service registration does not match this host version")
  if (typeof info.url !== "string")
    throw new Error("Reviewer service registration does not contain a URL")
  if (typeof info.password !== "string" || info.password.length === 0)
    throw new Error("Reviewer service registration does not contain authentication")
  assertLiveProcess(info.pid as number)
  const endpoint = validateHostEndpoint(info.url)
  if (!LOOPBACK_HOSTS.has(endpoint.hostname))
    throw new Error("Reviewer registered service must use a loopback address")
  if (endpoint.pathname !== "/" || endpoint.search || endpoint.hash)
    throw new Error("Reviewer registered service URL must be a loopback origin")
  return { url: endpoint.href, password: info.password }
}

function makeClient(endpoint: ServiceEndpoint): OpenCodeClient {
  return OpenCode.make({
    baseUrl: endpoint.url,
    headers: {
      authorization: `Basic ${Buffer.from(`opencode:${endpoint.password}`).toString("base64")}`,
    },
    fetch: hostCompatibleFetch(),
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
    client = makeClient({ url: endpoint.href, password })
  } else {
    const endpoint = await readRegisteredService(version)
    if (!endpoint)
      throw new Error(
        "Reviewer host connection unavailable: use the registered service or configure OPENCODE_PERMISSION_REVIEWER_HOST_URL and OPENCODE_PASSWORD",
      )
    client = makeClient(endpoint)
  }
  const actual = await client.rpc(ReviewerRpc).identity({}, { location: { directory }, signal })
  if (actual !== identity)
    throw new Error("Reviewer connection does not belong to this host generation")
  return client
}
