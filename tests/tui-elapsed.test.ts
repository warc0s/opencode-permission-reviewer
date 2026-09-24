import { afterEach, describe, expect, test } from "bun:test"
import type { TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setGlobalConfigPathForTests } from "../src/config/loader.ts"
import { request } from "./helpers.ts"
import { testRender, tui } from "./tui-loader.ts"

const disposers: Array<() => void> = []
const tempDirs: string[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  setGlobalConfigPathForTests(undefined)
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true })
})

type EventHandler = (event: never) => void

/**
 * Headless render test for the review panel's live texts.
 *
 * The elapsed counter and the spinner are driven by a 250ms tick signal. A
 * text child that reads no signal while evaluating (e.g. an elapsed string
 * computed from Date.now() alone) is evaluated once at mount and freezes,
 * which is exactly the "seconds do not advance" regression this pins. The
 * solid transform comes from the shared tui-loader, so the panel here is
 * compiled exactly as the host compiles it, and the tick interval is left
 * running: the elapsed value must grow between captured frames.
 */
describe("tui panel live elapsed counter", () => {
  test("elapsed seconds advance while the reviewing panel is visible", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "reviewer-tui-config-"))
    tempDirs.push(configDir)
    const configPath = join(configDir, "permission-reviewer.jsonc")
    writeFileSync(configPath, JSON.stringify({ model: "fixture/shared", variant: "high" }))
    setGlobalConfigPathForTests(configPath)
    const handlers = new Map<string, EventHandler[]>()
    let factory: (() => unknown) | undefined

    const api = {
      lifecycle: { onDispose: (fn: () => void) => disposers.push(fn) },
      route: {
        current: { name: "session", params: { sessionID: "ses_main" } },
        register: () => () => {},
        navigate: () => {},
      },
      theme: {
        current: {
          success: "#0f0",
          error: "#f00",
          info: "#00f",
          text: "#eee",
          textMuted: "#999",
          backgroundPanel: "#111",
        },
        install: () => {},
      },
      event: {
        on: (type: string, handler: EventHandler) => {
          const list = handlers.get(type) ?? []
          list.push(handler)
          handlers.set(type, list)
          return () => {}
        },
      },
      ui: { toast: () => {} },
      state: { session: { get: () => undefined } },
      mode: { current: () => "normal", push: () => () => {} },
      slots: {
        register: (plugin: { slots: { app?: () => unknown } }) => {
          factory = plugin.slots.app
        },
      },
    } as unknown as TuiPluginApi

    await tui(api, {}, {
      id: "opencode-permission-reviewer",
      source: "npm",
      spec: "opencode-permission-reviewer@1.3.1",
      target: "/plugin/target",
      first_time: Date.now(),
      last_time: Date.now(),
      time_changed: Date.now(),
      load_count: 1,
      fingerprint: "test",
      state: "first",
    } satisfies TuiPluginMeta)
    expect(factory).toBeFunction()

    for (const handler of handlers.get("permission.asked") ?? []) {
      handler({ type: "permission.asked", properties: request() } as never)
    }

    const setup = await testRender(() => factory!() as Element, { width: 80, height: 24 })
    disposers.push(() => setup.renderer.destroy())
    await setup.flush()
    expect(setup.captureCharFrame()).toContain("No action needed")

    const readElapsed = (): number => {
      const frame = setup.captureCharFrame()
      const match = frame.match(/(\d+\.\d)s/)
      expect(match, `elapsed text not found in frame:\n${frame}`).toBeDefined()
      return Number(match?.[1])
    }

    expect(setup.captureCharFrame()).toContain("Reviewing this permission")
    expect(setup.captureCharFrame()).toContain("fixture/shared")
    expect(setup.captureCharFrame()).toContain("high")
    const first = readElapsed()
    // At least two 250ms ticks pass before the second capture.
    await Bun.sleep(700)
    await setup.flush()
    const second = readElapsed()
    expect(second).toBeGreaterThan(first)
  }, 10_000)
})
