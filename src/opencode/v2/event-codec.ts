import type { OpenCodeEvent } from "@opencode/client"
import { AskDecisionRegistry, type AskDecisionSource } from "../../context/ask-decisions.ts"

type Created = Extract<OpenCodeEvent, { type: "form.created" }>["data"]["form"]

/** Translate the native form protocol into the existing bounded question registry. */
export class V2AskDecisions implements AskDecisionSource {
  private readonly registry = new AskDecisionRegistry()
  private readonly pending = new Map<string, { form: Created; at: number }>()

  observe(event: OpenCodeEvent, directory: string): void {
    if (!("location" in event) || event.location?.directory !== directory) return
    const now = Date.now()
    for (const [id, pending] of this.pending)
      if (now - pending.at > 30 * 60 * 1000) this.pending.delete(id)
    if (event.type === "form.created") {
      const form = event.data.form
      if (!form.sessionID.startsWith("ses_") || this.pending.has(form.id)) return
      if (JSON.stringify(form).length > 64_000) return
      if (this.pending.size >= 128) this.pending.delete(this.pending.keys().next().value!)
      const bounded: Created = { ...form, fields: [form.fields[0], ...form.fields.slice(1, 32)] }
      this.pending.set(form.id, { form: bounded, at: now })
      this.registry.observe({
        type: "question.asked",
        properties: {
          id: form.id,
          sessionID: form.sessionID,
          questions: bounded.fields.map((field) => ({
            question: `${form.title}: ${field.title ?? field.key}`,
          })),
        },
      })
      return
    }
    if (event.type !== "form.replied" && event.type !== "form.cancelled") return
    const pending = this.pending.get(event.data.id)
    if (!pending || pending.form.sessionID !== event.data.sessionID) return
    this.pending.delete(event.data.id)
    if (event.type === "form.cancelled") {
      this.registry.observe({ type: "question.rejected", properties: { requestID: event.data.id } })
      return
    }
    const answers = pending.form.fields.map((field) => {
      const value = event.data.answer[field.key]
      if (value === undefined) return []
      const values = Array.isArray(value) ? value : [value]
      return values.map((value) => {
        const label =
          "options" in field
            ? field.options?.find((option) => option.value === String(value))?.label
            : undefined
        return label ?? String(value)
      })
    })
    this.registry.observe({
      type: "question.replied",
      properties: { requestID: event.data.id, answers },
    })
  }

  recentFor(sessionIDs: string[], limit?: number) {
    return this.registry.recentFor(sessionIDs, limit)
  }
}
