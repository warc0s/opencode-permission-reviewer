import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyPlannedWrites, planFileChange, writeBackup, writeEntry } from "../src/cli/init.ts"
import type { PackageInfo, PluginEntry } from "../src/cli/init.ts"

async function run(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", "src/cli/explain.ts", "init", ...args],
    cwd: import.meta.dir + "/..",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, stdout, stderr }
}

describe("cli init", () => {
  let home: string
  let project: string

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true })
    if (project) rmSync(project, { recursive: true, force: true })
  })

  test("--dry-run writes nothing", async () => {
    home = mkdtempSync(join(tmpdir(), "init-home-"))
    project = mkdtempSync(join(tmpdir(), "init-proj-"))
    const { code, stderr } = await run(["--dry-run", "--project", project], { HOME: home })
    expect(code).toBe(0)
    expect(stderr).toContain("dry-run")
    expect(existsSync(join(project, "opencode.json"))).toBe(false)
  })

  test("--print outputs the entry JSON to stdout", async () => {
    home = mkdtempSync(join(tmpdir(), "init-home-"))
    project = mkdtempSync(join(tmpdir(), "init-proj-"))
    const { code, stdout } = await run(["--print", "--project", project], { HOME: home })
    expect(code).toBe(0)
    const entry = JSON.parse(stdout)
    expect(Array.isArray(entry)).toBe(true)
    expect(typeof entry[0]).toBe("string")
    expect(entry[1].model).toBe("openai/gpt-5.6-luna")
  })

  test("--yes creates the config file with schema and plugin", async () => {
    home = mkdtempSync(join(tmpdir(), "init-home-"))
    project = mkdtempSync(join(tmpdir(), "init-proj-"))
    const { code } = await run(["--yes", "--project", project], { HOME: home })
    expect(code).toBe(0)
    const cfg = JSON.parse(readFileSync(join(project, "opencode.json"), "utf8"))
    expect(cfg.$schema).toBe("https://opencode.ai/config.json")
    expect(Array.isArray(cfg.plugin)).toBe(true)
    expect(cfg.plugin[0][1].model).toBe("openai/gpt-5.6-luna")
  })

  test("noop when already registered", async () => {
    home = mkdtempSync(join(tmpdir(), "init-home-"))
    project = mkdtempSync(join(tmpdir(), "init-proj-"))
    // Seed with an entry pointing at this repo root.
    const root = join(import.meta.dir, "..")
    writeFileSync(join(project, "opencode.json"), JSON.stringify({ plugin: [[root, {}]] }))
    const before = readFileSync(join(project, "opencode.json"), "utf8")
    const { code, stderr } = await run(["--yes", "--project", project], { HOME: home })
    expect(code).toBe(0)
    expect(stderr).toContain("noop")
    const after = readFileSync(join(project, "opencode.json"), "utf8")
    expect(after).toBe(before)
  })

  test("--yes merge preserves other plugins and keys", async () => {
    home = mkdtempSync(join(tmpdir(), "init-home-"))
    project = mkdtempSync(join(tmpdir(), "init-proj-"))
    writeFileSync(
      join(project, "opencode.json"),
      JSON.stringify({ plugin: ["other@1.0.0"], permission: { bash: "ask" } }),
    )
    const { code } = await run(["--yes", "--project", project], { HOME: home })
    expect(code).toBe(0)
    const cfg = JSON.parse(readFileSync(join(project, "opencode.json"), "utf8"))
    expect(cfg.plugin).toHaveLength(2)
    expect(cfg.plugin[0]).toBe("other@1.0.0")
    expect(cfg.permission).toEqual({ bash: "ask" })
  })

  test("backup is created when writing to an existing file", async () => {
    home = mkdtempSync(join(tmpdir(), "init-home-"))
    project = mkdtempSync(join(tmpdir(), "init-proj-"))
    const original = '{"plugin":["other@1.0.0"]}'
    writeFileSync(join(project, "opencode.json"), original)
    const { code, stderr } = await run(["--yes", "--project", project], { HOME: home })
    expect(code).toBe(0)
    expect(stderr).toContain("backup")
    const backups = readdirSync(project).filter((f) => f.includes(".bak-"))
    expect(backups.length).toBeGreaterThanOrEqual(1)
  })

  test("malformed config exits with error and no backup", async () => {
    home = mkdtempSync(join(tmpdir(), "init-home-"))
    project = mkdtempSync(join(tmpdir(), "init-proj-"))
    writeFileSync(join(project, "opencode.json"), '{ "plugin": [')
    const { code, stderr } = await run(["--yes", "--project", project], { HOME: home })
    expect(code).toBe(1)
    expect(stderr).toContain("malformed")
    const backups = readdirSync(project).filter((f) => f.includes(".bak-"))
    expect(backups).toHaveLength(0)
  })

  test("non-TTY without --yes exits 2", async () => {
    home = mkdtempSync(join(tmpdir(), "init-home-"))
    project = mkdtempSync(join(tmpdir(), "init-proj-"))
    // spawn pipes stdin (not a TTY).
    const { code, stderr } = await run(["--project", project], { HOME: home })
    expect(code).toBe(2)
    expect(stderr).toContain("--yes")
  })

  test("--json outputs a machine-readable report", async () => {
    home = mkdtempSync(join(tmpdir(), "init-home-"))
    project = mkdtempSync(join(tmpdir(), "init-proj-"))
    const { code, stdout } = await run(["--dry-run", "--json", "--project", project], {
      HOME: home,
    })
    expect(code).toBe(0)
    const report = JSON.parse(stdout)
    expect(report.command).toBe("init")
    expect(report.package.name).toBe("opencode-permission-reviewer")
    expect(report.versionChecks.length).toBeGreaterThanOrEqual(1)
    expect(report.targets[0].action).toBe("create")
  })
})

