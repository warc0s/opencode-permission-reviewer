import { describe, expect, test } from "bun:test"
import { assertV1Host } from "../src/opencode/host-guard.ts"

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
