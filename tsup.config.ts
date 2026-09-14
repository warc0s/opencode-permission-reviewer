import { defineConfig } from "tsup"

// dist/ is the ship set for the server and CLI. The TUI entry is copied as raw
// TSX by scripts/copy-tui.ts so OpenCode's host can compile it with its own
// Solid/OpenTUI pipeline (a prebundled TUI does not render on the host).
export default defineConfig({
  entry: {
    index: "src/index.ts",
    explain: "src/cli/explain.ts",
    rpc: "src/ui/rpc.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "es2022",
  // A split chunk breaks direct path loading under Bun, so keep it off.
  splitting: false,
  clean: true,
  sourcemap: false,
  dts: {
    compilerOptions: {
      // tsup injects `baseUrl: "."` when unset; TypeScript 6 deprecates
      // baseUrl (error TS5101), so silence it via the same opt-out.
      ignoreDeprecations: "6.0",
    },
  },
  external: [
    "@opencode-ai/plugin",
    "@opencode-ai/plugin/tui",
    "@opencode-ai/sdk",
    /^@opentui\//,
    "solid-js",
    "solid-js/web",
  ],
})
