import { describe, expect, test } from "bun:test"
import type { TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui"
import { tui } from "./tui-loader.ts"
import { createUiStatus, encodeUiStatus } from "../src/ui-protocol.ts"
import { request } from "./helpers.ts"

/**
 * Headless contract tests for the TUI overlay slot.
 *
 * The host renders the `app` slot by invoking the registered factory inside a
 * tracked computation, and it only re-invokes the factory when the factory
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
 * - the review mode is pushed while a panel is active and popped when gone;
 * - manual outcomes toast instead of occupying the panel slot;
 * - the factory source still reads the revision signal directly.
 */

type EventHandler = (event: never) => void

interface CapturedApi {
  api: TuiPluginApi
  handlers: Map<string, EventHandler[]>
  factory: (() => unknown) | undefined
  /** By-reference mode bookkeeping: a bare number would be snapshotted. */
  mode: { pushes: string[]; pops: number }
  toasts: Array<{ title?: string }>
}

async function captureOverlay(): Promise<CapturedApi> {
  const handlers = new Map<string, EventHandler[]>()
  const mode = { pushes: [] as string[], pops: 0 }
  const toasts: Array<{ title?: string }> = []
  let factory: (() => unknown) | undefined

  const api = {
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
      register: (plugin: { slots: { app?: () => unknown } }) => {
        factory = plugin.slots.app
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
  return { api, handlers, factory, mode, toasts }
}

function fire(captured: CapturedApi, type: string, event: unknown): void {
  for (const handler of captured.handlers.get(type) ?? []) handler(event as never)
}

/** Invokes the factory; reports whether it attempted to create panel elements.
 *  Element creation without a renderer throws, which is exactly the evidence
 *  we want: an idle factory returns a falsy value without touching elements. */
function factoryAttempt(captured: CapturedApi): { rendered: boolean; threw: boolean } {
  expect(captured.factory).toBeFunction()
  try {
    captured.factory!()
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
  test("registers a single app slot and subscribes to the event trio", async () => {
    const captured = await captureOverlay()
    expect(captured.factory).toBeFunction()
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
    expect(captured.mode.pushes).toHaveLength(0)
  })

  test("a permission ask makes the factory attempt a panel render and pushes the review mode", async () => {
    const captured = await captureOverlay()
    fire(captured, "permission.asked", { type: "permission.asked", properties: request() })

    const attempt = factoryAttempt(captured)
    expect(attempt.rendered).toBe(true)
    expect(captured.mode.pushes).toEqual(["permission-reviewer"])
    expect(captured.mode.pops).toBe(0)
  })

  test("an approved decision keeps the panel and survives the reply", async () => {
    const captured = await captureOverlay()
    fire(captured, "permission.asked", { type: "permission.asked", properties: request() })
    fire(captured, "tui.command.execute", statusEvent("approved"))
    fire(captured, "permission.replied", { properties: { requestID: "per_1" } })

    expect(factoryAttempt(captured).rendered).toBe(true)
    expect(captured.mode.pops).toBe(0)
  })

  test("a reply to an unresolved review clears the panel and pops the mode", async () => {
    const captured = await captureOverlay()
    fire(captured, "permission.asked", { type: "permission.asked", properties: request() })
    const first = factoryAttempt(captured)
    expect(first.rendered).toBe(true)

    fire(captured, "permission.replied", { properties: { requestID: "per_1" } })
    const attempt = factoryAttempt(captured)
    expect(attempt.threw).toBe(false)
    expect(captured.mode.pops).toBe(1)
  })

  test("a manual outcome toasts and never occupies the panel or the mode", async () => {
    const captured = await captureOverlay()
    fire(captured, "permission.asked", { type: "permission.asked", properties: request() })
    fire(captured, "tui.command.execute", statusEvent("manual"))

    expect(captured.toasts.map((t) => t.title)).toEqual(["Manual review required"])
    const attempt = factoryAttempt(captured)
    expect(attempt.threw).toBe(false)
    // Manual never occupied the panel, so the mode was never pushed and there
    // is nothing to pop.
    expect(captured.mode.pushes).toHaveLength(0)
    expect(captured.mode.pops).toBe(0)
  })

  test("factory body reads the revision signal directly (host re-render contract)", async () => {
    const captured = await captureOverlay()
    // The host only re-invokes the app factory when the factory itself reads a
    // signal during execution. If this tripwire fails, the overlay renders
    // once at boot and npm-installed plugins never show panels again.
    expect(captured.factory!.toString()).toMatch(/\brevision\s*\(/)
  })

  test("events for other sessions never activate the panel", async () => {
    const captured = await captureOverlay()
    const foreign = request({ id: "per_other", sessionID: "ses_elsewhere" })
    fire(captured, "permission.asked", { type: "permission.asked", properties: foreign })

    const attempt = factoryAttempt(captured)
    expect(attempt.threw).toBe(false)
    expect(captured.mode.pushes).toHaveLength(0)
  })
})
