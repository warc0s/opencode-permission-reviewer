import { randomUUID } from "node:crypto"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Plugin } from "@opencode/plugin"

type Context = Parameters<Plugin.Plugin["setup"]>[0]
type Activate = (ctx: Context) => Promise<() => Promise<void>>
const KEY = "opencode-permission-reviewer.isolated-activation"
const symbol = Symbol.for(KEY)
const globals = globalThis as typeof globalThis & { [symbol]: Map<string, Activate> | undefined }
const activations = globals[symbol] ?? new Map<string, Activate>()
globals[symbol] = activations

/** A host-loaded bootstrap registers only this attempt's isolated hooks. */
export async function createIsolatedLocation(
  activate: Activate,
): Promise<{ directory: string; release(): void }> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-reviewer-"))
  const key = randomUUID()
  activations.set(key, async (ctx) => {
    if (ctx.location.directory !== directory)
      throw new Error("Reviewer isolation location mismatch")
    return activate(ctx)
  })
  const source = `export default { id: "permission-reviewer-isolation", setup(ctx) {
    const activate = globalThis[Symbol.for(${JSON.stringify(KEY)})]?.get(${JSON.stringify(key)});
    if (!activate) throw new Error("Reviewer isolation activation expired");
    return activate(ctx);
  } };`
  try {
    await writeFile(join(directory, "index.js"), source, { flag: "wx", mode: 0o600 })
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: "permission-reviewer-isolation",
        private: true,
        type: "module",
        exports: "./index.js",
      }),
      { flag: "wx", mode: 0o600 },
    )
    await writeFile(join(directory, "opencode.json"), JSON.stringify({ plugins: [directory] }), {
      flag: "wx",
      mode: 0o600,
    })
    return {
      directory,
      release: () => {
        activations.delete(key)
      },
    }
  } catch (error) {
    activations.delete(key)
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
