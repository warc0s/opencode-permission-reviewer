import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
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
const directories = new Set<string>()
process.once("exit", () => {
  for (const directory of directories) {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // Temporary files can be reclaimed by the operating system.
    }
  }
})

/** A host-loaded bootstrap registers only this backend's isolated hooks. */
export async function createIsolatedLocation(
  activate: Activate,
): Promise<{ directory: string; pluginID: string; release(): void }> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-reviewer-"))
  const key = randomUUID()
  const pluginID = `permission-reviewer-isolation-${key}`
  activations.set(key, async (ctx) => {
    if (ctx.location.directory !== directory)
      throw new Error("Reviewer isolation location mismatch")
    return activate(ctx)
  })
  // The local config only disables the config MCP loader, so servers that other plugins add
  // from code still reach this location. Global plugins set up before this one, so this
  // transform removes their servers, and a server added later fails the inventory check.
  // It registers before the activation lookup, so a reload after release() stays MCP-free.
  const source = `export default { id: ${JSON.stringify(pluginID)}, async setup(ctx) {
    await ctx.mcp.transform((editor) => {
      for (const [name] of editor.list()) editor.remove(name);
    });
    const activate = globalThis[Symbol.for(${JSON.stringify(KEY)})]?.get(${JSON.stringify(key)});
    if (!activate) return async () => {};
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
    await writeFile(
      join(directory, "opencode.json"),
      JSON.stringify({ plugins: ["-opencode.config.mcp", directory] }),
      { flag: "wx", mode: 0o600 },
    )
    directories.add(directory)
    return {
      directory,
      pluginID,
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
