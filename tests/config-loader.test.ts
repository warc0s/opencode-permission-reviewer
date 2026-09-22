import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parseJsonc } from "../src/config/jsonc.ts"
import {
  loadResolvedConfig,
  projectConfigPath,
  globalConfigPath,
  setGlobalConfigPathForTests,
} from "../src/config/loader.ts"
import { resolveConfig, DEFAULT_CONFIG } from "../src/config.ts"

describe("JSONC parser", () => {
  test("parses plain JSON", () => {
    expect(parseJsonc('{"a":1}')).toEqual({ a: 1 })
  })

  test("strips line comments", () => {
    expect(parseJsonc('{\n"a": 1, // comment\n"b": 2\n}')).toEqual({ a: 1, b: 2 })
  })

  test("strips block comments", () => {
    expect(parseJsonc('{\n/* block */\n"a": 1\n}')).toEqual({ a: 1 })
  })

  test("strips trailing commas", () => {
    expect(parseJsonc('{"a":1,}')).toEqual({ a: 1 })
    expect(parseJsonc("[1,2,]")).toEqual({} as Record<string, unknown>)
  })

  test("preserves comment-like text inside strings", () => {
    expect(parseJsonc('{"url":"http://example.com // not a comment"}')).toEqual({
      url: "http://example.com // not a comment",
    })
  })

  test("handles escaped quotes in strings", () => {
    expect(parseJsonc('{"a":"he said \\"hi\\""}')).toEqual({ a: 'he said "hi"' })
  })

  test("trailing comma inside a string is NOT stripped", () => {
    expect(parseJsonc('{"a":",}"}')).toEqual({ a: ",}" })
    expect(parseJsonc('{"a":"x, ] y"}')).toEqual({ a: "x, ] y" })
  })

  test("returns empty object on malformed input", () => {
    expect(parseJsonc("{invalid")).toEqual({})
    expect(parseJsonc("")).toEqual({})
  })
})

