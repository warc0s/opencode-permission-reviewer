import type { ContextReader } from "../../core/ports.ts"
import type { OpenCodeClientLike } from "../types.ts"
import { responseData } from "../transport.ts"

export function createV1ContextReader(
  client: OpenCodeClientLike,
  signal?: AbortSignal,
): ContextReader {
  return {
    async messages(sessionID, directory, limit) {
      return responseData(
        await client.session.messages({
          path: { id: sessionID },
          query: { directory, limit },
          ...(signal ? { signal } : {}),
        }),
        "session.messages",
      )
    },
    async session(sessionID, directory) {
      if (!client.session.get) return undefined
      return responseData(
        await client.session.get({
          path: { id: sessionID },
          query: { directory },
          ...(signal ? { signal } : {}),
        }),
        "session.get",
      )
    },
  }
}
