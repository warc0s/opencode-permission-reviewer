import { mkdtemp, readFile, appendFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import contracts from "./host-contracts.json"

const generation = process.env.HOST_GENERATION
if (generation !== "v1" && generation !== "v2") throw new Error("Set HOST_GENERATION to v1 or v2")
const contract = contracts[generation]
// HOST_RELEASE=latest installs the current registry release instead of the
// pinned matrix. It is unpinned by design and only feeds the advisory canary.
const latest = process.env.HOST_RELEASE === "latest"
const releases: { version: string; integrity?: string }[] = latest
  ? [{ version: "latest" }]
  : Object.entries(contract.integrities).map(([version, integrity]) => ({ version, integrity }))

async function emit(line: string) {
  if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `${line}\n`)
  else console.log(line)
}

for (const release of releases) {
  const directory = await mkdtemp(join(tmpdir(), "reviewer-host-"))
  const proc = Bun.spawn(
    [
      "npm",
      "install",
      "--prefix",
      directory,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `${contract.package}@${release.version}`,
    ],
    { stdout: "inherit", stderr: "inherit" },
  )
  if ((await proc.exited) !== 0) throw new Error("Host installation failed")
  const lock = JSON.parse(await readFile(join(directory, "package-lock.json"), "utf8")) as {
    packages: Record<string, { version?: string; integrity?: string }>
  }
  const installed = lock.packages[`node_modules/${contract.package}`]
  if (release.integrity !== undefined && installed?.integrity !== release.integrity)
    throw new Error("Pinned host integrity mismatch")
  const version = installed?.version
  if (!version || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(`Unexpected installed host version: ${version}`)
  const binary = join(
    directory,
    "node_modules",
    generation === "v1" ? "opencode-linux-x64" : "@opencode/cli-linux-x64",
    "bin",
    "opencode",
  )
  await emit(`OPENCODE_${generation.toUpperCase()}_${version.replaceAll(".", "_")}=${binary}`)
  if (latest) await emit(`${generation.toUpperCase()}_HOST_VERSION=${version}`)
}
