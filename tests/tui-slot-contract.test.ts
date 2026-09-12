import { afterEach, describe, expect, test } from "bun:test"
import type { TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui"
import { tui } from "./tui-loader.ts"
import { createUiStatus, encodeUiStatus } from "../src/ui-protocol.ts"
import { request } from "./helpers.ts"

/**
 * Headless contract tests for the TUI overlay and result slots.
 *
 * The host renders each slot by invoking its factory inside a tracked
 * computation, and it only re-invokes the factory when the factory
 * body itself reads a Solid signal. That contract is what keeps the overlay
 * alive: a factory that reads no signal directly renders exactly once at boot
 * and npm-installed plugins then never show any panel (the slot view is not
 * re-created for them). These tests pin the parts of that contract that can be
 * checked without a real terminal renderer:
 *
 * - the factory reflects the current state on every (re-)invocation, using the
 *   "No renderer found" throw as proof that a panel render was attempted
 *   (element creation needs a renderer; nothing is created when idle);
 * - event wiring updates the shared state machine (asked/replied/decisions);
 * - the review mode is released independently of result rendering;
 * - manual outcomes toast instead of occupying the panel slot;
 * - the factory source still reads the revision signal directly.
 */

const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})

type EventHandler = (event: never) => void

interface CapturedApi {
  api: TuiPluginApi
  handlers: Map<string, EventHandler[]>
  factories: Partial<Record<"app" | "app_bottom", () => unknown>>
  /** By-reference mode bookkeeping: a bare number would be snapshotted. */
  mode: { pushes: string[]; pops: number }
  toasts: Array<{ title?: string }>
  dispose: () => void
}

async function captureOverlay(): Promise<CapturedApi> {
  const handlers = new Map<string, EventHandler[]>()
  const mode = { pushes: [] as string[], pops: 0 }
  const toasts: Array<{ title?: string }> = []
  let factories: Partial<Record<"app" | "app_bottom", () => unknown>> = {}

  let dispose = () => {}
  const api = {
    lifecycle: {
      onDispose: (fn: () => void) => {
        dispose = fn
        disposers.push(fn)
      },
    },
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
    ui: { toast: (input: { title?: string }) => void toasts.push(input) },
    state: { session: { get: () => undefined } },
    mode: {
      current: () => "normal",
      push: (name: string) => {
        mode.pushes.push(name)
        return () => {
          mode.pops++
        }
      },
    },
    slots: {
      register: (plugin: { slots: CapturedApi["factories"] }) => {
        factories = plugin.slots
      },
    },
  } as unknown as TuiPluginApi

  await tui(api, {}, {
    id: "opencode-permission-reviewer",
    source: "npm",
    spec: "opencode-permission-reviewer@1.2.4",
    target: "/plugin/target",
    first_time: Date.now(),
    last_time: Date.now(),
    time_changed: Date.now(),
    load_count: 1,
    fingerprint: "test",
    state: "first",
  } satisfies TuiPluginMeta)
  return { api, handlers, factories, mode, toasts, dispose }
}

function fire(captured: CapturedApi, type: string, event: unknown): void {
  for (const handler of captured.handlers.get(type) ?? []) handler(event as never)
}

/** Invokes the factory; reports whether it attempted to create panel elements.
 *  Element creation without a renderer throws, which is exactly the evidence
 *  we want: an idle factory returns a falsy value without touching elements. */
function factoryAttempt(
  captured: CapturedApi,
  slot: "app" | "app_bottom" = "app",
): { rendered: boolean; threw: boolean } {
  const factory = captured.factories[slot]
  expect(factory).toBeFunction()
  try {
    factory!()
    return { rendered: false, threw: false }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { rendered: message.includes("No renderer found"), threw: true }
  }
}

function statusEvent(
  phase: "approved" | "denied" | "manual",
  overrides: Record<string, unknown> = {},
) {
  const status = createUiStatus(request(), phase, {
    model: "test-model",
    variant: "high",
    timeoutMs: 60_000,
    reason: "test reason",
    emittedAt: Date.now(),
    ...overrides,
  })
  return { properties: { command: encodeUiStatus(status) } }
}

