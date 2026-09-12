import { describe, expect, test } from "bun:test"
import { evaluatePolicy, PROFILE_TEMPLATES } from "../src/policy/policy-engine.ts"
import type { ActorContext, CapabilityAssessment, PolicyRule } from "../src/types.ts"
import { DEFAULT_CONFIG } from "../src/config.ts"

function cap(overrides: Partial<CapabilityAssessment> = {}): CapabilityAssessment {
  return {
    actionClass: { value: "read-only", source: "static-analysis", confidence: "high" },
    summary: "read-only",
    executesCode: { value: "unknown", source: "static-analysis", confidence: "unknown" },
    executesRepositoryCode: { value: "unknown", source: "static-analysis", confidence: "unknown" },
    createsAdHocCode: { value: "unknown", source: "static-analysis", confidence: "unknown" },
    invokesExistingTestRunner: {
      value: "unknown",
      source: "static-analysis",
      confidence: "unknown",
    },
    invokesPackageLifecycleScripts: {
      value: "unknown",
      source: "static-analysis",
      confidence: "unknown",
    },
    writeEffects: {
      temporaryWrite: { value: "unknown", source: "static-analysis", confidence: "unknown" },
      workspaceWrite: { value: "unknown", source: "static-analysis", confidence: "unknown" },
      externalWrite: { value: "unknown", source: "static-analysis", confidence: "unknown" },
      deletion: { value: "unknown", source: "static-analysis", confidence: "unknown" },
    },
    network: {
      observed: { value: "unknown", source: "static-analysis", confidence: "unknown" },
      possible: { value: "unknown", source: "heuristic", confidence: "unknown" },
      destinations: [],
      observedAccess: { value: "unknown", source: "static-analysis", confidence: "unknown" },
      possibleAccess: { value: "unknown", source: "heuristic", confidence: "unknown" },
    },
    process: {
      childProcesses: { value: "unknown", source: "static-analysis", confidence: "unknown" },
      persistence: { value: "unknown", source: "static-analysis", confidence: "unknown" },
      privilegeEscalation: {
        value: "unknown",
        source: "static-analysis",
        confidence: "unknown",
      },
    },
    remote: {
      enabled: { value: "unknown", source: "static-analysis", confidence: "unknown" },
      mutationHint: { value: "unknown", source: "static-analysis", confidence: "unknown" },
    },
    git: {
      observed: { value: "unknown", source: "static-analysis", confidence: "unknown" },
      possible: { value: "unknown", source: "heuristic", confidence: "unknown" },
      observedAccess: { value: "unknown", source: "static-analysis", confidence: "unknown" },
      possibleAccess: { value: "unknown", source: "heuristic", confidence: "unknown" },
    },
    parserCompleteness: "complete-for-supported-form",
    analysisWarnings: [],
    ...overrides,
  }
}

function actor(profile: string): ActorContext {
  return {
    agentName: { value: "test", source: "tool-message", confidence: "high" },
    mode: { value: "build", source: "tool-message", confidence: "high" },
    profile: {
      value: profile as ActorContext["profile"]["value"],
      source: "static-analysis",
      confidence: "medium",
    },
    sessionID: "ses_1",
    parentSessionID: { value: undefined, source: "session-api", confidence: "high" },
    rootSessionID: { value: "ses_1", source: "session-api", confidence: "high" },
    delegationDepth: { value: 0, source: "session-api", confidence: "high" },
    identityCompleteness: "complete",
  }
}

const config = DEFAULT_CONFIG

