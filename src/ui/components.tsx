/** @jsxImportSource @opentui/solid */
import { Show } from "solid-js"
import type { ColorInput } from "@opentui/core"
import type { ReviewUiStatus } from "../ui-protocol.ts"

export interface ReviewTheme {
  backgroundPanel: ColorInput
  text: ColorInput
  textMuted: ColorInput
  info: ColorInput
  success: ColorInput
  error: ColorInput
}
export const SPINNER = ["◐", "◓", "◑", "◒"] as const

/** Compact, non-modal progress strip for hosts with an editable composer. */
export function ReviewProgress(props: {
  theme: () => ReviewTheme
  status: ReviewUiStatus
  frame: () => number
}) {
  const singleLine = (value: string) => value.replace(/[\r\n\t]+/g, " ")
  const elapsed = () => {
    props.frame()
    return `${(Math.max(0, Date.now() - props.status.emittedAt) / 1_000).toFixed(1)}s`
  }
  return (
    <box
      height={2}
      flexShrink={0}
      overflow="hidden"
      backgroundColor={props.theme().backgroundPanel}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <box height={1} flexDirection="row" gap={1}>
        <text
          fg={props.theme().info}
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          wrapMode="none"
          truncate
        >
          {SPINNER[props.frame() % SPINNER.length] ?? "◐"} Reviewing this permission
          <span style={{ fg: props.theme().textMuted }}>
            {" "}
            · {singleLine(props.status.model)} · {singleLine(props.status.variant)}
          </span>
        </text>
        <text fg={props.theme().textMuted} flexShrink={0} wrapMode="none">
          {elapsed()}
        </text>
      </box>
      <text fg={props.theme().text} wrapMode="none" truncate>
        <span style={{ fg: props.theme().textMuted }}>{props.status.permission} · </span>
        {singleLine(props.status.action)}
        <Show when={props.status.actorName}>
          <span style={{ fg: props.theme().textMuted }}>
            {" "}
            · actor {singleLine(props.status.actorName ?? "")}
          </span>
        </Show>
      </text>
    </box>
  )
}

export function ReviewOverlay(props: {
  theme: () => ReviewTheme
  status: ReviewUiStatus
  /** Spinner signal, read inside text children so only those update per tick. */
  frame: () => number
}) {
  const theme = props.theme
  const elapsed = () => {
    // Reading the tick signal inside the text child is what re-renders it every
    // 250ms: Date.now() and status.emittedAt are plain values, so a text that
    // reads no signal is evaluated once at mount and freezes.
    props.frame()
    const elapsedMs = Math.max(0, Date.now() - props.status.emittedAt)
    return `${(elapsedMs / 1_000).toFixed(1)}s`
  }

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
      borderColor={theme().info}
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
          <text fg={theme().info}>{SPINNER[props.frame() % SPINNER.length] ?? "◐"}</text>
          <text fg={theme().text}>Reviewing this permission</text>
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
        <box paddingLeft={2} flexDirection="row" gap={1}>
          <text fg={theme().textMuted}>
            {props.status.model} · reasoning {props.status.variant}
          </text>
          <box flexGrow={1} />
          <text fg={theme().textMuted}>No action needed</text>
        </box>
      </box>
    </box>
  )
}

export function ReviewResult(props: { theme: () => ReviewTheme; status: ReviewUiStatus }) {
  const theme = props.theme
  const appearance = () => {
    if (props.status.phase === "unknown") {
      return { color: theme().textMuted, icon: "?", title: "Review status unavailable" }
    }
    if (props.status.phase === "approved") {
      return { color: theme().success, icon: "✓", title: "Review approved" }
    }
    // Fail-closed escalate→deny is distinct from an explicit reviewer/policy deny.
    if (props.status.escalationDisposition === "deny") {
      return { color: theme().error, icon: "✕", title: "Review blocked (fail-closed)" }
    }
    return { color: theme().error, icon: "✕", title: "Review blocked" }
  }
  const singleLine = (value: string) => value.replace(/[\r\n\t]+/g, " ")

  return (
    <box
      height={props.status.reason ? 2 : 1}
      flexShrink={0}
      overflow="hidden"
      backgroundColor={theme().backgroundPanel}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={appearance().color} wrapMode="none" truncate>
        {appearance().icon} {appearance().title} · {props.status.permission} ·{" "}
        {singleLine(props.status.action)}
      </text>
      <Show when={props.status.reason}>
        <text fg={theme().textMuted} wrapMode="none" truncate>
          {singleLine(props.status.reason ?? "")}
        </text>
      </Show>
    </box>
  )
}