describe("cli init apply guards", () => {
  const pkg: PackageInfo = {
    name: "test-plugin",
    version: "9.9.9",
    engines: {},
    root: "/nonexistent-plugin-root",
  }
  const entry: PluginEntry = "test-plugin@^9.9.9"

  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  function freshDir(): string {
    dir = mkdtempSync(join(tmpdir(), "init-guard-"))
    return dir
  }

  test("refuses a create write when the file appeared after planning", () => {
    const directory = freshDir()
    const path = join(directory, "opencode.json")
    const stale = planFileChange(path, pkg)
    expect(stale.action).toBe("create")
    // Another process creates the file before the apply step runs.
    const arrived = '{"plugin":["other@1.0.0"]}'
    writeFileSync(path, arrived)
    expect(applyPlannedWrites([stale], entry, pkg)).toBe(1)
    // Nothing was clobbered or merged; the late file is untouched.
    expect(readFileSync(path, "utf8")).toBe(arrived)
  })

  test("refuses an append write when the file turned malformed after planning", () => {
    const directory = freshDir()
    const path = join(directory, "opencode.json")
    writeFileSync(path, '{"plugin":["other@1.0.0"]}')
    const stale = planFileChange(path, pkg)
    expect(stale.action).toBe("append")
    writeFileSync(path, '{ "plugin": [')
    expect(applyPlannedWrites([stale], entry, pkg)).toBe(1)
    // No backup of the malformed file and no rewrite happened.
    expect(readFileSync(path, "utf8")).toBe('{ "plugin": [')
    expect(readdirSync(directory).filter((f) => f.includes(".bak-"))).toHaveLength(0)
  })

  test("applies a clean create plan", () => {
    const directory = freshDir()
    const path = join(directory, "opencode.json")
    const plan = planFileChange(path, pkg)
    expect(applyPlannedWrites([plan], entry, pkg)).toBe(0)
    const cfg = JSON.parse(readFileSync(path, "utf8")) as { plugin: unknown[] }
    expect(cfg.plugin).toEqual([entry])
  })

  test("writeEntry with create refuses to clobber an existing file", () => {
    const directory = freshDir()
    const path = join(directory, "opencode.json")
    const original = '{"plugin":["other@1.0.0"]}'
    writeFileSync(path, original)
    let code: unknown
    try {
      writeEntry(path, entry, true)
    } catch (error) {
      code = (error as { code?: unknown }).code
    }
    expect(code).toBe("EEXIST")
    expect(readFileSync(path, "utf8")).toBe(original)
  })

  test("writeBackup never overwrites a colliding backup name", () => {
    const directory = freshDir()
    const source = join(directory, "opencode.json")
    writeFileSync(source, '{"plugin":["other@1.0.0"]}')
    const preferred = join(directory, "opencode.json.bak-taken")
    writeFileSync(preferred, "unrelated backup")
    const actual = writeBackup(source, preferred)
    expect(actual).not.toBe(preferred)
    expect(readFileSync(actual, "utf8")).toBe('{"plugin":["other@1.0.0"]}')
    expect(readFileSync(preferred, "utf8")).toBe("unrelated backup")
  })
})

// Import at the bottom to avoid circular issues in Bun's test runner.
import { readdirSync } from "node:fs"
