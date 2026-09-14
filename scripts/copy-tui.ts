/**
 * Ship the TUI entry as raw TypeScript/TSX (not a prebundled JS file).
 *
 * OpenCode's host compiles plugin `.tsx` with its own babel-preset-solid
 * pipeline and rewrites `solid-js` / `@opentui/*` imports onto the single
 * embedded runtime. A tsup/esbuild bundle of the same sources produces JSX
 * shapes the host renderer does not consume, so the overlay never paints
 * even though the module loads cleanly. Working TUI plugins ship raw TSX
 * for this reason.
 *
 * Only the slim TUI graph is copied (no server engine, no node builtins).
 */
import { cpSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"

const root = join(import.meta.dir, "..")
const out = join(root, "dist", "tui")

const files = [
  ["src/tui.tsx", "tui.tsx"],
  ["src/ui/components.tsx", "ui/components.tsx"],
  ["src/ui/v2.tsx", "ui/v2.tsx"],
  ["src/ui/rpc.ts", "ui/rpc.ts"],
  ["src/config.ts", "config.ts"],
  ["src/ui-protocol.ts", "ui-protocol.ts"],
  ["src/ui-state.ts", "ui-state.ts"],
  ["src/types.ts", "types.ts"],
  ["src/opencode/event-normalizer.ts", "opencode/event-normalizer.ts"],
] as const

rmSync(out, { recursive: true, force: true })

for (const [from, to] of files) {
  const dest = join(out, to)
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(join(root, from), dest)
}
