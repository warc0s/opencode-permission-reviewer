/**
 * OpenCode V2 host versions accepted at setup. A host outside this range
 * fails setup loudly instead of running against an unknown contract.
 */
export const SUPPORTED_V2_RANGE = ">=2.0.3 <3"

/**
 * Guard the legacy adapter against incompatible client shapes.
 *
 * A client exposing only permission.reply does not satisfy the legacy
 * transport contract. Product V2 uses its own setup entrypoint and adapter.
 */
export function assertV1Host(client: unknown): void {
  const record = (client ?? {}) as Record<string, unknown>
  const permission = (record.permission ?? {}) as Record<string, unknown>
  const raw = (record._client ?? {}) as Record<string, unknown>
  if (typeof permission.reply === "function" && typeof raw.post !== "function") {
    throw new Error(
      "The V1 adapter requires the authenticated legacy transport. " +
        "Use the setup entrypoint for OpenCode V2; refusing this incompatible client.",
    )
  }
}
