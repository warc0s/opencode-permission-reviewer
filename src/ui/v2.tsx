/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui"
import type { ColorInput } from "@opentui/core"
import { createSignal, Show } from "solid-js"
import { ReviewerRpc } from "./rpc.ts"
import { ReviewProgress, ReviewResult, type ReviewTheme } from "./components.tsx"
import { ReviewUiState } from "../ui-state.ts"
import { decodeUiStatus, encodeUiStatus, type ReviewUiStatus } from "../ui-protocol.ts"

type Context = Parameters<Plugin.Definition["setup"]>[0]
const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
const color = (value: unknown): ColorInput | undefined => {
  if (typeof value === "string") return value
  const candidate = object(value)
  return candidate && "buffer" in candidate ? (value as ColorInput) : undefined
}
const FALLBACK_THEME = {
  backgroundPanel: "#111111",
  text: "#eeeeee",
  textMuted: "#999999",
  info: "#4da3ff",
  success: "#48c774",
  error: "#ff5c5c",
} satisfies ReviewTheme

export function resolveReviewTheme(value: unknown): ReviewTheme {
  const host = object(value)
  if (!host) return FALLBACK_THEME
  const background = object(host.background)
  const surface = object(background?.surface)
  const raised = object(background?.raised)
  const text = object(host.text)
  const status = object(text?.status)
  const feedback = object(text?.feedback)
  const infoFeedback = object(feedback?.info)
  const successFeedback = object(feedback?.success)
  const errorFeedback = object(feedback?.error)
  return {
    backgroundPanel:
      color(surface?.overlay) ??
      color(raised?.base) ??
      color(host.backgroundPanel) ??
      FALLBACK_THEME.backgroundPanel,
    text: color(text?.default) ?? color(text?.base) ?? color(host.text) ?? FALLBACK_THEME.text,
    textMuted:
      color(text?.subdued) ??
      color(text?.muted) ??
      color(host.textMuted) ??
      FALLBACK_THEME.textMuted,
    info:
      color(status?.running) ??
      color(infoFeedback?.base) ??
      color(host.info) ??
      FALLBACK_THEME.info,
    success:
      color(successFeedback?.default) ??
      color(successFeedback?.base) ??
      color(host.success) ??
      FALLBACK_THEME.success,
    error:
      color(errorFeedback?.default) ??
      color(errorFeedback?.base) ??
      color(host.error) ??
      FALLBACK_THEME.error,
  }
}

