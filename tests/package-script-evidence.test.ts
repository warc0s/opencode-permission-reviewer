import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { enrichPackageScriptEvidence } from "../src/package-script-evidence.ts"
import { request } from "./helpers.ts"
import { analyzeCapability } from "../src/capability/bash-analyzer.ts"
import { parseCommand } from "../src/capability/command-parser.ts"

const directories: string[] = []
async function fixture(scripts: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), "reviewer-package-evidence-"))
  directories.push(directory)
  await writeFile(join(directory, "package.json"), JSON.stringify({ scripts }))
  return directory
}
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
async function evidence(directory: string, command: string, maxChars = 24000) {
  return (
    await enrichPackageScriptEvidence(
      request({ patterns: [command], metadata: { command } }),
      directory,
      directory,
      maxChars,
    )
  ).text
}

test("the shell workdir selects the manifest without widening the read roots", async () => {
  const directory = await fixture({ typecheck: "printf root-project" })
  await mkdir(join(directory, "packages", "app"), { recursive: true })
  await writeFile(
    join(directory, "packages", "app", "package.json"),
    JSON.stringify({ scripts: { typecheck: "printf app-project" } }),
  )
  const outside = await fixture({ typecheck: "printf outside-root" })
  const collect = async (workdir: unknown) =>
    (
      await enrichPackageScriptEvidence(
        request({
          metadata: { command: "bun run typecheck", toolInput: { command: "x", workdir } },
        }),
        directory,
        directory,
        24000,
      )
    ).text

  for (const workdir of [undefined, "", ".", directory]) {
    expect(await collect(workdir)).toContain("printf root-project")
  }
  for (const workdir of ["packages/app", join(directory, "packages", "app")]) {
    const text = await collect(workdir)
    expect(text).toContain("printf app-project")
    expect(text).not.toContain("printf root-project")
  }
  for (const workdir of [12, null, ["packages/app"], "packages/\0app", "packages/nope"]) {
    const text = await collect(workdir)
    expect(text).toContain("script working directory is unresolved")
    expect(text).not.toContain("printf root-project")
  }
  expect(await collect(outside)).not.toContain("printf outside-root")

  // Package managers search parent manifests by real path: a symlink into the
  // project selects that manifest, while one leaving it never falls back to the root.
  await symlink(join(directory, "packages", "app"), join(directory, "app-link"))
  expect(await collect("app-link")).toContain("printf app-project")
  await mkdir(join(outside, "real"))
  await symlink(join(outside, "real"), join(directory, "outside-link"))
  const escaped = await collect("outside-link")
  expect(escaped).not.toContain("printf root-project")
  expect(escaped).not.toContain("printf outside-root")
})

test("manifest evidence resolves bounded local script chains and referenced code", async () => {
  const directory = await fixture({
    check: "bun run lint && bun run verify",
    lint: "prettier --check .",
    verify: "node ./verify.js",
    precheck: "printf before",
    postcheck: "printf after",
  })
  await writeFile(join(directory, "verify.js"), 'console.log("synthetic-check")\n')
  const text = await evidence(directory, "bun run check -- --verbose")
  expect(text).toContain("PACKAGE_SCRIPT_ANALYSIS")
  expect(text).toContain("prettier --check .")
  expect(text).toContain("synthetic-check")
  expect(text).toContain("conditional-pre")
  expect(text).toContain("conditional-post")
  expect(text).toContain("--verbose")
})

test("native test runners and file operands are not treated as manifest scripts", async () => {
  const directory = await fixture({
    test: "curl https://wrong.example.invalid",
    check: "printf safe",
  })
  for (const command of [
    "bun test",
    "bun test tests/fixture.test.ts",
    "bun run ./check.ts",
    "printf bun run check",
  ])
    expect(await evidence(directory, command)).toBe("")
  for (const command of ["npm test", "npm run check", "pnpm run check", "yarn run check"])
    expect(await evidence(directory, command)).toContain('"status": "included"')
})

