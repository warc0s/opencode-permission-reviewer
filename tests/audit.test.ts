import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { readFileSync, writeFileSync, openSync, writeSync, closeSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createAuditWriter, DEFAULT_AUDIT_PATH, readAuditSummary } from "../src/audit.ts"
import { DEFAULT_CONFIG } from "../src/config.ts"
import type { ReviewAuditRecord } from "../src/types.ts"

function record(overrides: Partial<ReviewAuditRecord> = {}): ReviewAuditRecord {
  return {
    timestamp: new Date().toISOString(),
    durationMs: 42,
    requestID: "per_1",
    sessionID: "ses_main",
    permission: "bash",
    outcome: "allow",
    reason: "narrow safe command",
    ...overrides,
  }
}

/** Write a string at an absolute file offset, looping to completion. Lets
 *  tests plant small records at far offsets so the file grows sparsely. */
function writeAt(fd: number, data: string, position: number): void {
  const buffer = Buffer.from(data, "utf8")
  let written = 0
  while (written < buffer.length) {
    const count = writeSync(fd, buffer, written, buffer.length - written, position + written)
    if (count === 0) throw new Error("short write while building sparse fixture")
    written += count
  }
}

describe("audit writer", () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "approval-reviewer-audit-"))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  test("returns undefined when audit is disabled", () => {
    expect(createAuditWriter({ ...DEFAULT_CONFIG, audit: false })).toBeUndefined()
  })

  test("appends one JSONL line per record with mode 0600", async () => {
    const auditPath = join(directory, "audit.jsonl")
    const writeAudit = createAuditWriter({ ...DEFAULT_CONFIG, audit: true, auditPath })!
    await writeAudit(record({ requestID: "per_a" }))
    await writeAudit(record({ requestID: "per_b" }))
    const content = await readFile(auditPath, "utf8")
    const lines = content.trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).requestID).toBe("per_a")
    expect(JSON.parse(lines[1]!).requestID).toBe("per_b")
    const info = await stat(auditPath)
    expect(info.mode & 0o777).toBe(0o600)
  })

  test("lazily creates nested directories", async () => {
    const auditPath = join(directory, "nested", "deep", "audit.jsonl")
    const writeAudit = createAuditWriter({ ...DEFAULT_CONFIG, audit: true, auditPath })!
    await writeAudit(record())
    const content = await readFile(auditPath, "utf8")
    expect(content.trim().length).toBeGreaterThan(0)
  })

  test("bounds CRLF/newlines to spaces and truncates to 2000 chars", async () => {
    const auditPath = join(directory, "audit.jsonl")
    const writeAudit = createAuditWriter({ ...DEFAULT_CONFIG, audit: true, auditPath })!
    const longReason = `a\r\nb\nc${"x".repeat(3_000)}`
    await writeAudit(record({ reason: longReason }))
    const line = (await readFile(auditPath, "utf8")).trim()
    const parsed = JSON.parse(line) as ReviewAuditRecord
    expect(parsed.reason).not.toContain("\n")
    expect(parsed.reason).not.toContain("\r")
    expect(parsed.reason.length).toBeLessThanOrEqual(2_001) // 2000 + ellipsis
    expect(parsed.reason.endsWith("…")).toBe(true)
  })

  test("short reason is preserved (CRLF -> space normalization)", async () => {
    const auditPath = join(directory, "audit.jsonl")
    const writeAudit = createAuditWriter({ ...DEFAULT_CONFIG, audit: true, auditPath })!
    await writeAudit(record({ reason: "line1\r\nline2\nline3" }))
    const line = (await readFile(auditPath, "utf8")).trim()
    const parsed = JSON.parse(line) as ReviewAuditRecord
    expect(parsed.reason).toBe("line1 line2 line3")
  })

  test("trims whitespace and preserves exact 2000 char boundary", async () => {
    const auditPath = join(directory, "audit.jsonl")
    const writeAudit = createAuditWriter({ ...DEFAULT_CONFIG, audit: true, auditPath })!
    const exactly2000 = "a".repeat(2_000)
    await writeAudit(record({ reason: `  ${exactly2000}  ` }))
    const parsed = JSON.parse((await readFile(auditPath, "utf8")).trim()) as ReviewAuditRecord
    expect(parsed.reason).toBe(exactly2000)
    expect(parsed.reason.length).toBe(2_000)
  })

  test("logger is called on append failure but does not throw", async () => {
    // Use a directory path as auditPath so appendFile fails with EISDIR.
    await mkdir(join(directory, "dir-as-file"))
    const auditPath = join(directory, "dir-as-file")
    const logs: unknown[] = []
    const writeAudit = createAuditWriter(
      { ...DEFAULT_CONFIG, audit: true, auditPath },
      (_msg, details) => logs.push(details),
    )!
    await expect(writeAudit(record())).resolves.toBeUndefined()
    expect(logs.length).toBeGreaterThan(0)
  })

  test("a mkdir failure is logged and never thrown, and later records retry", async () => {
    // A regular file where a directory should be makes mkdir fail with
    // ENOTDIR, so the writer cannot reach the append path at all.
    const blocker = join(directory, "blocker")
    await writeFile(blocker, "x")
    const auditPath = join(blocker, "nested", "audit.jsonl")
    const details: unknown[] = []
    const writeAudit = createAuditWriter(
      { ...DEFAULT_CONFIG, audit: true, auditPath },
      (_msg, info) => details.push(info),
    )!
    await expect(writeAudit(record({ requestID: "per_lost_1" }))).resolves.toBeUndefined()
    // The failure is not sticky: every record logs, and the writer recovers
    // once the directory can be created.
    await expect(writeAudit(record({ requestID: "per_lost_2" }))).resolves.toBeUndefined()
    expect(details.length).toBeGreaterThanOrEqual(2)
    await rm(blocker, { force: true })
    await writeAudit(record({ requestID: "per_recovered" }))
    const parsed = JSON.parse((await readFile(auditPath, "utf8")).trim()) as ReviewAuditRecord
    expect(parsed.requestID).toBe("per_recovered")
  })

  test("a symlinked audit path is rejected without throwing and the target is untouched", async () => {
    const target = join(directory, "target.jsonl")
    await writeFile(target, "")
    await symlink(target, join(directory, "audit.jsonl"))
    const logs: unknown[] = []
    const writeAudit = createAuditWriter(
      { ...DEFAULT_CONFIG, audit: true, auditPath: join(directory, "audit.jsonl") },
      (_msg, details) => logs.push(details),
    )!
    await expect(writeAudit(record())).resolves.toBeUndefined()
    expect(logs.length).toBeGreaterThan(0)
    // The record is lost rather than written through the link.
    expect(await readFile(target, "utf8")).toBe("")
  })

  test("a non-regular audit path is rejected without throwing", async () => {
    // A character device opens fine but fails the regular-file check, the
    // same path a FIFO or socket takes after a successful non-blocking open.
    const logs: unknown[] = []
    const writeAudit = createAuditWriter(
      { ...DEFAULT_CONFIG, audit: true, auditPath: "/dev/null" },
      (_msg, details) => logs.push(details),
    )!
    await expect(writeAudit(record())).resolves.toBeUndefined()
    expect(logs.length).toBeGreaterThan(0)
  })

  test("a pre-existing audit file keeps its permissions (restrictive mode only on create)", async () => {
    const auditPath = join(directory, "audit.jsonl")
    await writeFile(auditPath, "")
    await chmod(auditPath, 0o644)
    const writeAudit = createAuditWriter({ ...DEFAULT_CONFIG, audit: true, auditPath })!
    await writeAudit(record({ requestID: "per_keep" }))
    const handle = await open(auditPath, "r")
    try {
      const info = await handle.stat()
      expect(info.mode & 0o777).toBe(0o644)
      const parsed = JSON.parse((await readFile(handle, "utf8")).trim()) as ReviewAuditRecord
      expect(parsed.requestID).toBe("per_keep")
    } finally {
      await handle.close()
    }
  })

  test("expandHome handles ~ and ~/ paths without throwing", async () => {
    // We cannot write to real ~ in test, but we can verify that `~` and `~/...`
    // are resolved (not treated as relative) — by checking the writer is created
    // and that it does not synchronously throw. We do not actually write to ~.
    const writerTilde = createAuditWriter({ ...DEFAULT_CONFIG, audit: true, auditPath: "~" })
    expect(writerTilde).toBeDefined()
    const writerHome = createAuditWriter({
      ...DEFAULT_CONFIG,
      audit: true,
      auditPath: "~/approval-reviewer-test-noop.jsonl",
    })
    expect(writerHome).toBeDefined()
    // Ensure DEFAULT_AUDIT_PATH uses ~ prefix convention.
    expect(DEFAULT_AUDIT_PATH.startsWith("~")).toBe(true)
  })

  test("concurrent writes are serialized via mkdir once", async () => {
    const auditPath = join(directory, "audit.jsonl")
    const writeAudit = createAuditWriter({ ...DEFAULT_CONFIG, audit: true, auditPath })!
    await Promise.all([
      writeAudit(record({ requestID: "per_1" })),
      writeAudit(record({ requestID: "per_2" })),
      writeAudit(record({ requestID: "per_3" })),
    ])
    const lines = (await readFile(auditPath, "utf8")).trim().split("\n")
    expect(lines).toHaveLength(3)
    const ids = lines.map((l) => (JSON.parse(l) as ReviewAuditRecord).requestID).sort()
    expect(ids).toEqual(["per_1", "per_2", "per_3"])
  })

  test("absolute non-tilde path is resolved", async () => {
    const auditPath = join(directory, "explicit.jsonl")
    const writeAudit = createAuditWriter({ ...DEFAULT_CONFIG, audit: true, auditPath })!
    await writeAudit(record({ requestID: "per_x" }))
    const parsed = JSON.parse((await readFile(auditPath, "utf8")).trim()) as ReviewAuditRecord
    expect(parsed.requestID).toBe("per_x")
  })
})

