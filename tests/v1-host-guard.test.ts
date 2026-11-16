import { describe, expect, spyOn, test } from "bun:test"
import { assertV1Host, assertV1HostVersion } from "../src/opencode/host-guard.ts"
import { server } from "../src/index.ts"

describe("legacy adapter host guard", () => {
  test("accepts a v1 client with the raw transport", () => {
    expect(() => assertV1Host({ _client: { post: () => Promise.resolve({}) } })).not.toThrow()
    expect(() => assertV1Host({})).not.toThrow()
  })

  test("refuses a v2-generation client clearly", () => {
    // A reply method alone does not satisfy the legacy transport contract.
    expect(() => assertV1Host({ permission: { reply: () => Promise.resolve({}) } })).toThrow(
      /V1 adapter requires the authenticated legacy transport/,
    )
  })
})

describe("V1 entrypoint host version guard", () => {
  test("accepts V1 hosts and unknown versions", () => {
    for (const version of [undefined, "1.18.29", "1.19.5", "not-a-version", "0.0.0-dev-1299"])
      expect(() => assertV1HostVersion(version)).not.toThrow()
  })

  test("refuses a host that reports a V2 version", () => {
    for (const version of ["2.0.3", "2.3.0", "3.0.0-beta.1"])
      expect(() => assertV1HostVersion(version)).toThrow(/loaded the V1 entrypoint.*"plugins" key/)
  })

  test("the V1 entrypoint fails at load on a V2 host and logs why", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {})
    try {
      const input = {
        client: { _client: { get: async () => ({ data: { version: "2.3.0" } }) } },
        directory: "/workspace",
        worktree: "/workspace",
      } as unknown as Parameters<typeof server>[0]
      await expect(server(input, {})).rejects.toThrow("OpenCode 2.3.0 loaded the V1 entrypoint")
      expect(logged.mock.calls.flat().join(" ")).toContain(
        "OpenCode 2.3.0 loaded the V1 entrypoint",
      )
    } finally {
      logged.mockRestore()
    }
  })
})
