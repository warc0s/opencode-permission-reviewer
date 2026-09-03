import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin"

/**
 * Single entry point for loading the TUI overlay in tests, mirroring how the
 * OpenCode host loads TSX plugins.
 *
 * Two load-order hazards make a plain `import { tui } from "../src/tui.tsx"`
 * unusable for render-sensitive tests:
 *
 * - Bun compiles TSX with its default JSX transform (expressions evaluated
 *   eagerly, no thunks), while the host compiles it with babel-preset-solid;
 *   reactivity only exists in the host's shape.
 * - Bun resolves bare "solid-js" to the non-reactive SSR build through the
 *   "node" exports condition, so the reactive build only loads when the solid
 *   transform plugin (which rewrites those resolutions) is registered first.
 *
 * Registering the plugin and only then dynamically importing the TUI and the
 * renderer guarantees both, regardless of which test file loads first. Every
 * test that touches the TUI must import through this module instead of
 * importing src/tui.tsx or @opentui/solid directly, so no static import graph
 * can cache the wrong builds before the plugin is up.
 */
ensureSolidTransformPlugin()

export const { tui } = await import("../src/tui.tsx")
export const { testRender } = await import("@opentui/solid")
