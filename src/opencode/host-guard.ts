import { parse } from "semver"

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

/**
 * Refuse the V1 entrypoint on a host that reports a V2 version.
 *
 * The V1 reviewer isolates its sessions with a single-file local plugin, which
 * V2 skips. Every review would then fail closed with no visible cause, so the
 * plugin fails at load instead and says how to fix it.
 */
export function assertV1HostVersion(version: string | undefined): void {
  const parsed = version === undefined ? null : parse(version)
  if (parsed === null || parsed.major < 2) return
  throw new Error(
    `OpenCode ${parsed.version} loaded the V1 entrypoint of opencode-permission-reviewer, ` +
      "whose reviewer isolation V2 does not load. Configure the plugin for V2 " +
      '(the "plugins" key, see "Configure OpenCode V2" in the README) so the host uses its setup entrypoint.',
  )
}