export async function setupTuiV2(ctx: Context): Promise<() => void> {
  let directory = ctx.location?.directory
  const rpc = ctx.client.rpc(ReviewerRpc)
  const [revision, touch] = createSignal(0)
  const [frame, tick] = createSignal(0)
  let state = new ReviewUiState({ model: "", variant: "", timeoutMs: 180_000 })
  let generation: string | undefined
  let sequence = -1
  let stopped = false
  let controller: AbortController | undefined
  let reconnect: ReturnType<typeof setTimeout> | undefined
  let popMode: (() => void) | undefined
  let routeSession: string | undefined
  const active = () => {
    revision()
    const route = ctx.ui.router.current()
    return route.type === "session"
      ? state.activeFor(route.sessionID, (id) => ctx.data.session.get(id)?.parentID)
      : undefined
  }
  const theme = (): ReviewTheme => resolveReviewTheme((ctx as unknown as { theme?: unknown }).theme)
  const refresh = () => {
    touch((value) => value + 1)
    const reviewing = active()?.phase === "reviewing"
    if (reviewing && !popMode) {
      try {
        popMode = ctx.keymap.mode.push("permission-reviewer")
      } catch {
        /* The panel remains useful without a host mode. */
      }
    }
    if (!reviewing && popMode) {
      popMode()
      popMode = undefined
    }
  }
  const applyStatus = (value: unknown) => {
    const status = decodeUiStatus(encodeUiStatus(value as ReviewUiStatus))
    if (!status) return
    state.apply(status)
    if (status.phase === "manual")
      ctx.ui.toast.show({
        variant: "warning",
        title: "Manual review required",
        message: status.reason ?? "The host requires your decision.",
      })
  }
  const update = (value: unknown, owner: AbortController) => {
    if (owner !== controller || owner.signal.aborted) return
    const event = object(value)
    if (!event || event.directory !== directory) return
    if (typeof event.generation !== "string") return
    if (event.generation !== generation) {
      owner.abort()
      return
    }
    if (typeof event.revision !== "number" || event.revision <= sequence) return
    sequence = event.revision
    applyStatus(event.status)
    refresh()
  }
  const markDisconnected = () => {
    for (const status of state.all())
      if (status.phase === "reviewing")
        state.apply({
          ...status,
          phase: "unknown",
          emittedAt: Date.now(),
          reason: "Reconnecting to reviewer status",
        })
    refresh()
  }
  const connect = async () => {
    controller?.abort()
    clearTimeout(reconnect)
    if (!directory || stopped) return
    const scopeDirectory = directory
    const current = new AbortController()
    controller = current
    const buffered: unknown[] = []
    let loading = true
    const stream = (async () => {
      for await (const event of rpc.events.subscribe("review.updated", {
        signal: current.signal,
      })) {
        if (event.location.directory !== scopeDirectory) continue
        if (loading) {
          if (buffered.length >= 512) throw new Error("Reviewer event buffer overflow")
          buffered.push(event.data)
        } else update(event.data, current)
      }
    })()
    void stream.catch(() => {})
    try {
      const ready = ctx.client.event.subscribe({ signal: current.signal })[Symbol.asyncIterator]()
      try {
        await ready.next()
      } finally {
        await ready.return?.()
      }
      const snapshot = object(
        await rpc.snapshot({}, { location: { directory: scopeDirectory }, signal: current.signal }),
      )
      if (
        !snapshot ||
        snapshot.directory !== scopeDirectory ||
        typeof snapshot.generation !== "string" ||
        typeof snapshot.revision !== "number" ||
        !Array.isArray(snapshot.reviews)
      )
        throw new Error("Invalid reviewer snapshot")
      if (current.signal.aborted) return
      state = new ReviewUiState({ model: "", variant: "", timeoutMs: 180_000 })
      generation = snapshot.generation
      sequence = snapshot.revision
      for (const status of snapshot.reviews) applyStatus(status)
      loading = false
      for (const event of buffered) update(event, current)
      refresh()
      await stream
      if (controller === current && !stopped) markDisconnected()
    } catch {
      if (controller !== current || stopped) return
      // Unknown means the UI lacks authoritative state, never human approval.
      markDisconnected()
    } finally {
      current.abort()
      await stream.catch(() => {})
      if (!stopped && controller === current)
        reconnect = setTimeout(() => {
          void connect()
        }, 1000)
    }
  }
  void connect()
  const slot = ctx.ui.slot({
    append: "app",
    render: () => {
      const reviewing = () => {
        const status = active()
        return status?.phase === "reviewing" ? status : undefined
      }
      const terminal = () => {
        const status = active()
        return status && status.phase !== "reviewing" && status.phase !== "manual"
          ? status
          : undefined
      }
      return (
        <>
          <Show when={reviewing()} keyed>
            {(current) => (
              <box position="absolute" bottom={0} left={0} right={0}>
                <ReviewProgress theme={theme} status={current} frame={frame} />
              </box>
            )}
          </Show>
          <Show when={terminal()} keyed>
            {(current) => (
              <box position="absolute" bottom={0} left={0} right={0}>
                <ReviewResult theme={theme} status={current} />
              </box>
            )}
          </Show>
        </>
      )
    },
  })
  const timer = setInterval(() => {
    tick((value) => value + 1)
    const route = ctx.ui.router.current()
    const nextSession = route.type === "session" ? route.sessionID : undefined
    if (nextSession !== routeSession) {
      routeSession = nextSession
      refresh()
    }
    const nextDirectory =
      route.type === "session"
        ? (ctx.data.session.get(route.sessionID)?.location.directory ?? ctx.location?.directory)
        : ctx.location?.directory
    if (nextDirectory !== directory) {
      directory = nextDirectory
      state = new ReviewUiState({ model: "", variant: "", timeoutMs: 180_000 })
      refresh()
      void connect()
    }
    const expired = state.expire()
    if (expired.length) controller?.abort()
    if (expired.length || state.dismissResults().length) refresh()
  }, 250)
  return () => {
    stopped = true
    controller?.abort()
    clearTimeout(reconnect)
    clearInterval(timer)
    popMode?.()
    slot()
  }
}
