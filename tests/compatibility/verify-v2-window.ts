import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import contracts from "./host-contracts.json"

const releases = Object.entries({
  ...contracts.v2.integrities,
  ...contracts.v2.optionalIntegrities,
}).sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
const python = process.env.PYTHON ?? "python"
const build = Bun.spawn(["bun", "run", "build"], { stdout: "inherit", stderr: "inherit" })
if ((await build.exited) !== 0) throw new Error("Plugin build failed")

for (const [version, integrity] of releases) {
  const directory = await mkdtemp(join(tmpdir(), "reviewer-v2-window-"))
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
        `${contracts.v2.package}@${version}`,
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
    if (lock.packages[`node_modules/${contracts.v2.package}`]?.integrity !== integrity)
      throw new Error(`Host ${version} integrity mismatch`)
    const binary = join(directory, "node_modules", "@opencode/cli-linux-x64", "bin", "opencode")
    const variable = `OPENCODE_V2_${version.replaceAll(".", "_")}`
    const tests = Bun.spawn(
      [
        python,
        "-m",
        "pytest",
        "tests/compatibility/test_opencode_v2.py",
        "tests/compatibility/test_v2_reviewer.py",
        "tests/compatibility/test_tui.py",
        "-k",
        "v2",
        "-q",
      ],
      {
        env: { ...process.env, V2_HOST_VERSION: version, [variable]: binary },
        stdout: "inherit",
        stderr: "inherit",
      },
    )
    if ((await tests.exited) !== 0) throw new Error(`Host ${version} compatibility failed`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
