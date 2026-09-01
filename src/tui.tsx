/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createSignal, Show } from "solid-js"
import { DEFAULT_CONFIG, resolveConfig } from "./config.ts"
// Import the normalizer directly. Going through ./runtime.ts would evaluate the
// whole server engine (coordinator, git/ssh evidence, node:child_process) inside
// the TUI process for a single unused re-export.
import { extractPermissionRequest } from "./opencode/event-normalizer.ts"
import { decodeUiStatus, type ReviewUiStatus } from "./ui-protocol.ts"
import { ReviewUiState } from "./ui-state.ts"

const SPINNER = ["◐", "◓", "◑", "◒"] as const
const REVIEW_MODE = "permission-reviewer"

function routeSessionID(api: TuiPluginApi): string | undefined {
  const route = api.route.current
  if (route.name !== "session") return
  const params = "params" in route ? route.params : undefined
  const sessionID = params?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

function parentSessionID(api: TuiPluginApi, sessionID: string): string | undefined {
  return api.state.session.get(sessionID)?.parentID
}

function notifyManual(api: TuiPluginApi, status: ReviewUiStatus): void {
  api.ui.toast({
    variant: "warning",
    title: "Manual review required",
    message:
      status.reason ?? "The reviewer could not decide. This permission now needs your approval.",
    duration: 8_000,
  })
}

export const tui: TuiPlugin = async (api, options) => {
  const config = resolveConfig(options)
  const state = new ReviewUiState({
    model: config.model,
    variant: config.variant,
    timeoutMs: config.timeoutMs,
  })

  // Signal bumps whenever the UI state changes. The slot factory below reads it
  // directly in its body, which is what makes the host re-render the panel:
  // a factory that only returns a component without reading any signal in its
  // own scope renders exactly once at boot and never updates again.
  const [revision, setRevision] = createSignal(0)
  const [frame, setFrame] = createSignal(0)
  const touch = () => setRevision((value) => value + 1)

  const active = () => {
    const sessionID = routeSessionID(api)
    if (!sessionID) return
    return state.activeFor(sessionID, (id) => parentSessionID(api, id))
  }

  let popMode: (() => void) | undefined
  const syncMode = () => {
    const status = active()
    const wanted = status !== undefined && status.phase !== "manual"
    if (wanted && popMode === undefined) {
      try {
        popMode = api.mode.push(REVIEW_MODE)
      } catch {
        // mode.push can throw if the host rejects unknown modes; keep the panel.
      }
    } else if (!wanted && popMode !== undefined) {
      popMode()
      popMode = undefined
    }
  }

  api.event.on("permission.asked", (event) => {
    const request = extractPermissionRequest(event)
    if (!request) return
    state.asked(request)
    touch()
  })
  api.event.on("permission.replied", (event) => {
    state.replied(event.properties.requestID)
    touch()
  })
  api.event.on("tui.command.execute", (event) => {
    const status = decodeUiStatus(event.properties.command)
    if (!status) return
    if (!state.apply(status)) return
    if (status.phase === "manual") notifyManual(api, status)
    touch()
  })

  // Drives the spinner and the watchdog/expiry transitions. The interval lives
  // for the lifetime of the plugin activation; the scoped plugin API disposes
  // the event listeners above, but timers have no scope hook to unwind.
  setInterval(() => {
    setFrame((value) => (value + 1) % SPINNER.length)
    const expired = state.expire()
    for (const status of expired) notifyManual(api, status)
    const dismissed = state.dismissResults()
    if (expired.length > 0 || dismissed.length > 0) touch()
  }, 250)

  api.slots.register({
    order: 1_000,
    slots: {
      app() {
        // Load-bearing direct read: it subscribes the slot's render pass to
        // every state transition (touch), so the factory re-runs and renders
        // the current status. The spinner frame is deliberately NOT read here
        // (only inside the panel's text children) so 250ms ticks update those
        // texts without re-running this factory.
        revision()
        const status = active()
        syncMode()
        return (
          <Show when={status} keyed>
            {(current) =>
              current.phase === "manual" ? null : (
                <ReviewPanel api={api} status={current} frame={frame} />
              )
            }
          </Show>
        )
      },
    },
  })
}

function ReviewPanel(props: {
  api: TuiPluginApi
  status: ReviewUiStatus
  /** Spinner signal, read inside text children so only those update per tick. */
  frame: () => number
}) {
  const theme = () => props.api.theme.current
  const appearance = () => {
    if (props.status.phase === "approved") {
      return { color: theme().success, icon: "✓", title: "Review approved" }
    }
    if (props.status.phase === "denied") {
      // Fail-closed escalate→deny is distinct from an explicit reviewer/policy deny.
      if (props.status.escalationDisposition === "deny") {
        return { color: theme().error, icon: "✕", title: "Review blocked (fail-closed)" }
      }
      return { color: theme().error, icon: "✕", title: "Review blocked" }
    }
    return {
      color: theme().info,
      icon: SPINNER[props.frame() % SPINNER.length] ?? "◐",
      title: "Reviewing this permission",
    }
  }
  const elapsed = () => `${((Date.now() - props.status.emittedAt) / 1_000).toFixed(1)}s`

  return (
    <box
      position="absolute"
      left={0}
      right={0}
      bottom={0}
      height="auto"
      maxHeight={12}
      overflow="hidden"
      backgroundColor={theme().backgroundPanel}
      border={["left"]}
      borderColor={appearance().color}
      flexDirection="column"
      onMouseDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onMouseUp={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <box
        flexDirection="column"
        gap={1}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={3}
      >
        <box flexDirection="row" gap={1}>
          <text fg={appearance().color}>{appearance().icon}</text>
          <text fg={theme().text}>{appearance().title}</text>
          <box flexGrow={1} />
          <text fg={theme().textMuted}>{elapsed()}</text>
        </box>

        <box flexDirection="row" gap={1} paddingLeft={2}>
          <text fg={theme().textMuted}>{props.status.permission}</text>
          <text fg={theme().text} wrapMode="word">
            {props.status.action}
          </text>
          <Show when={props.status.actorName}>
            <text fg={theme().textMuted}>· actor {props.status.actorName}</text>
          </Show>
        </box>

        <Show when={props.status.phase === "reviewing"}>
          <box paddingLeft={2} flexDirection="row" gap={1}>
            <text fg={theme().textMuted}>
              {props.status.model} · reasoning {props.status.variant}
            </text>
            <box flexGrow={1} />
            <text fg={theme().textMuted}>No action needed</text>
          </box>
        </Show>

        <Show when={props.status.phase !== "reviewing" && props.status.reason}>
          <box paddingLeft={2}>
            <text fg={theme().textMuted} wrapMode="word">
              {props.status.reason}
            </text>
          </box>
        </Show>
      </box>
    </box>
  )
}

const module: TuiPluginModule = {
  id: "opencode-permission-reviewer",
  tui,
}

export default module
export { ReviewUiState, decodeUiStatus, DEFAULT_CONFIG }