test("script cycles, excessive depth and large content remain explicit gaps", async () => {
  const directory = await fixture({
    a: "bun run b",
    b: "bun run a",
    huge: "printf " + "x".repeat(10000),
    d0: "bun run d1",
    d1: "bun run d2",
    d2: "bun run d3",
    d3: "bun run d4",
    d4: "bun run d5",
    d5: "printf final",
  })
  expect(await evidence(directory, "bun run a")).toContain('"status": "cycle"')
  expect(await evidence(directory, "bun run d0")).toContain("depth limit")
  const text = await evidence(directory, "bun run huge", 1500)
  expect(text).toContain('"status": "truncated"')
  expect(text.length).toBeLessThanOrEqual(1500 + "PACKAGE_SCRIPT_ANALYSIS\n".length)
  expect(() => JSON.parse(text.split("\n").slice(1).join("\n"))).not.toThrow()
})

test("script inspection does not run lifecycle hooks or mutate the workspace", async () => {
  const directory = await fixture({
    check: "touch should-not-exist",
    precheck: "touch hook-should-not-exist",
  })
  const text = await evidence(directory, "bun run check")
  expect(text).toContain("should-not-exist")
  expect(await Bun.file(join(directory, "should-not-exist")).exists()).toBe(false)
  expect(await Bun.file(join(directory, "hook-should-not-exist")).exists()).toBe(false)
})

test("manifest and nested script reads cannot escape approved roots", async () => {
  const directory = await fixture({ check: "printf safe" })
  const outside = await fixture({ check: "OUTSIDE_PRIVATE_MARKER" })
  await mkdir(join(directory, "sub"))
  await rm(join(directory, "package.json"))
  await symlink(join(outside, "package.json"), join(directory, "package.json"))
  const text = await evidence(directory, "bun run check")
  expect(text).toContain('"status": "blocked"')
  expect(text).not.toContain("OUTSIDE_PRIVATE_MARKER")
  const escaped = await evidence(directory, `cd ${outside} && bun run check`)
  expect(escaped).not.toContain("OUTSIDE_PRIVATE_MARKER")
})

test("malformed manifests and ambiguous runtime directories cannot look fully inspected", async () => {
  const directory = await fixture({ check: "printf safe" })
  const ambiguous = await evidence(directory, "bun run --cwd=elsewhere check")
  expect(ambiguous).toContain("not resolved")
  expect(ambiguous).not.toContain("printf safe")
  await writeFile(join(directory, "package.json"), "{invalid")
  expect(await evidence(directory, "bun run check")).toContain("not valid JSON")
})

test("nearest contained manifest is selected for a nested working directory", async () => {
  const directory = await fixture({ check: "printf root-script" })
  await mkdir(join(directory, "sub"))
  expect(await evidence(directory, "cd sub && bun run check")).toContain("root-script")
  await writeFile(
    join(directory, "sub", "package.json"),
    JSON.stringify({ scripts: { check: "printf nested-script" } }),
  )
  const text = await evidence(directory, "cd sub && bun run check")
  expect(text).toContain("nested-script")
  expect(text).not.toContain("root-script")
})

test("local package scripts report network possibility rather than an observed request", () => {
  for (const command of ["bun run check", "npm run build", "pnpm run lint", "yarn run test"]) {
    const cap = analyzeCapability(parseCommand(command), "/workspace", "/workspace")
    expect(cap.network.observed.value).toBe("unknown")
    expect(cap.network.possible.value).toBe(true)
    expect(cap.executesCode.value).toBe(true)
  }
  for (const command of ["bun install", "npm install", "curl https://example.invalid"]) {
    expect(
      analyzeCapability(parseCommand(command), "/workspace", "/workspace").network.observed.value,
    ).toBe(true)
  }
})

test("environment and timeout wrappers retain the same manifest definition", async () => {
  const directory = await fixture({ check: "printf same-script" })
  for (const command of [
    "CI=1 bun run check",
    "env CI=1 bun run check",
    "timeout 30 bun run --silent check",
  ])
    expect(await evidence(directory, command)).toContain("same-script")
  expect(await evidence(directory, "sh -c 'cd elsewhere && bun run check'")).not.toContain(
    "same-script",
  )
  for (const command of [
    "ssh fixture.invalid 'bun run check'",
    "env CI=1 ssh fixture.invalid bun run check",
    "chroot /elsewhere bun run check",
    "sudo -D /elsewhere bun run check",
    "env -C /elsewhere bun run check",
  ])
    expect(await evidence(directory, command)).not.toContain("same-script")
})
