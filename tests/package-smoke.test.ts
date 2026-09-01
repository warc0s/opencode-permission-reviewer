import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const CWD = import.meta.dir + "/.."

// Build a real tarball once (npm pack runs `prepare`, which rebuilds dist) and
// inspect it with tar. This avoids depending on npm's stdout formatting (which
// emits non-JSON banners/notices in some environments) and validates what would
// actually be published. Nothing is uploaded.
//
// Pack lazily inside the tests rather than in beforeAll: npm pack + prepare can
// exceed the default hook timeout on slow runners, and not every supported Bun
// release accepts a timeout option on beforeAll. Per-test timeouts (third arg)
// are the portable path.
let tmpDir: string | undefined
let tgzPath: string | undefined
let installDir: string | undefined

function packOnce(): string {
  if (tgzPath !== undefined) return tgzPath
  tmpDir = mkdtempSync(join(tmpdir(), "reviewer-pkg-"))
  const pack = Bun.spawnSync({
    cmd: ["npm", "pack", "--pack-destination", tmpDir],
    cwd: CWD,
    stdout: "ignore",
    stderr: "pipe",
  })
  expect(pack.exitCode).toBe(0)
  const name = readdirSync(tmpDir).find((f) => f.endsWith(".tgz"))
  expect(name).toBeTruthy()
  tgzPath = join(tmpDir, name!)
  return tgzPath
}

afterAll(() => {
  if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true })
  if (installDir !== undefined) rmSync(installDir, { recursive: true, force: true })
})

