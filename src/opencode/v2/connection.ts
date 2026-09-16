import { OpenCode, type OpenCodeClient } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { ReviewerRpc } from "../../ui/rpc.ts"

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
    client = OpenCode.make({
      baseUrl: endpoint.href,
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      },
    })
  } else {
    const endpoint = await Service.discover({ version })
    if (!endpoint)
      throw new Error(
        "Reviewer host connection unavailable: use the registered service or configure OPENCODE_PERMISSION_REVIEWER_HOST_URL and OPENCODE_PASSWORD",
      )
    if (!endpoint.auth) throw new Error("Reviewer discovered an unauthenticated host")
    client = OpenCode.make({
      baseUrl: endpoint.url,
      headers: Service.headers({ url: endpoint.url, auth: endpoint.auth }),
    })
  }
  const actual = await client.rpc(ReviewerRpc).identity({}, { location: { directory }, signal })
  if (actual !== identity)
    throw new Error("Reviewer connection does not belong to this host generation")
  return client
}
