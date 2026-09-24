import { readFile, readdir } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { resolve, join } from "node:path"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import { assert, sha256 } from "./util.mjs"

// Git blob hashes of the security-critical files actually inspected for this kit.
export const PINNED_BLOBS = {
  "src/policy.ts": "641e81586e738cfdee64c61bb341529707eac4eb",
  "src/context.ts": "e099dacaacca78ad4474bd35d36a291c190df256",
  "src/config.ts": "1aba599aedd942bf1377b15137e3c0a007aef878",
  "src/decision.ts": "ad3443f3bf2ca1b34b3b23e8115c79148e19238b",
  "src/policy/policy-engine.ts": "b4470dc188d956cc0ed25454c2d34465110fe1be",
  "src/escalation.ts": "ad900880c33f8b78f2f636ce4aa18f0c42d40911",
  "src/core/review-engine.ts": "6678bcec69c6bd32f11730ce5629c269c951179e",
  "src/emergency-brake.ts": "6f1b65a6f2b125a9e07824922a9ac57ce39ef2fc",
  "src/redact.ts": "78394b5cf92d787e92037ed9e6c44df323b8ed48",
  "src/capability/command-parser.ts": "520f02c8d55e6d0ffc7dcff3ae862b80acd3af5e",
  "src/capability/bash-analyzer.ts": "f11abc52f29f44452c340a66e9e8fe39f5ebc515",
  "src/shell-lexer.ts": "5865d1917b6e61dd2da671611254e93c8de677ca",
  "src/capability/heredoc-extractor.ts": "81995fef64dde83f9a9b45c8aca2fa11518d64b6",
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
function humanBlocks(messages) {
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
        .map((p) => ({ actor: "user", text: p.text, createdAt: m.info.time?.created })),
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
  const [policy, context, config, decision, escalation, engine, parser, analyzer] =
    await Promise.all([
      load("src/policy.ts"),
      load("src/context.ts"),
      load("src/config.ts"),
      load("src/decision.ts"),
      load("src/escalation.ts"),
      load("src/core/review-engine.ts"),
      load("src/capability/command-parser.ts"),
      load("src/capability/bash-analyzer.ts"),
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
      model: model?.model ?? base.model,
      variant: model?.variant ?? base.variant,
      outputFormat: model?.format === "text" ? "text" : "json_schema",
      audit: false,
      retainReviewSessions: false,
    }
  }
  function envelopeFor(input, cfg) {
    const messages = structuredClone(input.messages),
      request = structuredClone(input.request)
    const delegated = input.delegatedSession === true
    const direct = input.directUserIntent?.length
      ? input.directUserIntent.map((x) => (typeof x === "string" ? { actor: "user", text: x } : x))
      : delegated
        ? []
        : humanBlocks(messages)
    const tasks = (input.delegatedTask ?? []).map((x) =>
      typeof x === "string" ? { actor: "assistant", text: x } : x,
    )
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
        rootSessionID: prov(delegated ? "ses_root_fixture" : request.sessionID),
        delegationDepth: prov(delegated ? 1 : 0),
        parentSessionID: prov(delegated ? "ses_root_fixture" : undefined),
      },
      lineage: {
        origin: delegated ? "delegated" : "human-root",
        depth: delegated ? 1 : 0,
        rootSessionID: delegated ? "ses_root_fixture" : request.sessionID,
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
            ? [{ sessionID: "ses_root_fixture", actorName: "coordinator", mode: "primary" }]
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
                  .map((p) => ({ actor: "assistant", text: p.text })),
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
      return {
        config: cfg,
        envelope,
        system,
        user,
        evidence: evidence.text,
        schema: decision.DECISION_SCHEMA,
        reachable: reached,
        bypass: reached ? null : preflight,
        promptHash: sha256({
          system,
          user,
          format: model?.format ?? "text",
          schema: decision.DECISION_SCHEMA,
        }),
        evidenceHash: sha256(evidence.text),
        actionEvidenceComplete: envelope.actionEvidenceComplete,
      }
    },
    async finish(prepared, parsed, errorKind) {
      let result
      if (parsed)
        result = {
          ...decision.enforceDecision(parsed, prepared.config),
          decisionSource: "llm-reviewer",
        }
      else
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
