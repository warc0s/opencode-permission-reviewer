import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

const CWD = import.meta.dir + "/.."

// Build a real tarball once and inspect it with tar. The build is explicit:
// installs run no lifecycle scripts (no `prepare`), so `npm pack` would pack a
// stale or missing dist otherwise. This avoids depending on npm's stdout
// formatting (which emits non-JSON banners/notices in some environments) and
// validates what would actually be published. Nothing is uploaded.
//
// Pack lazily inside the tests rather than in beforeAll: build + npm pack can
// exceed the default hook timeout on slow runners, and not every supported Bun
// release accepts a timeout option on beforeAll. Per-test timeouts (third arg)
// are the portable path.
let tmpDir: string | undefined
let tgzPath: string | undefined
let installDir: string | undefined

function packOnce(): string {
  if (tgzPath !== undefined) return tgzPath
  if (process.env.REVIEWER_TEST_TARBALL) {
    tgzPath = resolve(process.env.REVIEWER_TEST_TARBALL)
    expect(existsSync(tgzPath)).toBe(true)
    return tgzPath
  }
  const build = Bun.spawnSync({
    cmd: ["bun", "run", "build"],
    cwd: CWD,
    stdout: "ignore",
    stderr: "pipe",
  })
  expect(build.exitCode).toBe(0)
  tmpDir = mkdtempSync(join(tmpdir(), "reviewer-pkg-"))
  const pack = Bun.spawnSync({
    cmd: ["npm", "pack", "--ignore-scripts", "--pack-destination", tmpDir],
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
      "server.js",
      "tui.tsx",
      "rpc.js",
      "dist/rpc.js",
      "MIGRATION.md",
      "dist/explain.js",
      // TUI ships as raw TSX so the host compiles it with its Solid pipeline.
      "dist/tui/tui.tsx",
      "dist/tui/config.ts",
      "dist/tui/config/loader.ts",
      "dist/tui/config/jsonc.ts",
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

// Supply-chain surface. `@opentui/core` pulls optional platform-specific
// native packages into the INSTALL tree (that is the host TUI pipeline's
// runtime, documented in the README), but none of it may ship inside the
// tarball, no new direct runtime dependency may appear unnoticed, and the
// reviewer SDK's effect runtime must stay external to our bundles.
describe("supply-chain surface", () => {
  test("the tarball ships no native binaries or platform packages", async () => {
    const files = await listTarball(packOnce())
    // Native addons and prebuilt shared libraries, loose or in prebuilds/
    // directories. OpenTUI's native payload is a .so/.dylib, not a .node
    // addon, so those extensions are checked too.
    expect(files.filter((f) => /\.(node|so|dylib|dll)$/.test(f))).toEqual([])
    expect(files.filter((f) => f.split("/").includes("prebuilds"))).toEqual([])
    // npm platform-package layout anywhere in the path: <name>-<os>-<cpu>
    // [-musl] (e.g. `@opentui/core-linux-x64`), whether hoisted at the top,
    // under node_modules/, or inside a bundled-dependency payload.
    const platformPackage =
      /(?:^|\/)(@[^/]+\/)?[^@/][^/]*-(linux|darwin|win32|android|freebsd|aix|sunos)-(x64|arm64|armv7l|ppc64|s390x|riscv64)(-musl)?(\/|$)/
    expect(files.filter((f) => platformPackage.test(f))).toEqual([])
  }, 120_000)

  test("the packaged package.json installs without executing anything", async () => {
    const pkg = JSON.parse(await readFromTarball(packOnce(), "package.json")) as Record<
      string,
      unknown
    >
    // No lifecycle script may (re)appear: installs from the registry, a Git
    // URL, or a local path must execute nothing from this repository.
    for (const script of [
      "prepare",
      "preinstall",
      "install",
      "postinstall",
      "prepack",
      "postpack",
      "prepublishOnly",
      "prepublish",
      "postpublish",
    ]) {
      expect((pkg.scripts as Record<string, string> | undefined)?.[script]).toBeUndefined()
    }
    // A bundled-dependency payload would smuggle files past the ship-set
    // checks (npm packs them under node_modules/).
    expect(pkg.bundleDependencies).toBeUndefined()
    expect(pkg.bundledDependencies).toBeUndefined()
  }, 120_000)

  test("the runtime dependency set is exactly the reviewed allowlist", async () => {
    const pkg = JSON.parse(await readFromTarball(packOnce(), "package.json")) as {
      dependencies: Record<string, string>
      peerDependencies: Record<string, string>
    }
    // A new direct dependency (native or not) must be a deliberate, reviewed
    // change: update this frozen list in the same commit that adds it.
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      "@opencode/client",
      "@opentui/core",
      "@opentui/solid",
      "@typesafe-ai/sdk",
      "jsonc-parser",
      "semver",
      "solid-js",
      "zod",
    ])
    expect(Object.keys(pkg.peerDependencies).sort()).toEqual([
      "@opencode-ai/plugin",
      "@opencode/plugin",
    ])
    // The effect runtime reaches users through the host's plugin SDK, never
    // through a direct dependency of ours.
    expect(
      [...Object.keys(pkg.dependencies), ...Object.keys(pkg.peerDependencies)].some((n) =>
        n.includes("effect"),
      ),
    ).toBe(false)
  }, 120_000)

  test("the effect runtime stays external to every shipped bundle", async () => {
    const files = await listTarball(packOnce())
    const bundles = files.filter((f) => /^dist\/[^/]+\.js$/.test(f))
    expect(bundles.length).toBeGreaterThan(0)
    for (const member of bundles) {
      const bundle = await readFromTarball(packOnce(), member)
      // `effect` may appear as a literal (e.g. permission `"effect": "ask"`),
      // but never as a module specifier: tsup externalizes it, so an
      // accidental import stays visible here instead of being silently
      // inlined. The runtime is resolved by the host from @opencode-ai/plugin's
      // own dependency chain, never vendored by us.
      expect(bundle).not.toMatch(/(?:from|import|require)\s*\(?\s*["']effect(?:\/|["'])/)
    }
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
      cmd: [
        "npm",
        "install",
        "--prefix",
        installDir,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        packOnce(),
      ],
      cwd: installDir,
      stdout: "ignore",
      stderr: "pipe",
    })
    expect(install.exitCode).toBe(0)

    const pluginDir = join(installDir, "node_modules", "opencode-permission-reviewer")
    expect(existsSync(pluginDir)).toBe(true)

    // Host SDK dependencies may be nested; only the rendering runtime must be shared.
    const imported = Bun.spawnSync({
      cmd: [
        "bun",
        "-e",
        'const plugin = (await import("opencode-permission-reviewer")).default; if (typeof plugin.server !== "function" || typeof plugin.setup !== "function") process.exit(1)',
      ],
      cwd: installDir,
      stdout: "ignore",
      stderr: "pipe",
    })
    expect(imported.exitCode).toBe(0)

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

  test("consumer tree dependency and native surveillance", async () => {
    // Surveillance of what a CONSUMER actually installs from the tarball:
    // the documented advisory exposure, the absence of build-tree-only
    // tools, and the reachable native/platform set. Overrides in this
    // repository's package.json do not follow the tarball, so only what is
    // asserted here (or in npm audit) guards the consumer tree.
    installDir ??= mkdtempSync(join(tmpdir(), "reviewer-install-"))
    if (!existsSync(join(installDir, "node_modules", "opencode-permission-reviewer"))) {
      const install = Bun.spawnSync({
        cmd: [
          "npm",
          "install",
          "--prefix",
          installDir,
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          packOnce(),
        ],
        cwd: installDir,
        stdout: "ignore",
        stderr: "pipe",
      })
      expect(install.exitCode).toBe(0)
    }

    // @babel/core reaches the consumer tree through @opentui/solid, which
    // pins it EXACTLY (7.28.0 at every published 0.5.x). GHSA-4x5r-pxfx-6jf8
    // (arbitrary file read via a crafted sourceMappingURL comment) affects
    // <= 7.29.0. The exposure is residual and DOCUMENTED, not fixed: in this
    // package babel only compiles the TUI sources we ship, never
    // attacker-influenced input. When @opentui/solid publishes a fixed pin,
    // this assertion forces the conscious version bump and doc update.
    const babelDir = existsSync(join(installDir, "node_modules", "@babel", "core"))
      ? join(installDir, "node_modules", "@babel", "core")
      : join(installDir, "node_modules", "@opentui", "solid", "node_modules", "@babel", "core")
    const babelPkg = JSON.parse(readFileSync(join(babelDir, "package.json"), "utf8")) as {
      version: string
    }
    expect(babelPkg.version).toBe("7.28.0")

    // The build toolchain must not follow the tarball: esbuild (and the
    // advisory it carries) is dev-only by design.
    expect(existsSync(join(installDir, "node_modules", "esbuild"))).toBe(false)
    for (const entry of readdirSync(join(installDir, "node_modules"), { withFileTypes: true })) {
      if (entry.name.startsWith("@esbuild")) {
        throw new Error(`@esbuild scope leaked into the consumer tree: ${entry.name}`)
      }
    }

    // Native/platform surveillance: every platform-specific package name in
    // the consumer tree. The set is frozen; adding one is a supply-chain
    // review, not an accident.
    const platformPattern =
      /(?:-|--)(?:linux|darwin|win32|android|freebsd|netbsd|openbsd|sunos|aix|arm|arm64|x64|x86|ia32|ppc64|riscv64|s390x|musl|glibc|android-arm(?:64)?|fuchsia)(?:$|[/-])/
    const natives: string[] = []
    const walkNatives = (dir: string, scope?: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === ".bin" || entry.name === ".package-lock.json")
          continue
        const full = join(dir, entry.name)
        if (dir.endsWith("node_modules") && entry.name.startsWith("@")) {
          walkNatives(full, entry.name)
          continue
        }
        const packageName = scope === undefined ? entry.name : `${scope}/${entry.name}`
        if (
          (scope !== undefined || dir.endsWith("node_modules")) &&
          platformPattern.test(packageName)
        ) {
          natives.push(packageName)
          continue
        }
        walkNatives(full)
      }
    }
    walkNatives(join(installDir, "node_modules"))
    expect(natives.some((name) => name.startsWith("@opentui/core-"))).toBe(true)
    // OpenTUI carries the renderer; the client's effect dependency carries
    // optional msgpackr accelerators. Freeze both reviewed platform families.
    const msgpackrPlatforms = new Set([
      "@msgpackr-extract/msgpackr-extract-darwin-arm64",
      "@msgpackr-extract/msgpackr-extract-darwin-x64",
      "@msgpackr-extract/msgpackr-extract-linux-arm",
      "@msgpackr-extract/msgpackr-extract-linux-arm64",
      "@msgpackr-extract/msgpackr-extract-linux-x64",
      "@msgpackr-extract/msgpackr-extract-win32-x64",
    ])
    const unexpected = natives.filter(
      (name) => !name.startsWith("@opentui/core-") && !msgpackrPlatforms.has(name),
    )
    if (unexpected.length > 0) console.log("consumer native set:", natives)
    expect(unexpected).toEqual([])

    // seroval reaches the consumer tree through solid-js, which
    // @opentui/solid peer-pins EXACTLY (1.9.12 at every published 0.5.x).
    // GHSA-p6vx-979v-rg4c and GHSA-jp82-f5mq-hwhp (seroval fromJSON
    // deserialization) are residual and DOCUMENTED, not fixed: seroval is only
    // imported by the SSR renderer solid-js/web, which neither our TUI nor
    // OpenTUI loads. When @opentui/solid moves its pin, this assertion forces
    // the conscious version bump and doc update.
    const solidPkg = JSON.parse(
      readFileSync(join(installDir, "node_modules", "solid-js", "package.json"), "utf8"),
    ) as { version: string }
    expect(solidPkg.version).toBe("1.9.12")
    const ssrImporters: string[] = []
    const findSsrImports = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          findSsrImports(full)
        } else if (
          /\.(?:[cm]?js|tsx?)$/.test(entry.name) &&
          readFileSync(full, "utf8").includes("solid-js/web")
        ) {
          ssrImporters.push(full)
        }
      }
    }
    findSsrImports(join(installDir, "node_modules", "opencode-permission-reviewer", "dist"))
    findSsrImports(join(installDir, "node_modules", "@opentui"))
    expect(ssrImporters).toEqual([])
    const residualAdvisories = new Set(["GHSA-p6vx-979v-rg4c", "GHSA-jp82-f5mq-hwhp"])

    // npm audit over the CONSUMER tree (registry reachability required; the
    // repository's own overrides never apply here). No high or critical
    // advisories beyond the documented seroval residuals; low ones are the
    // documented residuals above.
    const audit = Bun.spawnSync({
      cmd: ["npm", "audit", "--prefix", installDir, "--audit-level=high", "--json"],
      cwd: installDir,
      stdout: "pipe",
      stderr: "pipe",
    })
    const auditText = audit.stdout.toString()
    type AuditVia = string | { url?: string; severity?: string }
    let vulnerabilities: Record<string, { via?: AuditVia[] }> | undefined
    try {
      const parsed = JSON.parse(auditText) as {
        vulnerabilities?: Record<string, { via?: AuditVia[] }>
      }
      vulnerabilities = parsed.vulnerabilities
    } catch {
      // Registry unreachable: surveillance degrades to the structural
      // checks above rather than failing the suite offline.
    }
    if (vulnerabilities !== undefined) {
      // Judge advisories, not affected packages: every dependent of a
      // vulnerable package is itself reported at the same severity.
      const severe = new Set<string>()
      for (const vulnerability of Object.values(vulnerabilities)) {
        for (const via of vulnerability.via ?? []) {
          if (typeof via === "string") continue
          if (via.severity !== "high" && via.severity !== "critical") continue
          severe.add(via.url?.split("/").pop() ?? JSON.stringify(via))
        }
      }
      expect([...severe].filter((id) => !residualAdvisories.has(id))).toEqual([])
    }
  }, 240_000)
})
