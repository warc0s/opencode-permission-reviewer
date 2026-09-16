import { appendFile, mkdtemp, readdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import packageInfo from "../../package.json"

const manager = process.env.PACKAGE_MANAGER ?? "npm"
if (manager !== "npm" && manager !== "bun") throw new Error("PACKAGE_MANAGER must be npm or bun")
const directory = await mkdtemp(join(tmpdir(), "reviewer-installed-package-"))
const root = resolve(import.meta.dir, "../..")
async function run(cmd: string[], cwd: string): Promise<string> {
  const process = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  if (code !== 0) throw new Error(`${cmd[0]} failed: ${stderr}`)
  return stdout
}
// Build is an explicit preceding step. Neither packing nor installation executes scripts.
await run(["npm", "pack", "--ignore-scripts", "--pack-destination", directory], root)
const tarballs = (await readdir(directory)).filter((name) => name.endsWith(".tgz"))
if (tarballs.length !== 1) throw new Error(`Expected one packed tarball, found ${tarballs.length}`)
const tarball = join(directory, tarballs[0]!)
await writeFile(
  join(directory, "package.json"),
  JSON.stringify({
    private: true,
    type: "module",
    dependencies: { [packageInfo.name]: `file:${tarball}` },
  }),
  { flag: "wx" },
)
await run(
  manager === "npm"
    ? ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"]
    : ["bun", "install", "--ignore-scripts"],
  directory,
)
const packagePath = join(directory, "node_modules", packageInfo.name)
const plugin = await import(join(packagePath, "dist/index.js"))
if (typeof plugin.default?.server !== "function" || typeof plugin.default?.setup !== "function")
  throw new Error("Installed package is missing a host entrypoint")
if (process.env.GITHUB_ENV)
  await appendFile(process.env.GITHUB_ENV, `PLUGIN_PACKAGE_PATH=${packagePath}\n`)
console.log(JSON.stringify({ manager, tarball, packagePath }))
