import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenCode, type OpenCodeClient } from "@opencode/client"
import { Service } from "@opencode/client/service"
import {
  connectV2Host,
  hostCompatibleFetch,
  validateHostEndpoint,
} from "../src/opencode/v2/connection.ts"

const hostUrl = "OPENCODE_PERMISSION_REVIEWER_HOST_URL"
const password = "OPENCODE_PASSWORD"
const legacyPassword = "OPENCODE_SERVER_PASSWORD"
const stateHome = "XDG_STATE_HOME"
const originalEnv = {
  [hostUrl]: process.env[hostUrl],
  [password]: process.env[password],
  [legacyPassword]: process.env[legacyPassword],
  [stateHome]: process.env[stateHome],
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

/** The bundled client exposes `make` as an accessor, which bun's spyOn
 *  cannot mock and whose setter ignores assignments; redefining the
 *  property works and the original descriptor restores cleanly. */
function stubMake(impl: () => OpenCodeClient) {
  const descriptor = Object.getOwnPropertyDescriptor(OpenCode, "make")!
  const make = mock(impl)
  Object.defineProperty(OpenCode, "make", {
    value: make,
    enumerable: descriptor.enumerable ?? false,
    configurable: true,
    writable: true,
  })
  return {
    make,
    restore: () => {
      Object.defineProperty(OpenCode, "make", descriptor)
    },
  }
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
  const { make, restore } = stubMake(() => fakeClient("expected"))
  try {
    await expect(
      connectV2Host("/workspace", "expected", "2.0.3", AbortSignal.timeout(1000)),
    ).rejects.toThrow("requires OPENCODE_PASSWORD")
    expect(make).not.toHaveBeenCalled()
  } finally {
    restore()
  }
})

test("discovered V2 host connection rejects missing authentication", async () => {
  delete process.env[hostUrl]
  const discover = spyOn(Service, "discover").mockResolvedValue({
    url: "http://127.0.0.1:4096/",
    auth: undefined,
  } as Awaited<ReturnType<typeof Service.discover>>)
  const { make, restore } = stubMake(() => fakeClient("expected"))
  try {
    await expect(
      connectV2Host("/workspace", "expected", "2.0.3", AbortSignal.timeout(1000)),
    ).rejects.toThrow("unauthenticated host")
    expect(make).not.toHaveBeenCalled()
  } finally {
    discover.mockRestore()
    restore()
  }
})

test("V2 host connection rejects an instance identity mismatch", async () => {
  process.env[hostUrl] = "http://127.0.0.1:4096/"
  process.env[password] = "synthetic-host-password"
  const { make, restore } = stubMake(() => fakeClient("another-instance"))
  try {
    await expect(
      connectV2Host("/workspace", "expected", "2.0.3", AbortSignal.timeout(1000)),
    ).rejects.toThrow("does not belong to this host generation")
    expect(make).toHaveBeenCalledTimes(1)
  } finally {
    restore()
  }
})

test("V2 host transport rewrites only the legacy session wait endpoint", async () => {
  const paths: string[] = []
  const delegate = mock(async (input: RequestInfo | URL) => {
    paths.push(new URL(input instanceof Request ? input.url : input.toString()).pathname)
    return new Response(null, { status: 204 })
  }) as unknown as typeof globalThis.fetch
  await hostCompatibleFetch(
    "2.0.3",
    delegate,
  )(new URL("http://127.0.0.1:4096/api/experimental/session/ses_fixture/wait"))
  await hostCompatibleFetch(
    "2.0.4",
    delegate,
  )(new URL("http://127.0.0.1:4096/api/experimental/session/ses_fixture/wait"))
  expect(paths).toEqual([
    "/api/session/ses_fixture/wait",
    "/api/experimental/session/ses_fixture/wait",
  ])
})

test("V2 host connection falls back to a compatible registered service", async () => {
  delete process.env[hostUrl]
  const root = await mkdtemp(join(tmpdir(), "reviewer-v2-service-"))
  process.env[stateHome] = root
  await mkdir(join(root, "opencode"))
  await writeFile(
    join(root, "opencode", "service.json"),
    JSON.stringify({
      version: "2.0.3",
      url: "http://127.0.0.1:4096/",
      pid: 123,
      password: "synthetic-service-password",
    }),
  )
  const discover = spyOn(Service, "discover").mockResolvedValue(undefined)
  const { make, restore } = stubMake(() => fakeClient("expected"))
  try {
    await connectV2Host("/workspace", "expected", "2.0.3", AbortSignal.timeout(1000))
    expect(make).toHaveBeenCalledTimes(1)
    const options = (
      make.mock.calls as unknown as Array<[Parameters<typeof OpenCode.make>[0]]>
    )[0]?.[0]
    expect(options).toMatchObject({
      baseUrl: "http://127.0.0.1:4096/",
      headers: {
        authorization: `Basic ${Buffer.from("opencode:synthetic-service-password").toString("base64")}`,
      },
    })
  } finally {
    discover.mockRestore()
    restore()
    await rm(root, { recursive: true, force: true })
  }
})
