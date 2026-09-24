import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const CWD = import.meta.dir + "/.."

function run(
  args: string[],
  env?: Record<string, string>,
): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", "src/cli/explain.ts", ...args],
    cwd: CWD,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  })
  return Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }))
}

describe("doctor", () => {
  test("reports versions, config sources, and audit writability offline", async () => {
    const home = mkdtempSync(join(tmpdir(), "reviewer-doc-"))
    try {
      const { exitCode, stderr } = await run(["doctor"], { HOME: home })
      expect(exitCode).toBe(0)
      expect(stderr).toContain("opencode")
      expect(stderr).toContain("model:")
      expect(stderr).toContain("mode:       observe")
      expect(stderr).toContain("declarative rules audited only")
      expect(stderr).toContain("reviewer auto-allow/deny remains active")
      expect(stderr).toContain("writable:   yes")
    } finally {
      rmSync(home, { recursive: true })
    }
  }, 15_000)

  test("--json emits valid JSON", async () => {
    const home = mkdtempSync(join(tmpdir(), "reviewer-doc-"))
    try {
      const { exitCode, stdout } = await run(["doctor", "--json"], { HOME: home })
      expect(exitCode).toBe(0)
      const report = JSON.parse(stdout)
      expect(report.version.package).toBeTruthy()
      expect(report.config.model).toBe("openai/gpt-6-luna")
      expect(report.config.enforcementMode).toBe("observe")
    } finally {
      rmSync(home, { recursive: true })
    }
  }, 15_000)

  test("rejects an unknown flag with exit 2", async () => {
    const { exitCode } = await run(["doctor", "--bogus"])
    expect(exitCode).toBe(2)
  }, 10_000)
})

describe("config print-effective", () => {
  test("prints the resolved config and effective policy hash", async () => {
    const home = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      const { exitCode, stdout } = await run(["config", "print-effective"], { HOME: home })
      expect(exitCode).toBe(0)
      const report = JSON.parse(stdout)
      expect(report.command).toBe("print-effective")
      expect(report.config.model).toBe("openai/gpt-6-luna")
      expect(report.policy.ruleCount).toBe(0)
      expect(report.policy.effectivePolicyHash).toMatch(/^[0-9a-f]{16}$/)
    } finally {
      rmSync(home, { recursive: true })
    }
  }, 15_000)

  test("requires the print-effective subcommand", async () => {
    const { exitCode } = await run(["config"])
    expect(exitCode).toBe(2)
  }, 10_000)
})

describe("audit report", () => {
  test("summarizes a fixture JSONL file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-aud-"))
    try {
      const file = join(dir, "audit.jsonl")
      const v2 = (overrides: Record<string, unknown>) =>
        JSON.stringify({ schemaVersion: 2, timestamp: "2026-01-01T00:00:00.000Z", ...overrides })
      writeFileSync(
        file,
        [
          v2({
            requestID: "r1",
            sessionID: "s1",
            permission: "bash",
            outcome: "allow",
            reason: "ok",
            decisionSource: "llm-reviewer",
            riskLevel: "low",
          }),
          v2({
            requestID: "r2",
            sessionID: "s1",
            permission: "bash",
            outcome: "deny",
            reason: "no",
            decisionSource: "emergency-brake",
            riskLevel: "critical",
          }),
          "{not valid json}",
        ].join("\n") + "\n",
      )
      const { exitCode, stdout } = await run(["audit", "report", "--path", file, "--json"])
      expect(exitCode).toBe(0)
      const summary = JSON.parse(stdout)
      expect(summary.exists).toBe(true)
      expect(summary.validRecords).toBe(2)
      expect(summary.invalidLines).toBe(1)
      expect(summary.byDecisionSource).toEqual({ "llm-reviewer": 1, "emergency-brake": 1 })
      expect(summary.byOutcome).toEqual({ allow: 1, deny: 1 })
    } finally {
      rmSync(dir, { recursive: true })
    }
  }, 15_000)

  test("exit 1 when the audit file is missing", async () => {
    const { exitCode, stderr } = await run(["audit", "report", "--path", "/no/such/file.jsonl"])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("no such file")
  }, 10_000)
})
