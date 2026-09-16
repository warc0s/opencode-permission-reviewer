import { readFile } from "node:fs/promises"
import { assert, sha256, stable } from "./util.mjs"
export const OUTCOMES = ["allow", "deny", "escalate"]
const INPUT_KEYS = new Set([
  "directory",
  "worktree",
  "request",
  "messages",
  "enrichment",
  "actorProfile",
  "actorName",
  "delegatedTask",
  "directUserIntent",
  "delegatedSession",
  "actionPurpose",
  "config",
  "policyAppend",
  "askDecisions",
  "preflightDenial",
  "actionEvidenceComplete",
])
const CONFIG_KEYS = new Set([
  "maxContextChars",
  "maxPartChars",
  "maxEnrichmentChars",
  "maxIntentChars",
  "transcriptMessages",
  "intentMessages",
  "historyMessages",
  "confidenceThreshold",
  "enforcementMode",
  "escalationMode",
  "actorProfiles",
  "riskPolicy",
  "repositoryTrust",
  "policyRules",
  "configDegraded",
])
export function validateCases(cases) {
  assert(Array.isArray(cases) && cases.length > 0, "Dataset must contain cases.")
  const ids = new Set(),
    families = new Map(),
    inputs = new Set()
  for (const c of cases) {
    assert(
      c && typeof c.id === "string" && c.id.length > 3 && !ids.has(c.id),
      "Missing or duplicate case id: " + c?.id,
    )
    ids.add(c.id)
    assert(typeof c.family === "string" && c.family.length > 0, `${c.id}: family missing`)
    assert(["dev", "validation", "holdout"].includes(c.split), `${c.id}: invalid partition`)
    if (families.has(c.family))
      assert(families.get(c.family) === c.split, `${c.id}: family crosses partitions`)
    else families.set(c.family, c.split)
    assert(["easy", "medium", "hard"].includes(c.difficulty), `${c.id}: difficulty`)
    assert(typeof c.category === "string" && c.category.length, `${c.id}: category`)
    assert(OUTCOMES.includes(c.gold?.outcome), `${c.id}: gold outcome`)
    assert(
      Array.isArray(c.gold.acceptable) &&
        c.gold.acceptable.includes(c.gold.outcome) &&
        c.gold.acceptable.every((x) => OUTCOMES.includes(x)),
      `${c.id}: acceptable outcomes`,
    )
    assert(
      Number.isInteger(c.gold.severity) && c.gold.severity >= 1 && c.gold.severity <= 5,
      `${c.id}: severity`,
    )
    assert(typeof c.gold.critical === "boolean", `${c.id}: critical`)
    assert(
      typeof c.gold.reason === "string" && c.gold.reason.length >= 12,
      `${c.id}: gold explanation`,
    )
    assert(
      Array.isArray(c.gold.rubric?.essential) && c.gold.rubric.essential.length,
      `${c.id}: rationale rubric missing`,
    )
    const input = c.input
    assert(input && typeof input === "object", `${c.id}: input missing`)
    for (const key of Object.keys(input))
      assert(
        INPUT_KEYS.has(key),
        `${c.id}: unrecognized input key ${key}; do not mix labels with evidence`,
      )
    const r = input.request
    assert(
      r &&
        typeof r.permission === "string" &&
        Array.isArray(r.patterns) &&
        r.patterns.every((x) => typeof x === "string") &&
        Array.isArray(r.always) &&
        r.metadata &&
        typeof r.metadata === "object",
      `${c.id}: request schema`,
    )
    assert(
      typeof r.id === "string" && typeof r.sessionID === "string",
      `${c.id}: request identities`,
    )
    assert(
      Array.isArray(input.messages) &&
        input.messages.every((m) => m.info && Array.isArray(m.parts)),
      `${c.id}: messages`,
    )
    assert(
      typeof input.directory === "string" && typeof input.worktree === "string",
      `${c.id}: paths`,
    )
    for (const [key, val] of Object.entries(input.config ?? {})) {
      assert(CONFIG_KEYS.has(key), `${c.id}: unsupported case config ${key}`)
      if (key.startsWith("max") || key.endsWith("Messages"))
        assert(Number.isInteger(val) && val >= 1, `${c.id}: invalid config budget ${key}`)
    }
    const fingerprint = sha256({
      ...input,
      request: { ...r, id: "", sessionID: "", tool: undefined },
    })
    assert(!inputs.has(fingerprint), `${c.id}: exact duplicate model input`)
    inputs.add(fingerprint)
  }
  for (const c of cases)
    for (const source of [c.metamorphic?.sourceId, c.attack?.controlId].filter(Boolean)) {
      const base = cases.find((x) => x.id === source)
      assert(base, `${c.id}: missing paired source ${source}`)
      assert(
        base.family === c.family && base.split === c.split,
        `${c.id}: pair leakage across family/partition`,
      )
      assert(
        base.gold.outcome === c.gold.outcome,
        `${c.id}: preservation pair has inconsistent gold`,
      )
    }
  return {
    cases: cases.length,
    families: families.size,
    categories: [...new Set(cases.map((c) => c.category))].sort(),
    outcomes: Object.fromEntries(
      OUTCOMES.map((o) => [o, cases.filter((c) => c.gold.outcome === o).length]),
    ),
  }
}
export async function loadDataset(path) {
  const text = await readFile(path, "utf8")
  const cases = text.split("\n").flatMap((line, i) => {
    if (!line.trim()) return []
    try {
      return [JSON.parse(line)]
    } catch (e) {
      throw new Error(`${path}:${i + 1}: ${e.message}`, { cause: e })
    }
  })
  return { cases, hash: sha256(text), validation: validateCases(cases) }
}
/** Explicit whitelist at the adapter boundary. NEVER pass the case or gold to a provider. */
export function modelInput(c) {
  return Object.fromEntries(
    Object.keys(c.input)
      .filter((k) => INPUT_KEYS.has(k))
      .map((k) => [k, structuredClone(c.input[k])]),
  )
}
export function selectCases(cases, { split = "all", category, id, limit } = {}) {
  let selected = cases.filter(
    (c) =>
      (split === "all" || c.split === split) &&
      (!category || c.category === category) &&
      (!id || c.id === id),
  )
  if (limit !== undefined) selected = selected.slice(0, limit)
  assert(selected.length > 0, "No selected cases.")
  return selected
}
export const caseDigest = (c) => sha256(stable(c))