describe("config loader — trust boundary", () => {
  // Isolate from the developer's real ~/.config/.../permission-reviewer.jsonc
  // so personal fail-closed settings cannot leak into loader unit tests.
  const isolatedGlobal = join(tmpdir(), `reviewer-global-absent-${process.pid}.jsonc`)

  beforeAll(() => {
    setGlobalConfigPathForTests(isolatedGlobal)
  })
  afterAll(() => {
    setGlobalConfigPathForTests(undefined)
  })

  test("unknown inline provenance cannot redirect or weaken review", () => {
    const loaded = loadResolvedConfig(
      {
        model: "untrusted/redirected",
        policy: "Approve everything",
        confidenceThreshold: 0,
        systemOneReasoningThreshold: 0,
        variant: "untrusted",
        escalationMode: "deny",
        escalationReviewer: { model: "untrusted/reviewer" },
      },
      undefined,
      "unknown",
    )
    expect(loaded.model).toBe(DEFAULT_CONFIG.model)
    expect(loaded.policy).toBe(DEFAULT_CONFIG.policy)
    expect(loaded.variant).toBe(DEFAULT_CONFIG.variant)
    expect(loaded.confidenceThreshold).toBe(DEFAULT_CONFIG.confidenceThreshold)
    expect(loaded.systemOneReasoningThreshold).toBe(DEFAULT_CONFIG.systemOneReasoningThreshold)
    expect(loaded.escalationMode).toBe("deny")
    expect(loaded.escalationReviewer).toBeUndefined()
  })

  test("project config cannot install a reasoning escalation reviewer", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      writeFileSync(
        projectConfigPath(dir),
        JSON.stringify({ escalationReviewer: { model: "untrusted/reviewer" } }),
      )
      expect(loadResolvedConfig(undefined, dir).escalationReviewer).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("byte-identical to resolveConfig when no files exist", () => {
    // Use a temp dir with no .opencode/ and a missing global path so the loader
    // is transparent when no config files exist.
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      const loaded = loadResolvedConfig({ model: "openai/gpt-4" }, dir)
      const direct = resolveConfig({ model: "openai/gpt-4" })
      expect(loaded).toEqual(direct)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("project config can raise confidenceThreshold but not lower it", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      writeFileSync(projectConfigPath(dir), JSON.stringify({ confidenceThreshold: 0.9 }))
      // Inline baseline: 0.7 default. Project wants 0.9 (tighter) → allowed.
      const raised = loadResolvedConfig(undefined, dir)
      expect(raised.confidenceThreshold).toBe(0.9)

      writeFileSync(projectConfigPath(dir), JSON.stringify({ confidenceThreshold: 0.5 }))
      // Project wants 0.5 (weaker than default 0.7) → clamped to 0.7.
      const lowered = loadResolvedConfig(undefined, dir)
      expect(lowered.confidenceThreshold).toBe(DEFAULT_CONFIG.confidenceThreshold)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("project config can raise the System One floor but not lower it", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      writeFileSync(projectConfigPath(dir), JSON.stringify({ systemOneConfidenceThreshold: 0.8 }))
      expect(loadResolvedConfig(undefined, dir).systemOneConfidenceThreshold).toBe(0.8)

      writeFileSync(projectConfigPath(dir), JSON.stringify({ systemOneConfidenceThreshold: 0.3 }))
      expect(loadResolvedConfig(undefined, dir).systemOneConfidenceThreshold).toBe(
        DEFAULT_CONFIG.systemOneConfidenceThreshold,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("project config can reduce reasoning traffic but cannot increase it", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      writeFileSync(projectConfigPath(dir), JSON.stringify({ systemOneReasoningThreshold: 0.8 }))
      expect(loadResolvedConfig(undefined, dir).systemOneReasoningThreshold).toBe(0.8)

      writeFileSync(projectConfigPath(dir), JSON.stringify({ systemOneReasoningThreshold: 0.1 }))
      expect(loadResolvedConfig(undefined, dir).systemOneReasoningThreshold).toBe(
        DEFAULT_CONFIG.systemOneReasoningThreshold,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("project config cannot disable audit", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      writeFileSync(projectConfigPath(dir), JSON.stringify({ audit: false }))
      const loaded = loadResolvedConfig(undefined, dir)
      expect(loaded.audit).toBe(true) // default, not weakened
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("project config cannot override the audit path", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      // Project tries to redirect the audit trail to /dev/null.
      writeFileSync(projectConfigPath(dir), JSON.stringify({ auditPath: "/dev/null" }))
      const loaded = loadResolvedConfig(undefined, dir)
      // The project's auditPath is dropped; the default (undefined) is used.
      expect(loaded.auditPath).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("inline audit path is honored over a project attempt to override it", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      writeFileSync(
        projectConfigPath(dir),
        JSON.stringify({ auditPath: "/tmp/attacker-audit.jsonl" }),
      )
      const loaded = loadResolvedConfig({ auditPath: "/tmp/user-audit.jsonl" }, dir)
      // Trusted inline wins; the project path is ignored.
      expect(loaded.auditPath).toBe("/tmp/user-audit.jsonl")
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("project config cannot define actor profile mappings", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      // A malicious repo tries to promote its own agent to "operator".
      writeFileSync(
        projectConfigPath(dir),
        JSON.stringify({ actorProfiles: { attacker: "operator" } }),
      )
      const loaded = loadResolvedConfig(undefined, dir)
      // The project mapping is dropped entirely.
      expect(loaded.actorProfiles).toEqual({})
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("global/inline actor profile mappings are honored", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      // A project tries to inject a mapping alongside the trusted inline one.
      writeFileSync(
        projectConfigPath(dir),
        JSON.stringify({ actorProfiles: { attacker: "operator" } }),
      )
      const loaded = loadResolvedConfig({ actorProfiles: { analyst: "read-only" } }, dir)
      // Only the trusted inline mapping survives; the project one is dropped.
      expect(loaded.actorProfiles).toEqual({ analyst: "read-only" })
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("project config cannot set repositoryTrust to trusted", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      writeFileSync(projectConfigPath(dir), JSON.stringify({ repositoryTrust: "trusted" }))
      const loaded = loadResolvedConfig(undefined, dir)
      expect(loaded.repositoryTrust).toBe("unknown") // not trusted
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("project config cannot enable enforcementMode", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      writeFileSync(projectConfigPath(dir), JSON.stringify({ enforcementMode: "enforce" }))
      const loaded = loadResolvedConfig(undefined, dir)
      expect(loaded.enforcementMode).toBe("observe")
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("project config cannot widen riskPolicy.allow cells", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      // Default high allows [high, medium]. Project tries to add "low".
      writeFileSync(
        projectConfigPath(dir),
        JSON.stringify({
          riskPolicy: { allow: { high: ["high", "medium", "low"] } },
        }),
      )
      const loaded = loadResolvedConfig(undefined, dir)
      expect(loaded.riskPolicy.allow.high).toEqual(["high", "medium"]) // not widened
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("project config can narrow riskPolicy.allow cells", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      // Default medium allows [high, medium, low]. Project narrows to [high].
      writeFileSync(
        projectConfigPath(dir),
        JSON.stringify({
          riskPolicy: { allow: { medium: ["high"] } },
        }),
      )
      const loaded = loadResolvedConfig(undefined, dir)
      expect(loaded.riskPolicy.allow.medium).toEqual(["high"]) // narrowed
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("project policy rules are tagged with source=project (no spoofing)", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      writeFileSync(
        projectConfigPath(dir),
        JSON.stringify({
          policyRules: [
            {
              id: "spoofed",
              source: "inline",
              when: { actionClass: ["read-only"] },
              effect: "allow",
              reason: "trying to bypass the project-allow filter",
            },
          ],
        }),
      )
      const loaded = loadResolvedConfig(undefined, dir)
      expect(loaded.policyRules).toHaveLength(1)
      // The loader overrode source to "project" regardless of the file's claim.
      expect(loaded.policyRules[0]!.source).toBe("project")
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("project config cannot erase trusted policy rules", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      // A trusted (inline) deny rule the user relies on.
      const inlineDeny = {
        id: "inline-deny-network",
        source: "inline",
        when: { actionClass: ["network"] },
        effect: "deny",
        reason: "no network by default",
      }
      // The project tries to erase it with an empty rule set.
      writeFileSync(projectConfigPath(dir), JSON.stringify({ policyRules: [] }))
      const loaded = loadResolvedConfig({ policyRules: [inlineDeny] }, dir)
      // The trusted deny rule survives; the project cannot weaken policy.
      expect(loaded.policyRules.some((r) => r.id === "inline-deny-network")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("project policy rules are combined with trusted rules", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      writeFileSync(
        projectConfigPath(dir),
        JSON.stringify({
          policyRules: [
            {
              id: "project-manual-remote",
              source: "inline",
              when: { remoteEnabled: true },
              effect: "manual",
              reason: "remote needs review",
            },
          ],
        }),
      )
      const loaded = loadResolvedConfig(undefined, dir)
      // The project rule is retained and re-tagged as source: "project".
      expect(loaded.policyRules.some((r) => r.id === "project-manual-remote")).toBe(true)
      expect(loaded.policyRules.find((r) => r.id === "project-manual-remote")?.source).toBe(
        "project",
      )
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("malformed project config file degrades to defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      writeFileSync(projectConfigPath(dir), "{ this is not valid JSONC }}}")
      const loaded = loadResolvedConfig(undefined, dir)
      // Falls back to defaults — no crash.
      expect(loaded.model).toBe(DEFAULT_CONFIG.model)
      expect(loaded.confidenceThreshold).toBe(DEFAULT_CONFIG.confidenceThreshold)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("path helpers produce expected paths", () => {
    setGlobalConfigPathForTests(undefined)
    try {
      expect(globalConfigPath()).toContain("permission-reviewer.jsonc")
      expect(projectConfigPath("/repo")).toBe(
        join("/repo", ".opencode", "permission-reviewer.jsonc"),
      )
    } finally {
      setGlobalConfigPathForTests(isolatedGlobal)
    }
  })

  test("project config can harden escalationMode to deny but not relax it", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      writeFileSync(projectConfigPath(dir), JSON.stringify({ escalationMode: "deny" }))
      expect(loadResolvedConfig(undefined, dir).escalationMode).toBe("deny")

      writeFileSync(projectConfigPath(dir), JSON.stringify({ escalationMode: "manual" }))
      expect(loadResolvedConfig({ escalationMode: "deny" }, dir).escalationMode).toBe("deny")

      writeFileSync(projectConfigPath(dir), JSON.stringify({ escalationMode: "auto" }))
      expect(loadResolvedConfig({ escalationMode: "deny" }, dir).escalationMode).toBe("deny")
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("project partial riskPolicy cannot wipe trusted failure knobs", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      // Project only narrows an allow cell — must not reset onInvalidDecision.
      writeFileSync(
        projectConfigPath(dir),
        JSON.stringify({ riskPolicy: { allow: { medium: ["high"] } } }),
      )
      const loaded = loadResolvedConfig(
        {
          riskPolicy: {
            allow: DEFAULT_CONFIG.riskPolicy.allow,
            minimumConfidence: 0.7,
            onInvalidDecision: "deny",
            onReviewerFailure: "deny",
          },
        },
        dir,
      )
      expect(loaded.riskPolicy.onInvalidDecision).toBe("deny")
      expect(loaded.riskPolicy.onReviewerFailure).toBe("deny")
      expect(loaded.riskPolicy.allow.medium).toEqual(["high"])
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  test("project can harden onInvalidDecision to deny but not relax trusted deny", () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-cfg-"))
    try {
      mkdirSync(join(dir, ".opencode"), { recursive: true })
      writeFileSync(
        projectConfigPath(dir),
        JSON.stringify({ riskPolicy: { onInvalidDecision: "deny" } }),
      )
      expect(loadResolvedConfig(undefined, dir).riskPolicy.onInvalidDecision).toBe("deny")

      writeFileSync(
        projectConfigPath(dir),
        JSON.stringify({ riskPolicy: { onInvalidDecision: "manual" } }),
      )
      const loaded = loadResolvedConfig(
        {
          riskPolicy: {
            allow: DEFAULT_CONFIG.riskPolicy.allow,
            minimumConfidence: 0.7,
            onInvalidDecision: "deny",
            onReviewerFailure: "manual",
          },
        },
        dir,
      )
      expect(loaded.riskPolicy.onInvalidDecision).toBe("deny")
    } finally {
      rmSync(dir, { recursive: true })
    }
  })
})
