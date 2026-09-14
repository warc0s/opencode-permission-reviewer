import { describe, expect, test } from "bun:test"

describe("explain CLI", () => {
  test("native inputs preserve evidence completeness without treating resources as shell commands", async () => {
    for (const input of [
      { action: "shell", resources: ["printf *"] },
      { action: "read", resources: ["file.txt"], input: { path: "file.txt" } },
    ]) {
      const proc = Bun.spawn({
        cmd: ["bun", "run", "src/cli/explain.ts", "--defaults"],
        cwd: import.meta.dir + "/..",
        stdin: new TextEncoder().encode(JSON.stringify(input)),
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(await proc.exited).toBe(0)
      const result = JSON.parse(await new Response(proc.stdout).text())
      expect(result.command).toBe("")
      expect(result.nativeAction).toBe(input.action)
      expect(result.actionEvidenceComplete).toBe(input.action === "read")
    }
  })

  test("parses a bash fixture and prints capability + policyTrace", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/cli/explain.ts"],
      cwd: import.meta.dir + "/..",
      stdin: new TextEncoder().encode(
        JSON.stringify({ permission: "bash", metadata: { command: "pip install x" } }),
      ),
      stdout: "pipe",
      stderr: "pipe",
    })
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.permission).toBe("bash")
    expect(parsed.capability.actionClass.value).toBe("package-management")
    expect(parsed.policyTrace.mode).toBe("observe")
    expect(parsed.policyTrace.finalRoute).toBe("review")
  })

  test("exits 2 on invalid JSON", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/cli/explain.ts"],
      cwd: import.meta.dir + "/..",
      stdin: new TextEncoder().encode("not json"),
      stdout: "pipe",
      stderr: "pipe",
    })
    const exitCode = await proc.exited
    expect(exitCode).toBe(2)
  })

  test("exits 2 on missing permission field", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/cli/explain.ts"],
      cwd: import.meta.dir + "/..",
      stdin: new TextEncoder().encode(JSON.stringify({ foo: "bar" })),
      stdout: "pipe",
      stderr: "pipe",
    })
    const exitCode = await proc.exited
    expect(exitCode).toBe(2)
  })

  test("non-bash permission yields null capability", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", "src/cli/explain.ts"],
      cwd: import.meta.dir + "/..",
      stdin: new TextEncoder().encode(
        JSON.stringify({ permission: "edit", patterns: ["file.txt"] }),
      ),
      stdout: "pipe",
      stderr: "pipe",
    })
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout)
    expect(parsed.capability).toBeNull()
  })
})