describe("policy engine — basics", () => {
  test("empty rules yield review route with no matches", () => {
    const trace = evaluatePolicy(cap(), actor("workspace"), config, [])
    expect(trace.matchedRules).toHaveLength(0)
    expect(trace.finalRoute).toBe("review")
    expect(trace.mode).toBe("observe")
  })

  test("undefined capability and actor never throw", () => {
    const trace = evaluatePolicy(undefined, undefined, config, [])
    expect(trace.finalRoute).toBe("review")
  })

  test("effectivePolicyHash is stable for identical rules", () => {
    const rules: PolicyRule[] = [
      { id: "r1", source: "builtin", when: { executesCode: true }, effect: "manual", reason: "x" },
    ]
    const t1 = evaluatePolicy(cap(), undefined, config, rules)
    const t2 = evaluatePolicy(cap(), undefined, config, rules)
    expect(t1.effectivePolicyHash).toBe(t2.effectivePolicyHash)
  })

  test("effectivePolicyHash changes when rules change", () => {
    const r1: PolicyRule[] = [
      { id: "a", source: "builtin", when: {}, effect: "manual", reason: "x" },
    ]
    const r2: PolicyRule[] = [
      { id: "b", source: "builtin", when: {}, effect: "manual", reason: "x" },
    ]
    expect(evaluatePolicy(cap(), undefined, config, r1).effectivePolicyHash).not.toBe(
      evaluatePolicy(cap(), undefined, config, r2).effectivePolicyHash,
    )
  })
})

describe("policy engine — most-restrictive resolution", () => {
  test("deny beats manual when both match", () => {
    const rules: PolicyRule[] = [
      { id: "m", source: "builtin", when: { executesCode: true }, effect: "manual", reason: "m" },
      { id: "d", source: "builtin", when: { executesCode: true }, effect: "deny", reason: "d" },
    ]
    const c = cap({ executesCode: { value: true, source: "static-analysis", confidence: "high" } })
    const trace = evaluatePolicy(c, undefined, config, rules)
    expect(trace.matchedRules).toHaveLength(2)
    expect(trace.finalRoute).toBe("deny")
  })

  test("manual beats review", () => {
    const rules: PolicyRule[] = [
      { id: "rev", source: "builtin", when: {}, effect: "review", reason: "r" },
      { id: "man", source: "builtin", when: {}, effect: "manual", reason: "m" },
    ]
    const trace = evaluatePolicy(cap(), undefined, config, rules)
    expect(trace.finalRoute).toBe("manual")
  })
})

describe("policy engine — condition matching", () => {
  test("workspace write condition matches when capability says true", () => {
    const rules: PolicyRule[] = [
      {
        id: "ws",
        source: "builtin",
        when: { writesWorkspace: true },
        effect: "manual",
        reason: "ws write",
      },
    ]
    const c = cap({
      writeEffects: {
        ...cap().writeEffects,
        workspaceWrite: { value: true, source: "static-analysis", confidence: "high" },
      },
    })
    expect(evaluatePolicy(c, undefined, config, rules).matchedRules).toHaveLength(1)
  })

  test("actionClass condition matches", () => {
    const rules: PolicyRule[] = [
      {
        id: "net",
        source: "builtin",
        when: { actionClass: ["network"] },
        effect: "manual",
        reason: "net",
      },
    ]
    const c = cap({
      actionClass: { value: "network", source: "static-analysis", confidence: "high" },
    })
    expect(evaluatePolicy(c, undefined, config, rules).matchedRules).toHaveLength(1)
  })

  test("actorProfile condition matches", () => {
    const rules: PolicyRule[] = [
      {
        id: "ro",
        source: "builtin",
        when: { actorProfile: ["read-only"] },
        effect: "manual",
        reason: "ro",
      },
    ]
    expect(evaluatePolicy(cap(), actor("read-only"), config, rules).matchedRules).toHaveLength(1)
    expect(evaluatePolicy(cap(), actor("workspace"), config, rules).matchedRules).toHaveLength(0)
  })

  test("multiple conditions are ANDed", () => {
    const rules: PolicyRule[] = [
      {
        id: "combo",
        source: "builtin",
        when: { actorProfile: ["unknown"], remoteEnabled: true },
        effect: "manual",
        reason: "combo",
      },
    ]
    const c = cap({
      remote: {
        ...cap().remote,
        enabled: { value: true, source: "static-analysis", confidence: "high" },
      },
    })
    expect(evaluatePolicy(c, actor("unknown"), config, rules).matchedRules).toHaveLength(1)
    expect(evaluatePolicy(c, actor("workspace"), config, rules).matchedRules).toHaveLength(0)
  })

  test("packageManagement matches on the lifecycle-scripts fact regardless of the dominant class", () => {
    const rules: PolicyRule[] = [
      {
        id: "pkg",
        source: "builtin",
        when: { packageManagement: true },
        effect: "manual",
        reason: "pkg",
      },
    ]
    // Lifecycle scripts detected with a different dominant class (bun install
    // executes code AND drives a package lifecycle) → must still match.
    const cLifecycleWithCode = cap({
      actionClass: { value: "code-execution", source: "static-analysis", confidence: "high" },
      invokesPackageLifecycleScripts: {
        value: true,
        source: "static-analysis",
        confidence: "high",
      },
    })
    expect(evaluatePolicy(cLifecycleWithCode, undefined, config, rules).matchedRules).toHaveLength(
      1,
    )
    // fact unknown → no match.
    const cNoLifecycle = cap({
      actionClass: { value: "package-management", source: "static-analysis", confidence: "high" },
      invokesPackageLifecycleScripts: {
        value: "unknown",
        source: "static-analysis",
        confidence: "unknown",
      },
    })
    expect(evaluatePolicy(cNoLifecycle, undefined, config, rules).matchedRules).toHaveLength(0)
  })

  test("repositoryTrust condition excludes non-matching trust levels", () => {
    const rules: PolicyRule[] = [
      {
        id: "trusted-only",
        source: "builtin",
        when: { repositoryTrust: ["trusted"] },
        effect: "manual",
        reason: "trusted only",
      },
    ]
    // default config trust is "unknown" → rule does not match.
    expect(evaluatePolicy(cap(), undefined, config, rules).matchedRules).toHaveLength(0)
    // config trust set to "trusted" → matches.
    const trustedConfig = { ...config, repositoryTrust: "trusted" as const }
    expect(evaluatePolicy(cap(), undefined, trustedConfig, rules).matchedRules).toHaveLength(1)
  })
})

