import { afterEach, expect, spyOn, test } from "bun:test"
import { OpenCode, type OpenCodeClient } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { connectV2Host, validateHostEndpoint } from "../src/opencode/v2/connection.ts"

const hostUrl = "OPENCODE_PERMISSION_REVIEWER_HOST_URL"
const password = "OPENCODE_PASSWORD"
const legacyPassword = "OPENCODE_SERVER_PASSWORD"
const originalEnv = {
  [hostUrl]: process.env[hostUrl],
  [password]: process.env[password],
  [legacyPassword]: process.env[legacyPassword],
}

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

function fakeClient(actualIdentity: string): OpenCodeClient {
  return {
    rpc: () => ({ identity: async () => actualIdentity }),
  } as unknown as OpenCodeClient
}

test("explicit V2 host URLs reject embedded credentials and non-loopback HTTP", () => {
  expect(() => validateHostEndpoint("http://user:pass@127.0.0.1:4096/")).toThrow(
    "without embedded credentials",
  )
  expect(() => validateHostEndpoint("http://example.invalid:4096/")).toThrow(
    "outside loopback require HTTPS",
  )
  expect(validateHostEndpoint("http://127.0.0.1:4096/").href).toBe("http://127.0.0.1:4096/")
  expect(validateHostEndpoint("https://example.invalid/").href).toBe("https://example.invalid/")
})

test("explicit V2 host connection rejects missing authentication", async () => {
  process.env[hostUrl] = "http://127.0.0.1:4096/"
  delete process.env[password]
  delete process.env[legacyPassword]
  const make = spyOn(OpenCode, "make")
  try {
    await expect(
      connectV2Host("/workspace", "expected", "2.0.3", AbortSignal.timeout(1000)),
    ).rejects.toThrow("requires OPENCODE_PASSWORD")
    expect(make).not.toHaveBeenCalled()
  } finally {
    make.mockRestore()
  }
})

test("discovered V2 host connection rejects missing authentication", async () => {
  delete process.env[hostUrl]
  const discover = spyOn(Service, "discover").mockResolvedValue({
    url: "http://127.0.0.1:4096/",
    auth: undefined,
  } as Awaited<ReturnType<typeof Service.discover>>)
  const make = spyOn(OpenCode, "make")
  try {
    await expect(
      connectV2Host("/workspace", "expected", "2.0.3", AbortSignal.timeout(1000)),
    ).rejects.toThrow("unauthenticated host")
    expect(make).not.toHaveBeenCalled()
  } finally {
    discover.mockRestore()
    make.mockRestore()
  }
})

test("V2 host connection rejects an instance identity mismatch", async () => {
  process.env[hostUrl] = "http://127.0.0.1:4096/"
  process.env[password] = "synthetic-host-password"
  const make = spyOn(OpenCode, "make").mockReturnValue(fakeClient("another-instance"))
  try {
    await expect(
      connectV2Host("/workspace", "expected", "2.0.3", AbortSignal.timeout(1000)),
    ).rejects.toThrow("does not belong to this host generation")
    expect(make).toHaveBeenCalledTimes(1)
  } finally {
    make.mockRestore()
  }
})
