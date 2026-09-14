/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createSignal, Show } from "solid-js"
import { DEFAULT_CONFIG, resolveConfig } from "./config.ts"
// Import the normalizer directly. Going through ./runtime.ts would evaluate the
// whole server engine (coordinator, git/ssh evidence, node:child_process) inside
// the TUI process for a single unused re-export.
import { extractPermissionRequest } from "./opencode/event-normalizer.ts"
import { decodeUiStatus, type ReviewUiStatus } from "./ui-protocol.ts"
import { reviewBudgetMs } from "./core/review-attempt.ts"
import { ReviewUiState } from "./ui-state.ts"
import { ReviewOverlay, ReviewResult, SPINNER } from "./ui/components.tsx"
import { setupTuiV2 } from "./ui/v2.tsx"

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
    timeoutMs: reviewBudgetMs(config),
  })

  // Signal bumps whenever the UI state changes. Both slot factories read it
  // directly in their bodies, which makes the host re-render each panel:
  // a factory that only returns a component without reading any signal in its
  // own scope renders exactly once at boot and never updates again.
  const [revision, setRevision] = createSignal(0)
  const [frame, setFrame] = createSignal(0)
  const touch = () => {
    syncMode()
    setRevision((value) => value + 1)
  }

  const active = () => {
    const sessionID = routeSessionID(api)
    if (!sessionID) return
    return state.activeFor(sessionID, (id) => parentSessionID(api, id))
  }

  let popMode: (() => void) | undefined
  const syncMode = () => {
    const status = active()
    const wanted = status?.phase === "reviewing"
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

  // Keep watchdog and result expiry running even when the UI is hidden.
  const ticker = setInterval(() => {
    if (active()?.phase === "reviewing") setFrame((value) => (value + 1) % SPINNER.length)
    const expired = state.expire()
    const dismissed = state.dismissResults()
    if (expired.length > 0 || dismissed.length > 0) touch()
  }, 250)

  api.lifecycle.onDispose(() => {
    clearInterval(ticker)
    popMode?.()
    popMode = undefined
  })

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
          <Show when={status?.phase === "reviewing" ? status : undefined} keyed>
            {(current) => (
              <ReviewOverlay theme={() => api.theme.current} status={current} frame={frame} />
            )}
          </Show>
        )
      },
      app_bottom() {
        revision()
        const status = active()
        syncMode()
        return (
          <Show
            when={
              status?.phase === "approved" ||
              status?.phase === "denied" ||
              status?.phase === "unknown"
                ? status
                : undefined
            }
            keyed
          >
            {(current) => <ReviewResult theme={() => api.theme.current} status={current} />}
          </Show>
        )
      },
    },
  })
}

const module = {
  id: "opencode-permission-reviewer",
  tui,
  setup: setupTuiV2,
}

export default module
export { ReviewUiState, decodeUiStatus, DEFAULT_CONFIG }