describe("tui overlay slot contract", () => {
  test("registers separate overlay and result slots and subscribes to the event trio", async () => {
    const captured = await captureOverlay()
    expect(Object.keys(captured.factories).sort()).toEqual(["app", "app_bottom"])
    expect([...captured.handlers.keys()].sort()).toEqual([
      "permission.asked",
      "permission.replied",
      "tui.command.execute",
    ])
  })

  test("idle factory renders nothing and pushes no mode", async () => {
    const captured = await captureOverlay()
    const attempt = factoryAttempt(captured)
    expect(attempt.threw).toBe(false)
    expect(factoryAttempt(captured, "app_bottom").threw).toBe(false)
    expect(captured.mode.pushes).toHaveLength(0)
  })

  test("a permission ask renders only the overlay and pushes the review mode", async () => {
    const captured = await captureOverlay()
    fire(captured, "permission.asked", { type: "permission.asked", properties: request() })

    const attempt = factoryAttempt(captured)
    expect(attempt.rendered).toBe(true)
    expect(factoryAttempt(captured, "app_bottom").threw).toBe(false)
    expect(captured.mode.pushes).toEqual(["permission-reviewer"])
    expect(captured.mode.pops).toBe(0)
  })

  test("an approved decision moves to the bottom strip, releases the mode, and survives the reply", async () => {
    const captured = await captureOverlay()
    fire(captured, "permission.asked", { type: "permission.asked", properties: request() })
    fire(captured, "tui.command.execute", statusEvent("approved"))
    fire(captured, "permission.replied", { properties: { requestID: "per_1" } })

    expect(factoryAttempt(captured).threw).toBe(false)
    expect(factoryAttempt(captured, "app_bottom").rendered).toBe(true)
    expect(captured.mode.pops).toBe(1)
  })

  test("a reply to an unresolved review clears the panel and pops the mode", async () => {
    const captured = await captureOverlay()
    fire(captured, "permission.asked", { type: "permission.asked", properties: request() })
    const first = factoryAttempt(captured)
    expect(first.rendered).toBe(true)

    fire(captured, "permission.replied", { properties: { requestID: "per_1" } })
    const attempt = factoryAttempt(captured)
    expect(attempt.threw).toBe(false)
    expect(factoryAttempt(captured, "app_bottom").threw).toBe(false)
    expect(captured.mode.pops).toBe(1)
  })

  test("a manual outcome toasts and never occupies the panel or the mode", async () => {
    const captured = await captureOverlay()
    fire(captured, "permission.asked", { type: "permission.asked", properties: request() })
    fire(captured, "tui.command.execute", statusEvent("manual"))

    expect(captured.toasts.map((t) => t.title)).toEqual(["Manual review required"])
    const attempt = factoryAttempt(captured)
    expect(attempt.threw).toBe(false)
    expect(factoryAttempt(captured, "app_bottom").threw).toBe(false)
    expect(captured.mode.pushes).toEqual(["permission-reviewer"])
    expect(captured.mode.pops).toBe(1)
  })

  test("a terminal result after the reply does not reacquire the mode", async () => {
    const captured = await captureOverlay()
    fire(captured, "permission.asked", { type: "permission.asked", properties: request() })
    fire(captured, "permission.replied", { properties: { requestID: "per_1" } })
    expect(captured.mode.pops).toBe(1)
    fire(captured, "tui.command.execute", statusEvent("denied"))
    expect(factoryAttempt(captured).threw).toBe(false)
    expect(factoryAttempt(captured, "app_bottom").rendered).toBe(true)
    expect(captured.mode.pushes).toEqual(["permission-reviewer"])
    expect(captured.mode.pops).toBe(1)
  })

  test("disposal releases the active mode only once", async () => {
    const captured = await captureOverlay()
    fire(captured, "permission.asked", { type: "permission.asked", properties: request() })
    captured.dispose()
    captured.dispose()
    expect(captured.mode.pops).toBe(1)
  })

  test("factory body reads the revision signal directly (host re-render contract)", async () => {
    const captured = await captureOverlay()
    // The host only re-invokes the app factory when the factory itself reads a
    // signal during execution. If this tripwire fails, the overlay renders
    // once at boot and npm-installed plugins never show panels again.
    for (const factory of Object.values(captured.factories)) {
      expect(factory.toString()).toMatch(/\brevision\s*\(/)
    }
  })

  test("events for other sessions never activate the panel", async () => {
    const captured = await captureOverlay()
    const foreign = request({ id: "per_other", sessionID: "ses_elsewhere" })
    fire(captured, "permission.asked", { type: "permission.asked", properties: foreign })

    const attempt = factoryAttempt(captured)
    expect(attempt.threw).toBe(false)
    expect(factoryAttempt(captured, "app_bottom").threw).toBe(false)
    expect(captured.mode.pushes).toHaveLength(0)
  })
})