describe("policy engine — trust boundary", () => {
  test("project-sourced allow rules are rejected", () => {
    const rules: PolicyRule[] = [
      {
        id: "allow-project",
        source: "project",
        when: {},
        effect: "allow",
        reason: "project says allow",
      },
    ]
    const trace = evaluatePolicy(cap(), undefined, config, rules)
    expect(trace.matchedRules).toHaveLength(0)
    expect(trace.finalRoute).toBe("review")
  })

  test("builtin allow rules are NOT rejected (but none ship by default)", () => {
    const rules: PolicyRule[] = [
      {
        id: "allow-builtin",
        source: "builtin",
        when: {},
        effect: "allow",
        reason: "builtin allow",
      },
    ]
    const trace = evaluatePolicy(cap(), undefined, config, rules)
    expect(trace.matchedRules).toHaveLength(1)
    expect(trace.finalRoute).toBe("allow")
  })
})

describe("policy engine — observe vs enforce mode", () => {
  test("observe mode reflects mode but computes counterfactual route", () => {
    const enforceConfig = { ...config, enforcementMode: "enforce" as const }
    const rules: PolicyRule[] = [
      { id: "d", source: "builtin", when: {}, effect: "deny", reason: "always deny" },
    ]
    const observeTrace = evaluatePolicy(cap(), undefined, config, rules)
    const enforceTrace = evaluatePolicy(cap(), undefined, enforceConfig, rules)
    expect(observeTrace.mode).toBe("observe")
    expect(observeTrace.finalRoute).toBe("deny") // counterfactual
    expect(enforceTrace.mode).toBe("enforce")
    expect(enforceTrace.finalRoute).toBe("deny")
  })
})

describe("policy engine — profile templates", () => {
  test("PROFILE_TEMPLATES are well-formed and have no allow effects", () => {
    for (const r of PROFILE_TEMPLATES) {
      expect(r.effect).not.toBe("allow")
      expect(r.source).toBe("builtin")
      expect(r.id.length).toBeGreaterThan(0)
      expect(r.reason.length).toBeGreaterThan(0)
    }
  })

  test("read-only + workspace write triggers the template rule", () => {
    const c = cap({
      writeEffects: {
        ...cap().writeEffects,
        workspaceWrite: { value: true, source: "static-analysis", confidence: "high" },
      },
    })
    const trace = evaluatePolicy(c, actor("read-only"), config, PROFILE_TEMPLATES)
    expect(trace.matchedRules.some((m) => m.id === "read-only-workspace-write")).toBe(true)
    expect(trace.finalRoute).toBe("manual")
  })
})
