import { OpenCode, type OpenCodeEvent } from "@opencode/client"
import { V2AskDecisions } from "../../src/opencode/v2/event-codec.ts"
import { createV2ContextReader } from "../../src/opencode/v2/context-reader.ts"
import { withTimeout } from "../../src/opencode/transport.ts"
import type { MessageWithParts } from "../../src/types.ts"

const [url, directory] = process.argv.slice(2)
if (!url || !directory || !process.env.OPENCODE_PASSWORD)
  throw new Error("Missing synthetic host settings")
const client = OpenCode.make({
  baseUrl: url,
  headers: {
    authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`,
  },
})
const controller = new AbortController()
const events: OpenCodeEvent[] = []
const registry = new V2AskDecisions()
let connected!: () => void
const ready = new Promise<void>((resolve) => {
  connected = resolve
})
const stream = (async () => {
  for await (const event of client.event.subscribe({ signal: controller.signal })) {
    if (event.type === "server.connected") connected()
    registry.observe(event, directory)
    if (
      event.type === "form.created" ||
      event.type === "form.replied" ||
      event.type === "session.forked"
    )
      events.push(event)
  }
})()
void stream.catch(() => {})
try {
  await withTimeout(ready, 5000)
  const session = await client.session.create({
    title: "Read-only contract fixture",
    location: { directory },
    model: { providerID: "fixture", id: "reviewer" },
  })
  const admission = await client.session.prompt({
    sessionID: session.id,
    text: "Read-only contract fixture.",
  })
  await client.session.wait({ sessionID: session.id })
  const context = await client.session.context({ sessionID: session.id })
  if (!context.some((message) => message.id === admission.id && message.type === "user"))
    throw new Error("Inbox correlation changed")
  const fork = await client.session.fork({ sessionID: session.id, boundary: { type: "through" } })
  const reader = createV2ContextReader(client, controller.signal)
  const normalizedFork = (await reader.messages(fork.id, directory, 10)) as MessageWithParts[]
  const form = await client.form.create({
    sessionID: session.id,
    title: "Scope fixture",
    fields: [
      {
        type: "string",
        key: "scope",
        title: "Allowed scope",
        options: [{ value: "read", label: "Read only" }],
      },
    ],
  })
  await client.form.reply({ sessionID: session.id, formID: form.id, answer: { scope: "read" } })
  const deadline = Date.now() + 3000
  while (!registry.recentFor([session.id]).length && Date.now() < deadline) await Bun.sleep(10)
  if (registry.recentFor([session.id])[0]?.answer !== "Read only")
    throw new Error("Native form answer was not normalized")
  const formCreated = events.find((event) => event.type === "form.created")
  const formReplied = events.find((event) => event.type === "form.replied")
  console.log(
    JSON.stringify({
      session: { location: "/workspace/fixture", parent: session.parentID ?? null },
      context: context.map((message) => ({
        type: message.type,
        ...(message.type === "user"
          ? { text: message.text, matchesAdmission: message.id === admission.id }
          : {}),
      })),
      fork: {
        sourceMatches: fork.fork?.sessionID === session.id,
        normalized: normalizedFork.map((message) => ({
          role: message.info.role,
          synthetic: message.info.synthetic === true,
          originMatches: message.info.originSessionID === session.id,
          parts: message.parts.map((part) => ({
            type: part.type,
            synthetic: part.synthetic === true,
          })),
        })),
      },
      formCreated:
        formCreated?.type === "form.created"
          ? { type: formCreated.type, fields: formCreated.data.form.fields }
          : null,
      formReplied:
        formReplied?.type === "form.replied"
          ? { type: formReplied.type, answer: formReplied.data.answer }
          : null,
    }),
  )
} finally {
  controller.abort()
  await stream.catch(() => {})
}
