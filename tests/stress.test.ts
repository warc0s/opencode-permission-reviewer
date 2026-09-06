import { beforeAll, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { parseDecision } from "../src/decision.ts"
import { emergencyBrakeReason } from "../src/emergency-brake.ts"
import { decision, MockClient, request, runtime } from "./helpers.ts"
import { createUiStatus, decodeUiStatus, encodeUiStatus } from "../src/ui-protocol.ts"
import { ReviewUiState } from "../src/ui-state.ts"
import { enrichSshEvidence } from "../src/ssh-evidence.ts"
import { enrichLocalScriptEvidence } from "../src/local-script-evidence.ts"
import { enrichGitEvidence } from "../src/git-evidence.ts"

const execFileAsync = promisify(execFile)

// /tmp/opencode is one of the plugin's approved enrichment roots. Ensure it
// exists on a fresh CI runner or a clean clone before mkdtemp uses it.
beforeAll(async () => {
  await mkdir("/tmp/opencode", { recursive: true })
})

describe("stress and adversarial robustness", () => {
  test("processes 1,000 concurrent independent reviews exactly once", async () => {
    const client = new MockClient()
    let index = 0
    client.promptImpl = async () => {
      const current = index
      index += 1
      return { data: { info: { structured: decision(current % 2 === 0 ? "allow" : "deny") } } }
    }
    const harness = runtime(client)
    const results = await Promise.all(
      Array.from({ length: 1_000 }, (_, item) =>
        harness.runtime.process(
          request({
            id: `per_${item}`,
            sessionID: `ses_${item}`,
            tool: { messageID: `msg_${item}`, callID: `call_${item}` },
          }),
        ),
      ),
    )
    expect(results.filter((result) => result.kind === "allow")).toHaveLength(500)
    expect(results.filter((result) => result.kind === "deny")).toHaveLength(500)
    expect(client.creates).toHaveLength(1_000)
    expect(client.replies).toHaveLength(1_000)
    expect(
      client.replies.filter((item) => (item as { body: { reply: string } }).body.reply === "once"),
    ).toHaveLength(500)
    expect(
      client.replies.filter(
        (item) => (item as { body: { reply: string } }).body.reply === "reject",
      ),
    ).toHaveLength(500)
    expect(client.uiStatuses.filter((status) => status.phase === "reviewing")).toHaveLength(1_000)
    expect(client.uiStatuses.filter((status) => status.phase === "approved")).toHaveLength(500)
    expect(client.uiStatuses.filter((status) => status.phase === "denied")).toHaveLength(500)
  }, 30_000)

  test("deduplicates a 2,000-event storm for one request", async () => {
    const harness = runtime()
    for (let item = 0; item < 2_000; item += 1) harness.runtime.handle(request())
    await harness.runtime.waitForIdle()
    expect(harness.client.creates).toHaveLength(1)
    expect(harness.client.replies).toHaveLength(1)
    expect(harness.runtime.pendingCount()).toBe(0)
  })

  test("rejects 5,000 mutated invalid structured outputs", () => {
    for (let item = 0; item < 5_000; item += 1) {
      const base = decision("allow") as unknown as Record<string, unknown>
      const field = item % 5
      if (field === 0) base.outcome = `allow_${item}`
      if (field === 1) base.risk_level = item
      if (field === 2) base.user_authorization = null
      if (field === 3) base.rationale = item % 2 ? "" : "x".repeat(2_001)
      if (field === 4) base.confidence = item % 2 ? -0.01 : 1.01
      expect(parseDecision(base)).toBeUndefined()
    }
  })

  test("does not confuse bounded deletion with root destruction across 1,000 paths", () => {
    for (let item = 0; item < 1_000; item += 1) {
      expect(
        emergencyBrakeReason(request({ metadata: { command: `rm -rf /tmp/build-${item}` } })),
      ).toBeUndefined()
    }
  })

  test("survives 10,000 encoded TUI transitions without cross-request corruption", () => {
    const state = new ReviewUiState({
      model: "openai/gpt-5.6-luna",
      variant: "max",
      timeoutMs: 120_000,
    })
    for (let item = 0; item < 10_000; item += 1) {
      const pending = request({
        id: `per_ui_${item}`,
        sessionID: `ses_ui_${item % 100}`,
        metadata: { command: `printf ui-${item}` },
      })
      state.asked(pending, item)
      const expected = item % 3 === 0 ? "approved" : item % 3 === 1 ? "denied" : "manual"
      const status = createUiStatus(pending, expected, {
        model: "openai/gpt-5.6-luna",
        variant: "max",
        timeoutMs: 120_000,
        emittedAt: 20_000 + item,
        reason: `decision-${item}`,
      })
      const decoded = decodeUiStatus(encodeUiStatus(status))
      expect(decoded).toBeDefined()
      expect(state.apply(decoded!)).toBe(true)
    }
    expect(state.all()).toHaveLength(10_000)
    expect(state.all().filter((status) => status.phase === "approved")).toHaveLength(3_334)
    expect(state.all().filter((status) => status.phase === "denied")).toHaveLength(3_333)
    expect(state.all().filter((status) => status.phase === "manual")).toHaveLength(3_333)
  })

  test("structures 2,000 concurrent SSH requests without crossing destinations", async () => {
    const results = await Promise.all(
      Array.from({ length: 2_000 }, (_, item) => {
        const command =
          item % 2 === 0
            ? `ssh -p 22 user@192.0.2.${item % 250} 'docker ps --filter name=app-${item}'`
            : `ssh -p 2222 user@198.51.100.${item % 250} 'docker restart app-${item}'`
        return enrichSshEvidence(
          request({
            id: `per_ssh_${item}`,
            patterns: [command],
            metadata: { command },
          }),
          "/tmp",
          "/tmp",
          4_000,
        )
      }),
    )
    expect(results).toHaveLength(2_000)
    for (let item = 0; item < results.length; item += 1) {
      const result = results[item]!
      expect(result.audit).toHaveLength(1)
      expect(result.audit[0]?.destination).toContain(item % 2 === 0 ? "192.0.2." : "198.51.100.")
      expect(result.text).toContain(`app-${item}`)
      expect(result.text).toContain(`"mutationHint": ${item % 2 === 0 ? "false" : "true"}`)
    }
  }, 30_000)

  test("inspects 500 concurrent local scripts without crossing their contents", async () => {
    const directory = await mkdtemp("/tmp/opencode/approval-reviewer-script-stress-")
    try {
      await Promise.all(
        Array.from({ length: 500 }, (_, item) =>
          writeFile(join(directory, `script-${item}.py`), `print("SCRIPT_MARKER_${item}")\n`),
        ),
      )
      const results = await Promise.all(
        Array.from({ length: 500 }, (_, item) => {
          const command = `python3 ${join(directory, `script-${item}.py`)}`
          return enrichLocalScriptEvidence(
            request({ id: `per_script_${item}`, patterns: [command], metadata: { command } }),
            directory,
            directory,
            4_000,
          )
        }),
      )
      for (let item = 0; item < results.length; item += 1) {
        expect(results[item]?.text).toContain(`SCRIPT_MARKER_${item}`)
        expect(results[item]?.text).not.toContain(`SCRIPT_MARKER_${(item + 1) % 500}`)
      }
    } finally {
      await rm(directory, { recursive: true })
    }
  }, 30_000)

  test("takes 100 concurrent read-only Git snapshots without crossing discard targets", async () => {
    const directory = await mkdtemp("/tmp/opencode/approval-reviewer-git-stress-")
    try {
      await execFileAsync("git", ["init", "-b", "stress"], { cwd: directory })
      await execFileAsync("git", ["config", "user.email", "reviewer@example.invalid"], {
        cwd: directory,
      })
      await execFileAsync("git", ["config", "user.name", "Reviewer Stress"], { cwd: directory })
      await Promise.all(
        Array.from({ length: 100 }, (_, item) =>
          writeFile(join(directory, `target-${item}.txt`), `before-${item}\n`),
        ),
      )
      await execFileAsync("git", ["add", "."], { cwd: directory })
      await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: directory })
      await Promise.all(
        Array.from({ length: 100 }, (_, item) =>
          writeFile(join(directory, `target-${item}.txt`), `after-${item}\n`),
        ),
      )

      const results = await Promise.all(
        Array.from({ length: 100 }, (_, item) => {
          const command = `git checkout HEAD -- target-${item}.txt`
          return enrichGitEvidence(
            request({ id: `per_git_${item}`, patterns: [command], metadata: { command } }),
            directory,
            8_000,
          )
        }),
      )
      for (let item = 0; item < results.length; item += 1) {
        const record = JSON.parse(results[item]!.text.replace(/^GIT_STATE_ANALYSIS\n/, "")) as {
          status?: string
          branch?: string
          discardTargets?: { values: string[] }
          planned?: { discardTargets: string[] }
          affectedTargetNumstat?: string
        }
        if (record.status !== "available") {
          // Under extreme contention a transient git timeout can withhold the
          // whole snapshot (fail closed); the deterministic discard-target
          // scoping must still be correct in the planned actions.
          expect(record.planned?.discardTargets).toEqual([`target-${item}.txt`])
          continue
        }
        expect(record.branch).toBe("stress")
        // The discard-target scoping is the safety property under test and is
        // derived from command parsing, so it is deterministic regardless of
        // concurrent git contention.
        expect(record.discardTargets?.values).toEqual([`target-${item}.txt`])
        // The numstat counts come from a live `git diff --numstat` racing with
        // the other snapshots' git subprocesses on a shared CI runner; under
        // contention a transient timeout can mark it unavailable. When git does
        // return a diff, it must be scoped to this request's target and never
        // cross into another snapshot's target.
        const numstat = record.affectedTargetNumstat ?? "<unavailable>"
        if (!numstat.startsWith("<")) {
          expect(numstat).toContain(`target-${item}.txt`)
          for (let other = 0; other < 100; other += 1) {
            if (other !== item) expect(numstat).not.toContain(`target-${other}.txt`)
          }
        }
      }
    } finally {
      await rm(directory, { recursive: true })
    }
  }, 30_000)
})
