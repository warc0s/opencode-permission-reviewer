import { appendFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

async function mark(directory, event) {
  await appendFile(join(directory, "host-probe.txt"), `${event}\n`)
}

export default {
  id: "permission-reviewer-host-probe",
  async server(input) {
    await mark(input.directory, "server:v1")
    return {}
  },
  async setup(ctx) {
    await mark(ctx.location.directory, `setup:v2:${ctx.app.version}`)
    await writeFile(
      join(ctx.location.directory, "host-capabilities.json"),
      JSON.stringify({
        sessionRemove: typeof ctx.session.remove === "function",
        sessionGenerate: typeof ctx.session.generate === "function",
        generateText: typeof ctx.generate.text === "function",
        generateKeys: Object.keys(ctx.generate).sort(),
      }),
    )
    await ctx.permission.hook("evaluate", async (input) => {
      await mark(ctx.location.directory, `evaluate:${input.action}:${input.effect}`)
    })
    return () => mark(ctx.location.directory, "dispose:v2")
  },
}