describe("audit summary hardening", () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "approval-reviewer-summary-"))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  test("exposes truncated=false for a fully-read file and never throws on an unreadable path", async () => {
    const file = join(directory, "audit.jsonl")
    await mkdir(file, { recursive: true }) // a directory: exists but unreadable as a file
    const summary = readAuditSummary(file)
    expect(summary.exists).toBe(false)
    expect(summary.truncated).toBe(false)
    expect(summary.validRecords).toBe(0)
  })

  test("a symlinked audit file reads as missing instead of following the link", async () => {
    const target = join(directory, "target.jsonl")
    writeFileSync(target, `${JSON.stringify(record({ requestID: "per_link" }))}\n`)
    await symlink(target, join(directory, "audit.jsonl"))
    const summary = readAuditSummary(join(directory, "audit.jsonl"))
    expect(summary.exists).toBe(false)
    expect(summary.validRecords).toBe(0)
  })

  test("coerces a non-string actor name instead of throwing in the sort", () => {
    const file = join(directory, "audit.jsonl")
    const token = ["ghp_", "synthetic0123456789abcdefghijklmnopqrstuvwxyz"].join("")
    const lines = [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00.000Z",
        requestID: "r1",
        sessionID: "s1",
        permission: "bash",
        outcome: "allow",
        reason: "ok",
        actor: { name: 42, profile: "unknown" },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:01:00.000Z",
        requestID: "r2",
        sessionID: "s2",
        permission: "bash",
        outcome: "deny",
        reason: `credential ${token}`,
        actor: { name: 42, profile: "unknown" },
      }),
    ]
    writeFileSync(file, lines.join("\n") + "\n")
    const summary = readAuditSummary(file)
    expect(summary.validRecords).toBe(2)
    expect(summary.unknownActorNames[0]!.name).toBe("42")
    expect(summary.unknownActorNames[0]!.count).toBe(2)
  })

  test("summarizes only the bounded tail when the file exceeds the read cap", async () => {
    // Mirrors AUDIT_READ_CAP_BYTES in src/audit.ts. The file is built
    // sparsely: one header line at offset 0, a hole of unwritten zeros,
    // and the tail block at a far offset, so no 64 MiB buffer is allocated
    // by the test itself. A leading newline isolates the zero hole from
    // the first tail line, so the partial-line strip only eats garbage.
    const CAP = 64 * 1024 * 1024
    const file = join(directory, "audit.jsonl")
    const headLine = `${JSON.stringify(
      record({
        requestID: "per_head",
        outcome: "allow",
        permission: "bash",
        timestamp: "2020-01-01T00:00:00.000Z",
      }),
    )}\n`
    const tailLines = [1, 2, 3].map(
      (i) =>
        `${JSON.stringify(
          record({
            requestID: `per_tail_${i}`,
            outcome: "deny",
            permission: "read",
            timestamp: `2026-05-0${i}T00:00:00.000Z`,
          }),
        )}\n`,
    )
    const tailStart = CAP + 1024
    const tailBlock = `\n${tailLines.join("")}`
    const fd = openSync(file, "w")
    try {
      writeAt(fd, headLine, 0)
      writeAt(fd, tailBlock, tailStart)
    } finally {
      closeSync(fd)
    }
    const summary = readAuditSummary(file)
    expect(summary.exists).toBe(true)
    expect(summary.truncated).toBe(true)
    expect(summary.validRecords).toBe(3)
    expect(summary.totalLines).toBe(3)
    expect(summary.invalidLines).toBe(0)
    // The header line is outside the window: no trace of it remains.
    expect(summary.byOutcome).toEqual({ deny: 3 })
    expect(summary.byPermission).toEqual({ read: 3 })
    expect(summary.firstTimestamp).toBe("2026-05-01T00:00:00.000Z")
    expect(summary.lastTimestamp).toBe("2026-05-03T00:00:00.000Z")
  }, 30_000)

  test("keeps a complete first line when the tail window starts at a line boundary", async () => {
    // Same sparse layout, but the window is aligned so its first byte is
    // the start of a whole line: a newline is planted at offset - 1 and a
    // complete boundary record at offset. The reader must keep it instead
    // of stripping it as a partial line.
    const CAP = 64 * 1024 * 1024
    const file = join(directory, "audit.jsonl")
    const headLine = `${JSON.stringify(
      record({
        requestID: "per_head",
        outcome: "allow",
        permission: "bash",
        timestamp: "2020-01-01T00:00:00.000Z",
      }),
    )}\n`
    const boundaryLine = `${JSON.stringify(
      record({
        requestID: "per_boundary",
        outcome: "allow",
        permission: "write",
        timestamp: "2026-06-01T00:00:00.000Z",
      }),
    )}\n`
    const tailLines = [1, 2].map(
      (i) =>
        `${JSON.stringify(
          record({
            requestID: `per_tail_${i}`,
            outcome: "deny",
            permission: "read",
            timestamp: `2026-06-0${i + 1}T00:00:00.000Z`,
          }),
        )}\n`,
    )
    const tailStart = CAP + 4096
    const tailBlock = `\n${tailLines.join("")}`
    const size = tailStart + Buffer.byteLength(tailBlock, "utf8")
    const offset = size - CAP
    const fd = openSync(file, "w")
    try {
      writeAt(fd, headLine, 0)
      writeAt(fd, tailBlock, tailStart)
      writeAt(fd, "\n", offset - 1)
      writeAt(fd, boundaryLine, offset)
    } finally {
      closeSync(fd)
    }
    const summary = readAuditSummary(file)
    expect(summary.exists).toBe(true)
    expect(summary.truncated).toBe(true)
    // Boundary record plus the two tail records; the zero hole between
    // them counts as a single invalid line.
    expect(summary.validRecords).toBe(3)
    expect(summary.totalLines).toBe(4)
    expect(summary.invalidLines).toBe(1)
    expect(summary.byPermission).toEqual({ read: 2, write: 1 })
    expect(summary.byOutcome).toEqual({ allow: 1, deny: 2 })
    expect(summary.firstTimestamp).toBe("2026-06-01T00:00:00.000Z")
    expect(summary.lastTimestamp).toBe("2026-06-03T00:00:00.000Z")
  }, 30_000)
})

describe("audit writer nested redaction", () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "approval-reviewer-nested-"))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  test("policyTrace rule reasons and ask decisions are redacted, structure preserved", async () => {
    const file = join(directory, "audit.jsonl")
    const writer = createAuditWriter({ ...DEFAULT_CONFIG, auditPath: file })!
    const token = ["ghp_", "synthetic0123456789abcdefghijklmnopqrstuvwxyz"].join("")
    await writer(
      record({
        policyTrace: {
          effectivePolicyHash: "abcd",
          matchedRules: [{ id: "r1", source: "global", effect: "deny", reason: `token ${token}` }],
          finalRoute: "deny",
          mode: "enforce",
        },
        askDecisions: [{ at: 1, question: `use ${token}?`, answer: "yes" }],
      }),
    )
    const written = readFileSync(file, "utf8")
    expect(written).not.toContain(token)
    expect(written).toContain("[REDACTED")
    expect(written).toContain('"effectivePolicyHash":"abcd"')
    expect(written).toContain('"id":"r1"')
    expect(written).toContain('"answer":"yes"')
    expect(written).toContain('"sessionID":"ses_main"')
  })
})
