import { readFile, readdir } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { resolve, join } from "node:path"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import { isBasetenSystemOne, isLiquidSystemOne } from "./providers.mjs"
import { assert, sha256 } from "./util.mjs"

// Git blob hashes of the security-critical files actually inspected for this kit.
export const PINNED_BLOBS = {
  "src/policy.ts": "72dc68cc8de6f536b196e3ffbe840f8b2236cd01",
  "src/context.ts": "5473abbe19ccce27163ceaaf87a63e63e6d5215a",
  "src/config.ts": "526a96f1d6211db8eac98ebb983fe4294f1c649b",
  "src/decision.ts": "ad3443f3bf2ca1b34b3b23e8115c79148e19238b",
  "src/policy/policy-engine.ts": "b4470dc188d956cc0ed25454c2d34465110fe1be",
  "src/escalation.ts": "947f5ed665600927e21be343995cdc4993a45f5a",
  "src/core/review-engine.ts": "e17f72c6775191d8c20fb0d8b24bbf339272dc23",
  "src/emergency-brake.ts": "f583b97b7d917b785c39ab208faa80b45fb6b6e8",
  "src/redact.ts": "27f14d86cee160ca4d759b13bc681212ddc649c5",
  "src/capability/command-parser.ts": "926def261a0f1af1eec4a5991a89eb24da32af59",
  "src/capability/bash-analyzer.ts": "dcf60b95b18ffe3a0256a01075bd34634265bfec",
  "src/shell-lexer.ts": "eaf40e0f9a66f82e61ff4c38532c103c37f82759",
  "src/capability/heredoc-extractor.ts": "de3c1bb00f5d7e430c86845455ce6de6b1c94f6c",
  "src/system-one/review.ts": "af86e3e95bcb19d7ef892612982ce8515a07f52a",
}
const gitBlob = (bytes) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
export async function sourceSnapshot(repo) {
  const files = {}
  async function walk(dir, rel = "") {
    for (const d of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const relative = rel ? `${rel}/${d.name}` : d.name
      if (d.isSymbolicLink())
        throw new Error(`Source symlink is not supported for a reproducible snapshot: ${relative}`)
      if (d.isDirectory()) await walk(join(dir, d.name), relative)
      else if (/\.(ts|tsx|js|json)$/.test(d.name))
        files[`src/${relative}`] = sha256(
          await readFile(join(dir, d.name)).then((b) => b.toString("utf8")),
        )
    }
  }
  await walk(resolve(repo, "src"))
  const differences = []
  for (const [path, expected] of Object.entries(PINNED_BLOBS)) {
    const actual = gitBlob(await readFile(resolve(repo, path)))
    if (actual !== expected) differences.push({ path, expected, actual })
  }
  const packageJSON = JSON.parse(await readFile(resolve(repo, "package.json"), "utf8"))
  let pinnedCommit = null
  try {
    // The blob map gates source parity; record the checked-out commit for provenance.
    pinnedCommit = execFileSync("git", ["-C", resolve(repo), "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    // A source copy can still be compared by its file hashes without Git metadata.
  }
  return {
    pinnedCommit,
    packageVersion: packageJSON.version,
    inspectedBlobDifferences: differences,
    sourceSha256: sha256(files),
    files,
    match: differences.length === 0,
  }
}
const prov = (value, source = "session-api") => ({ value, source, confidence: "high" })
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
/** Expand a fixture session ID to OpenCode's shape (ses_ + 12 hex + 14 base62), deterministically. */
export function openCodeSessionID(fixture) {
  const digest = createHash("sha256").update(fixture).digest()
  const random = [...digest.subarray(6, 20)].map((b) => BASE62[b % 62]).join("")
  return `ses_${digest.subarray(0, 6).toString("hex")}${random}`
}
const intentBlock = (actor, text, sessionID, messageID, createdAt) => ({
  sessionID,
  messageID,
  actor,
  text,
  synthetic: false,
  ...(createdAt === undefined ? {} : { createdAt }),
})
function humanBlocks(messages, sessionID, actor = "user") {
  return messages
    .filter((m) => m.info.role === "user")
    .flatMap((m) =>
      m.parts
        .filter(
          (p) =>
            p.type === "text" &&
            typeof p.text === "string" &&
            p.synthetic !== true &&
            p.ignored !== true &&
            !/^Magic Compact:\s*Compaction in progress|^You have \d+ weighted tokens left/i.test(
              p.text.trim(),
            ),
        )
        .map((p) => intentBlock(actor, p.text, sessionID, m.info.id, m.info.time?.created)),
    )
}
/** Import only the reviewed pure/core layers. Never import index.ts, host backends or evidence providers with filesystem/SSH access. */
export async function openPlugin(repo, { allowDrift = false, allowNode = false } = {}) {
  assert(repo, "Provide --repo pointing to your checked-out plugin.")
  if (!process.versions.bun && !allowNode)
    throw new Error(
      "Use Bun for real plugin imports: bun cli.mjs run ... . Node is supported for offline tests/baselines.",
    )
  const snapshot = await sourceSnapshot(repo)
  assert(
    snapshot.match || allowDrift,
    "Inspected plugin files differ from the pinned snapshot. Use the pinned checkout or explicitly pass --allow-drift; differences are recorded.",
  )
  const load = (path) => import(pathToFileURL(resolve(repo, path)).href)
  const [policy, context, config, decision, escalation, engine, parser, analyzer, systemOne] =
    await Promise.all([
      load("src/policy.ts"),
      load("src/context.ts"),
      load("src/config.ts"),
      load("src/decision.ts"),
      load("src/escalation.ts"),
      load("src/core/review-engine.ts"),
      load("src/capability/command-parser.ts"),
      load("src/capability/bash-analyzer.ts"),
      load("src/system-one/review.ts"),
    ])
  assert(
    typeof context.buildEvidenceResult === "function" &&
      typeof engine.evaluateReview === "function",
    "Unsupported core exports.",
  )
  const buildConfig = (input, model) => {
    const base = structuredClone(config.DEFAULT_CONFIG),
      overrides = structuredClone(input.config ?? {})
    return {
      ...base,
      ...overrides,
      riskPolicy: {
        ...base.riskPolicy,
        ...overrides.riskPolicy,
        allow: { ...base.riskPolicy.allow, ...overrides.riskPolicy?.allow },
      },
      model:
        model?.transport === "system-one" && model.model === "typesafe/jev"
          ? "commandcode/typesafe/jev"
          : isLiquidSystemOne(model)
            ? `liquid-ai/${model.model}`
            : isBasetenSystemOne(model)
              ? `baseten/${model.model}`
              : (model?.model ?? base.model),
      variant: model?.variant ?? base.variant,
      outputFormat: model?.format === "text" ? "text" : "json_schema",
      audit: false,
      retainReviewSessions: false,
    }
  }
  function envelopeFor(input, cfg) {
    const messages = structuredClone(input.messages),
      request = structuredClone(input.request)
    request.sessionID = openCodeSessionID(request.sessionID)
    const delegated = input.delegatedSession === true
    const rootSessionID = delegated ? openCodeSessionID("ses_root_fixture") : request.sessionID
    const lastUser = messages.findLast((m) => m.info.role === "user")?.info.id ?? "msg_000"
    const block = (actor, sessionID) => (x) =>
      typeof x === "string" ? intentBlock(actor, x, sessionID, lastUser) : x
    const direct = input.directUserIntent?.length
      ? input.directUserIntent.map(block("user", rootSessionID))
      : delegated
        ? []
        : humanBlocks(messages, request.sessionID)
    const tasks = (input.delegatedTask ?? []).map(block("assistant", rootSessionID))
    const e = {
      request,
      directory: input.directory,
      worktree: input.worktree,
      transcript: context.buildTranscript(messages, cfg),
      intentHistory: context.buildIntentHistory(messages, cfg, { delegatedSession: delegated }),
      enrichment: input.enrichment ?? "",
      sshAudit: [],
      actor: {
        sessionID: request.sessionID,
        agentName: prov(input.actorName ?? "implementer"),
        mode: prov("primary"),
        profile: prov(input.actorProfile ?? "workspace", "global-config"),
        identityCompleteness: "complete",
        rootSessionID: prov(rootSessionID),
        delegationDepth: prov(delegated ? 1 : 0),
        parentSessionID: prov(delegated ? rootSessionID : undefined),
      },
      lineage: {
        origin: delegated ? "delegated" : "human-root",
        depth: delegated ? 1 : 0,
        rootSessionID,
        cycleDetected: false,
        truncated: false,
        missingParents: [],
        nodes: [
          {
            sessionID: request.sessionID,
            actorName: input.actorName ?? "implementer",
            mode: "primary",
          },
          ...(delegated
            ? [{ sessionID: rootSessionID, actorName: "coordinator", mode: "primary" }]
            : []),
        ],
      },
      intent: {
        directUserIntent: direct,
        delegatedTask: tasks,
        localSessionIntent: delegated
          ? messages
              .filter((m) => m.info.role === "user")
              .flatMap((m) =>
                m.parts
                  .filter((p) => p.type === "text")
                  .map((p) =>
                    intentBlock(
                      "assistant",
                      p.text,
                      request.sessionID,
                      m.info.id,
                      m.info.time?.created,
                    ),
                  ),
              )
          : [],
      },
      actionPurpose: input.actionPurpose,
      ...(input.askDecisions ? { askDecisions: structuredClone(input.askDecisions) } : {}),
      ...(input.preflightDenial ? { preflightDenial: input.preflightDenial } : {}),
      ...(input.actionEvidenceComplete === false ? { actionEvidenceComplete: false } : {}),
    }
    if (request.permission === "bash" && typeof request.metadata.command === "string") {
      e.parsedCommand = parser.parseCommand(request.metadata.command)
      e.capability = analyzer.analyzeCapability(e.parsedCommand, input.directory, input.worktree)
    }
    return e
  }
  const evaluate = (e, cfg, review) =>
    engine.evaluateReview(e.request, cfg, {
      collect: async () => e,
      review,
      active: () => true,
      auxiliarySession: () => false,
      observe: () => {},
    })
  return {
    snapshot,
    schema: decision.DECISION_SCHEMA,
    promptVersion: policy.REVIEWER_PROMPT_VERSION,
    parse: (text) => decision.parseDecisionFromText(text),
    parseObject: (obj) => decision.parseDecision(obj),
    parseSystemOne: (obj, cfg) => systemOne.parseSystemOneReview(obj, cfg),
    async prepare(input, model) {
      const cfg = buildConfig(input, model),
        envelope = envelopeFor(input, cfg)
      let reached = false
      const preflight = await evaluate(envelope, cfg, async () => {
        reached = true
        return {
          kind: "escalate",
          reason: "BENCHMARK preflight: no model invoked.",
          decisionSource: "failure-safe",
        }
      })
      const evidence = context.buildEvidenceResult(envelope, cfg)
      envelope.actionEvidenceComplete =
        envelope.actionEvidenceComplete !== false && evidence.actionEvidenceComplete
      const tenantPolicy =
        (cfg.policy ?? policy.DEFAULT_TENANT_POLICY) +
        (input.policyAppend
          ? "\n\n## Trusted case-specific restrictions\n" + input.policyAppend
          : "")
      const user = policy.buildReviewerPrompt(tenantPolicy, evidence.text, cfg.outputFormat)
      const system =
        policy.REVIEWER_SYSTEM_PROMPT +
        (model?.format === "tool"
          ? "\nReturn the decision using permission_reviewer_result exactly once, then stop."
          : "")
      const state = {
        trustedPolicy: { reviewer: policy.REVIEWER_SYSTEM_PROMPT, tenant: tenantPolicy },
        untrustedEvidence: evidence.text,
      }
      return {
        config: cfg,
        envelope,
        system,
        user,
        evidence: evidence.text,
        schema: decision.DECISION_SCHEMA,
        systemOne: { state, questions: systemOne.SYSTEM_ONE_QUESTIONS },
        reachable: reached,
        bypass: reached ? null : preflight,
        promptHash:
          model?.format === "system_one"
            ? sha256({
                state,
                questions: systemOne.SYSTEM_ONE_QUESTIONS,
                specVersion: systemOne.SYSTEM_ONE_SPEC_VERSION,
              })
            : sha256({
                system,
                user,
                format: model?.format ?? "text",
                schema: decision.DECISION_SCHEMA,
              }),
        evidenceHash: sha256(evidence.text),
        actionEvidenceComplete: envelope.actionEvidenceComplete,
      }
    },
    async finish(prepared, parsed, errorKind, parsedSystemOne) {
      let result
      if (parsed) {
        result = parsedSystemOne
          ? {
              ...systemOne.enforceParsedSystemOneReview(parsedSystemOne, prepared.config),
              decisionSource: "system-one-reviewer",
            }
          : {
              ...decision.enforceDecision(parsed, prepared.config),
              decisionSource: "llm-reviewer",
            }
      } else
        result = escalation.applyEscalationDisposition(
          {
            kind: "escalate",
            reason:
              errorKind === "transport"
                ? "Benchmark provider request failed."
                : "Reviewer returned missing, invalid or ambiguous output.",
            decisionSource: "failure-safe",
          },
          prepared.config,
          errorKind === "transport" ? "reviewer-failure" : "invalid-decision",
        )
      const gated = structuredClone(result)
      const effective = await evaluate(prepared.envelope, prepared.config, async () =>
        structuredClone(result),
      )
      return { gated, effective }
    },
  }
}