async function listTarball(path: string): Promise<string[]> {
  const proc = Bun.spawn({ cmd: ["tar", "-tzf", path], stdout: "pipe", stderr: "pipe" })
  const [exitCode, text] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
  if (exitCode !== 0) throw new Error("tar list failed")
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((entry) => entry.replace(/^package\//, ""))
    .sort()
}

async function readFromTarball(path: string, member: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["tar", "-xOzf", path, `package/${member}`],
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, text] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
  if (exitCode !== 0) throw new Error(`tar extract ${member} failed`)
  return text
}

describe("npm pack ship set", () => {
  test("the tarball contains the dist bundle and metadata, nothing else", async () => {
    const files = await listTarball(packOnce())

    for (const required of [
      "package.json",
      "README.md",
      "CHANGELOG.md",
      "LICENSE",
      "NOTICE",
      "SECURITY.md",
      "dist/index.js",
      "dist/index.d.ts",
      "dist/explain.js",
      // TUI ships as raw TSX so the host compiles it with its Solid pipeline.
      "dist/tui/tui.tsx",
      "dist/tui/config.ts",
      "dist/tui/ui-protocol.ts",
      "dist/tui/ui-state.ts",
      "dist/tui/types.ts",
      "dist/tui/opencode/event-normalizer.ts",
    ]) {
      expect(files).toContain(required)
    }

    // No prebundled TUI entry — that shape fails to render on the host.
    // Guard the whole dist/tui/ tree: only raw .ts/.tsx sources may ship there.
    const tuiFiles = files.filter((f) => f === "dist/tui" || f.startsWith("dist/tui/"))
    expect(tuiFiles.length).toBeGreaterThan(0)
    expect(tuiFiles.every((f) => f === "dist/tui" || /\.(ts|tsx)$/.test(f))).toBe(true)
    expect(files.some((f) => f === "dist/tui.js" || /^dist\/tui\.js(\.|$)/.test(f))).toBe(false)

    // Nothing from src/, tests/, config, or gitignored/personal files may ship.
    const forbidden = files.filter(
      (f) =>
        f.startsWith("src/") ||
        f.startsWith("tests/") ||
        f.startsWith("scripts/") ||
        f.startsWith(".github/") ||
        f.startsWith("node_modules/") ||
        f === "AGENTS.md" ||
        f === "CONTRIBUTING.md" ||
        f === "CODE_OF_CONDUCT.md" ||
        f === "tsup.config.ts" ||
        f === "tsconfig.json" ||
        f === "eslint.config.ts" ||
        f === ".gitignore" ||
        f === ".prettierrc.json" ||
        f === ".prettierignore" ||
        f === "bun.lock" ||
        f.endsWith("-plan.md"),
    )
    expect(forbidden).toEqual([])
  }, 120_000)

  test("the packaged package.json is public and points at dist", async () => {
    const pkg = JSON.parse(await readFromTarball(packOnce(), "package.json")) as Record<
      string,
      unknown
    >
    expect(pkg.private).toBeUndefined()
    expect(pkg.main).toBe("./dist/index.js")
    expect(pkg.types).toBe("./dist/index.d.ts")
    const exports = pkg.exports as Record<string, unknown>
    expect((exports?.["."] as Record<string, string> | undefined)?.import).toBe("./dist/index.js")
    expect(exports?.["./tui"]).toBe("./dist/tui/tui.tsx")
  }, 120_000)
})

// The TUI overlay is raw TSX that the host compiles against ITS @opentui/solid
// and renders through the Solid runtime resolved from OUR dependency tree.
// OpenCode installs npm plugins with npm/arborist hoisting: if our solid-js pin
// differs from @opentui/solid's exact peer pin, arborist places TWO solid-js
// copies in the tree (one nested in our package, one hoisted). The overlay's
// reactivity then lives in a runtime the JSX renderer never sees and the panel
// silently renders nothing while the server side keeps working. These guards
// keep the shipped dependency pins compatible with that install shape.
describe("npm install dedupe shape", () => {
  test("shipped solid-js and @opentui pins match @opentui/solid's exact requirements", async () => {
    const pkg = JSON.parse(await readFromTarball(packOnce(), "package.json")) as {
      dependencies: Record<string, string>
    }
    const opentui = JSON.parse(
      await Bun.file(join(CWD, "node_modules/@opentui/solid/package.json")).text(),
    ) as {
      version: string
      peerDependencies: Record<string, string>
      dependencies: Record<string, string>
    }

    // Exact string equality: a "compatible" range is not enough. Arborist only
    // dedupes to a single copy when the pins resolve to the same version.
    expect(pkg.dependencies["solid-js"]).toBe(opentui.peerDependencies["solid-js"])
    expect(pkg.dependencies["@opentui/core"]).toBe(opentui.dependencies["@opentui/core"])
    expect(pkg.dependencies["@opentui/solid"]).toBe(opentui.version)
  }, 120_000)

  test("an npm install of the tarball keeps a single solid-js runtime in the tree", async () => {
    installDir = mkdtempSync(join(tmpdir(), "reviewer-install-"))
    // Mirror opencode's installer (arborist reify with ignoreScripts).
    const install = Bun.spawnSync({
      cmd: ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", packOnce()],
      cwd: installDir,
      stdout: "ignore",
      stderr: "pipe",
    })
    expect(install.exitCode).toBe(0)

    const pluginDir = join(installDir, "node_modules", "opencode-permission-reviewer")
    expect(existsSync(pluginDir)).toBe(true)

    // A nested node_modules inside the installed plugin means arborist had to
    // isolate some conflicting version — exactly the silent-render failure mode.
    expect(existsSync(join(pluginDir, "node_modules"))).toBe(false)

    // Tree-wide scan: exactly one solid-js package directory anywhere.
    const solidDirs: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === ".bin" || entry.name === ".package-lock.json")
          continue
        const full = join(dir, entry.name)
        if (dir.endsWith("node_modules") && entry.name === "solid-js") {
          solidDirs.push(full)
          continue // do not descend into the package's own internals
        }
        walk(full)
      }
    }
    walk(join(installDir, "node_modules"))
    expect(solidDirs).toHaveLength(1)

    // The overlay entry and @opentui/solid must resolve solid-js to the same
    // physical copy, i.e. one shared runtime for signals and rendering.
    const fromEntry = Bun.resolveSync("solid-js", join(pluginDir, "dist", "tui"))
    const fromOpentui = Bun.resolveSync(
      "solid-js",
      join(installDir, "node_modules", "@opentui", "solid"),
    )
    expect(fromEntry.startsWith(solidDirs[0]!)).toBe(true)
    expect(fromOpentui.startsWith(solidDirs[0]!)).toBe(true)
  }, 240_000)
})
