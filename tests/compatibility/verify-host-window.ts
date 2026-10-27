import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import contracts from "./host-contracts.json"

// Verify every pinned and optional release of one generation, one disposable
// host at a time. CI only runs the pinned subset; this covers the full window.
const generation = process.env.HOST_GENERATION ?? "v2"
if (generation !== "v1" && generation !== "v2") throw new Error("Set HOST_GENERATION to v1 or v2")
const contract = contracts[generation]
const releases = Object.entries({
  ...contract.integrities,
  ...contract.optionalIntegrities,
}).sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
const python = process.env.PYTHON ?? "python"
const suites =
  generation === "v1"
    ? ["tests/compatibility/test_opencode_v1.py", "tests/compatibility/test_tui.py"]
    : [
        "tests/compatibility/test_opencode_v2.py",
        "tests/compatibility/test_v2_reviewer.py",
        "tests/compatibility/test_tui.py",
      ]
const build = Bun.spawn(["bun", "run", "build"], { stdout: "inherit", stderr: "inherit" })
if ((await build.exited) !== 0) throw new Error("Plugin build failed")

for (const [version, integrity] of releases) {
  const directory = await mkdtemp(join(tmpdir(), `reviewer-${generation}-window-`))
  try {
    console.log(`\nVerifying OpenCode ${version}`)
    const install = Bun.spawn(
      [
        "npm",
        "install",
        "--prefix",
        directory,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        `${contract.package}@${version}`,
      ],
      {
        env: { ...process.env, NPM_CONFIG_CACHE: join(directory, "npm-cache") },
        stdout: "inherit",
        stderr: "inherit",
      },
    )
    if ((await install.exited) !== 0) throw new Error(`Host ${version} installation failed`)
    const lock = JSON.parse(await readFile(join(directory, "package-lock.json"), "utf8")) as {
      packages: Record<string, { integrity?: string }>
    }
    if (lock.packages[`node_modules/${contract.package}`]?.integrity !== integrity)
      throw new Error(`Host ${version} integrity mismatch`)
    const binary = join(
      directory,
      "node_modules",
      generation === "v1" ? "opencode-linux-x64" : "@opencode/cli-linux-x64",
      "bin",
      "opencode",
    )
    const prefix = generation.toUpperCase()
    const tests = Bun.spawn([python, "-m", "pytest", ...suites, "-k", generation, "-q"], {
      env: {
        ...process.env,
        HOST_GENERATION: generation,
        [`${prefix}_HOST_VERSION`]: version,
        [`OPENCODE_${prefix}_${version.replaceAll(".", "_")}`]: binary,
      },
      stdout: "inherit",
      stderr: "inherit",
    })
    if ((await tests.exited) !== 0) throw new Error(`Host ${version} compatibility failed`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
