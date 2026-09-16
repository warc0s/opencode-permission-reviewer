import { encodeUiStatus } from "../ui-protocol.ts"
import type { OpenCodeCapabilities, PermissionReplyInput, RawTransport } from "./adapter.ts"
import { probeCapabilities } from "./capability-detection.ts"
import { createReplyTransport } from "./reply-transport.ts"
import { assertV1Host } from "./host-guard.ts"
import type { OpenCodeClientLike, RuntimeContext } from "./types.ts"

interface V1ServerInput {
  client: unknown
  directory: string
  worktree: string
}

/** Typed v1 TUI publish shape (matches `TuiPublishData` in the SDK). */
interface TypedTuiPublish {
  (options: {
    body: { type: string; properties: { command: string } }
    query?: { directory?: string }
  }): Promise<unknown>
}

type Logger = (message: string, details?: unknown) => void

/** The reply shape the coordinator sends (kept so its call sites stay
 *  unchanged while the reply logic itself is isolated in the transport). */
interface ReplyOptions {
  path: { requestID: string }
  body: { reply: "once" | "always" | "reject"; message?: string }
  query?: { directory?: string }
}

/**
 * Build the V1 {@link RuntimeContext} against OpenCode's authenticated raw
 * transport. Probes the host client's capabilities, refuses a v2-generation
 * host, and routes every permission reply through the isolated reply transport
 * (which throws when no safe reply channel exists, so the plugin never runs
 * with an unauthenticated client).
 */
export function createV1Adapter(input: V1ServerInput, logger?: Logger): RuntimeContext {
  assertV1Host(input.client)
  const transport = (input.client as { _client?: RawTransport })._client
  if (!transport?.post) {
    throw new Error(
      "OpenCode's authenticated SDK transport is unavailable; refusing unsafe partial startup.",
    )
  }
  const capabilities: OpenCodeCapabilities = probeCapabilities(input.client)
  // The reply transport isolates the priority chain (public SDK reply with
  // message > public reply + separate feedback > raw > refuse). With the v1
  // host the chain resolves to the raw path; a public path slots in unchanged
  // when the host exposes one.
  const replyTransport = createReplyTransport({
    raw: transport,
    capabilities,
    ...(logger === undefined ? {} : { logOnce: (message) => logger(message) }),
  })

  const client = input.client as unknown as OpenCodeClientLike

  // Permission reply is delegated to the isolated transport. The typed v1
  // method (postSessionIdPermissionsPermissionId) does not carry the feedback
  // message, so the transport resolves to the raw path.
  const permissionReply: RuntimeContext["permissionReply"] = (request) => {
    const opts = request as ReplyOptions
    const flat: PermissionReplyInput = {
      requestID: opts.path.requestID,
      reply: opts.body.reply,
      ...(opts.body.message === undefined ? {} : { message: opts.body.message }),
      directory: opts.query?.directory ?? input.directory,
    }
    return replyTransport.reply(flat)
  }

  // TUI status publishing uses the typed v1 API (client.tui.publish), which
  // carries the same body shape the raw transport used. Falls back to raw if
  // the typed method is absent in a future/older host. The method MUST be
  // called on the `tui` object (not extracted) because the SDK uses `this` to
  // reach its internal transport.
  const tui = (input.client as { tui?: { publish?: TypedTuiPublish } }).tui
  const publishUiStatus: RuntimeContext["publishUiStatus"] = async (status) => {
    const body = {
      type: "tui.command.execute",
      properties: { command: encodeUiStatus(status) },
    }
    if (tui !== undefined && typeof tui.publish === "function") {
      return (await tui.publish({ body, query: { directory: input.directory } })) as {
        data?: unknown
        error?: unknown
      }
    }
    return transport.post({
      url: "/tui/publish",
      body,
      query: { directory: input.directory },
      headers: { "Content-Type": "application/json" },
    })
  }

  return {
    client,
    capabilities,
    permissionReply,
    publishUiStatus,
    directory: input.directory,
    worktree: input.worktree,
  }
}
