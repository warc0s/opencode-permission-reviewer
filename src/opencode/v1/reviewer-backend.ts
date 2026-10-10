import type { ReviewEnvelope, ReviewExecutionResult, ReviewerConfig } from "../../types.ts"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type { RuntimeContext, ClientResponse } from "../types.ts"
import type { ReviewAttempt } from "../../core/review-attempt.ts"
import { buildEvidenceResult } from "../../context.ts"
import {
  DECISION_SCHEMA,
  enforceDecision,
  parseDecision,
  parseDecisionFromText,
} from "../../decision.ts"
import { DEFAULT_TENANT_POLICY, REVIEWER_SYSTEM_PROMPT, buildReviewerPrompt } from "../../policy.ts"
import { splitModel } from "../../config.ts"
import { redactSecrets } from "../../redact.ts"
import { extractStructured, extractText, responseData, withTimeout } from "../transport.ts"
import { applyEscalationDisposition } from "../../escalation.ts"
import { formatFailureReason } from "../../failure-reason.ts"

/**
 * Corrective instruction appended to a text-mode parse-failure retry. Text mode
 * has no host-side schema enforcement, so instead of loosening the strict
 * fail-closed extractor (which could auto-approve a draft decision the model
 * later reversed in prose) the coordinator re-prompts once with this note and
 * parses the retry with the same extractor.
 */
const TEXT_MODE_RETRY_NOTE =
  "Your previous response could not be parsed as a decision. Respond again with " +
  "exactly one JSON object conforming to the schema and nothing else - no prose, " +
  "no Markdown code fences, no commentary, and no copy of the schema."

/** Owns isolated reviewer sessions, model calls, and their bounded cleanup. */
export class V1ReviewerBackend {
  private readonly reviewerSessions = new Set<string>()
  private readonly jobs = new Set<Promise<ReviewExecutionResult>>()
  private isolatedReviewerDirectory: string | undefined
  private isolatedReviewerDirectoryPromise: Promise<string | undefined> | undefined
  private readonly metadataCallTimeoutMs: number
  constructor(
    private readonly ctx: RuntimeContext,
    private readonly config: ReviewerConfig,
    private readonly log: (message: string, details?: unknown) => void,
    private readonly recordReviewerMs: (envelope: ReviewEnvelope, ms: number) => void,
  ) {
    this.metadataCallTimeoutMs = Math.min(config.timeoutMs, 10_000)
  }

  owns(sessionID: string): boolean {
    return this.reviewerSessions.has(sessionID)
  }

  review(envelope: ReviewEnvelope, attempt: ReviewAttempt): Promise<ReviewExecutionResult> {
    const job = this.runReview(envelope, attempt).finally(() => this.jobs.delete(job))
    this.jobs.add(job)
    return job
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.jobs])
  }

  /**
   * Resolve (and create once) the scratch directory reviewer sessions run in.
   * The directory has no AGENTS.md/CLAUDE.md or project-supplied config, so the
   * host only loads the user's trusted global instructions for the reviewer
   * session. A local config plus bootstrap plugin exclude the user's global
   * MCP servers from this location: without them the host boots a second
   * in-process Instance that spawns every enabled server under the parent PID
   * for the life of the session, even though the reviewer denies all tools.
   * Returns undefined when the directory cannot be created so the caller fails
   * into the configured reviewer-error disposition.
   */
  private async reviewerSessionDirectory(): Promise<string | undefined> {
    if (this.isolatedReviewerDirectory !== undefined) return this.isolatedReviewerDirectory
    // Share first setup across concurrent reviews. Failed setup is not cached,
    // so a later review can retry after its isolation files become usable.
    this.isolatedReviewerDirectoryPromise ??= this.setupReviewerSessionDirectory().then(
      (directory) => {
        if (directory === undefined) this.isolatedReviewerDirectoryPromise = undefined
        else this.isolatedReviewerDirectory = directory
        return directory
      },
      (error) => {
        this.isolatedReviewerDirectoryPromise = undefined
        throw error
      },
    )
    return this.isolatedReviewerDirectoryPromise
  }

  /** Create the isolation directory and its config pair once. Any failure logs
   *  and resolves undefined so the caller escalates rather than running outside
   *  the isolated location. */
  private async setupReviewerSessionDirectory(): Promise<string | undefined> {
    try {
      const { mkdir } = await import("node:fs/promises")
      const { expandHome } = await import("../../audit.ts")
      const base =
        this.ctx.reviewerDirectoryBase ?? "~/.local/share/opencode/permission-reviewer-isolated"
      const directory = expandHome(base)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const { lstat, chmod } = await import("node:fs/promises")
      if (!(await lstat(directory)).isDirectory())
        throw new Error("reviewer isolation path is not a directory")
      await chmod(directory, 0o700)
      // Publish the bootstrap before the config that references it. Atomic
      // replacements keep other backends and host processes from observing
      // empty or partial files in this shared, persistent location.
      //
      // Plugins from config sources the host applies after this location's own
      // config (OPENCODE_CONFIG_CONTENT, OPENCODE_CONFIG_DIR, the global plugin
      // directory) run their config hooks later and could add MCP servers back.
      // An accessor that always reads as a fresh empty object and drops writes
      // keeps every hook's servers out, whatever the hook order.
      await this.writeIsolatedFile(
        join(directory, "reviewer-isolation.js"),
        `export default async () => ({
  config: async (cfg) => {
    Object.defineProperty(cfg, "mcp", {
      configurable: true,
      enumerable: true,
      get: () => ({}),
      set: () => {},
    })
  },
})
`,
      )
      await this.writeIsolatedFile(
        join(directory, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          plugin: ["./reviewer-isolation.js"],
        }),
      )
      return directory
    } catch (error) {
      this.log("could not create the isolated reviewer directory", {
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  /** Replace a config file atomically without writing through an existing inode. */
  private async writeIsolatedFile(path: string, content: string): Promise<void> {
    const { open, constants, lstat, rename, rm } = await import("node:fs/promises")
    const assertReplaceable = async () => {
      const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
        return undefined
      })
      // Refuse symlinks, hardlinks, and special files before opening anything.
      // In particular, a FIFO must not hold setup open beyond the review budget.
      // A concurrent rename can unlink the inode while lstat is collecting
      // its metadata. Zero links is harmless: rename never writes that inode.
      if (existing && (!existing.isFile() || existing.nlink > 1))
        throw new Error("reviewer isolation file is linked or not a regular file")
    }
    await assertReplaceable()
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        await handle.writeFile(content)
        await handle.chmod(0o600)
      } finally {
        await handle.close()
      }
      await assertReplaceable()
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  /**
   * Fail closed unless the host reports no MCP servers for the isolation
   * location. The V1 client exposes `mcp.status` (a map keyed by server name,
   * `{}` when none); a missing surface, a transport error, or any reported
   * server aborts the review before a session is created. The host check, not
   * the on-disk config, is the guarantee that the reviewer location has no MCP.
   *
   * Known limitation: asking the host about a location is what boots its
   * Instance, so a bootstrap the host ignores would have its servers already
   * started by the time this throws. The guard then fails closed (no reviewer
   * session runs) but cannot unspawn them; only the on-disk config prevents
   * that, and it is verified against the host rather than assumed.
   */
  private async assertNoMcpServers(
    directory: string | undefined,
    attempt: ReviewAttempt,
  ): Promise<void> {
    if (directory === undefined) throw new Error("reviewer isolation unavailable")
    const mcp = this.ctx.client.mcp
    if (mcp === undefined || typeof mcp.status !== "function")
      throw new Error("reviewer isolation MCP check unavailable")
    attempt.signal.throwIfAborted()
    let inventory: unknown
    try {
      inventory = responseData(
        await attempt.wait(
          withTimeout(
            mcp.status({ query: { directory }, signal: attempt.signal }),
            this.metadataCallTimeoutMs,
          ),
        ),
        "mcp.status",
      )
    } catch (error) {
      throw new Error("reviewer isolation MCP check failed", { cause: error })
    }
    if (
      typeof inventory !== "object" ||
      inventory === null ||
      Array.isArray(inventory) ||
      (Object.getPrototypeOf(inventory) !== Object.prototype &&
        Object.getPrototypeOf(inventory) !== null)
    )
      throw new Error("reviewer isolation MCP check returned invalid data")
    if (Object.keys(inventory).length > 0)
      throw new Error("Reviewer isolation location contains MCP servers")
  }

  /** Create an instruction-isolated session or fail into the configured error route. */
  private async createReviewerSession(
    envelope: ReviewEnvelope,
    isolated: string | undefined,
    signal: AbortSignal,
  ): Promise<{ id: string; directory: string }> {
    if (isolated === undefined) throw new Error("reviewer isolation unavailable")
    const title = `[permission-review] ${envelope.request.permission}: ${redactSecrets(
      envelope.request.patterns.join(", "),
    ).slice(0, 120)}`
    const create = async (directory: string) => {
      signal.throwIfAborted()
      const created = responseData(
        await withTimeout(
          this.ctx.client.session.create({
            signal,
            body: {
              title,
            },
            query: { directory },
          }),
          this.metadataCallTimeoutMs,
        ),
        "session.create",
      )
      if (typeof created.id !== "string")
        throw new Error("session.create returned an invalid session ID")
      return created.id
    }

    return { id: await create(isolated), directory: isolated }
  }

  private async runReview(
    envelope: ReviewEnvelope,
    attempt: ReviewAttempt,
  ): Promise<ReviewExecutionResult> {
    const { providerID, modelID } = splitModel(this.config.model)
    const model = { providerID, modelID }
    let reviewSessionID: string | undefined
    let sessionDirectory: string | undefined

    try {
      // Never review inside the project if instruction isolation fails.
      const isolated = await attempt.wait(this.reviewerSessionDirectory())
      // The isolated location excludes MCP via its local config, but the guard
      // trusts the host report, not the file: a stale or tampered config, a host
      // that ignores it, or a user-level addition must all escalate rather than
      // spawn duplicate MCP processes under this session.
      await this.assertNoMcpServers(isolated, attempt)
      const created = await this.createReviewerSession(envelope, isolated, attempt.signal)
      sessionDirectory = created.directory
      reviewSessionID = created.id
      this.reviewerSessions.add(reviewSessionID)

      const toolIDs = responseData(
        await withTimeout(
          this.ctx.client.tool.ids({
            query: { directory: sessionDirectory },
            signal: attempt.signal,
          }),
          this.metadataCallTimeoutMs,
        ),
        "tool.ids",
      )
      // Deny every named tool AND everything else via the wildcard: the host
      // turns each entry into a session permission rule, and session rules
      // take precedence over agent-config allows. A plain name list is not
      // enough - MCP tools (registered outside the tool registry) and the MCP
      // resource tools would keep executing under host-configured allows. The
      // wildcard key covers unknown operational tools, including MCP tools.
      // The host filters StructuredOutput through the same permission rules.
      const tools: Record<string, boolean> = { "*": false }
      for (const id of toolIDs) tools[id] = false
      if (this.config.outputFormat === "json_schema") {
        delete tools.StructuredOutput
        tools.StructuredOutput = true
      }
      const policy = this.config.policy ?? DEFAULT_TENANT_POLICY
      const evidence = buildEvidenceResult(envelope, this.config)
      envelope.actionEvidenceComplete =
        envelope.actionEvidenceComplete !== false && evidence.actionEvidenceComplete
      const prompt = buildReviewerPrompt(policy, evidence.text, this.config.outputFormat)

      const first = await this.promptReviewer(
        reviewSessionID,
        sessionDirectory,
        model,
        tools,
        prompt,
        attempt,
      )
      let reviewerMs = first.ms
      // Record the elapsed time as soon as the reviewer returns, so a response
      // that turns out to be invalid (no data / transport error) still carries
      // reviewerMs in the audit before responseData throws below.
      this.recordReviewerMs(envelope, reviewerMs)
      const data = responseData(first.response, "session.prompt")
      const parsed =
        this.config.outputFormat === "text"
          ? parseDecisionFromText(extractText(data) ?? "")
          : parseDecision(extractStructured(data))

      // Text mode has no host-side schema enforcement or retry (unlike
      // json_schema's `retryCount: 2`), so a single flaky response would
      // escalate. Re-prompt once with a corrective note. The retry still goes
      // through the same strict extractor and enforceDecision invariants, so it
      // can never approve anything the first parse would not; it only reduces
      // spurious escalations from weaker models. Structured mode is left alone
      // because OpenCode already retries it.
      if (!parsed && this.config.outputFormat === "text") {
        const retry = await this.promptReviewer(
          reviewSessionID,
          sessionDirectory,
          model,
          tools,
          prompt,
          attempt,
          TEXT_MODE_RETRY_NOTE,
        )
        reviewerMs += retry.ms
        this.recordReviewerMs(envelope, reviewerMs)
        const retryData = responseData(retry.response, "session.prompt")
        const retryParsed = parseDecisionFromText(extractText(retryData) ?? "")
        // The retry output is authoritative for the escalation decision: if it
        // parsed, use it; otherwise fall through to the manual-review path.
        if (retryParsed !== undefined) {
          return {
            ...enforceDecision(retryParsed, this.config),
            reviewSessionID,
            decisionSource: "llm-reviewer",
          }
        }
      }

      if (!parsed) {
        return applyEscalationDisposition(
          {
            kind: "escalate",
            reason:
              this.config.outputFormat === "text"
                ? "Reviewer returned missing, invalid, or unparseable text output."
                : "Reviewer returned missing or invalid structured output.",
            reviewSessionID,
            decisionSource: "failure-safe",
          },
          this.config,
          "invalid-decision",
        )
      }
      return {
        ...enforceDecision(parsed, this.config),
        reviewSessionID,
        decisionSource: "llm-reviewer",
      }
    } catch (error) {
      return applyEscalationDisposition(
        {
          kind: "escalate",
          reason: formatFailureReason("reviewer backend", error),
          ...(reviewSessionID === undefined ? {} : { reviewSessionID }),
          decisionSource: "failure-safe",
        },
        this.config,
        "reviewer-failure",
      )
    } finally {
      if (reviewSessionID !== undefined) {
        if (this.ctx.client.session.abort) {
          await withTimeout(
            this.ctx.client.session.abort({
              path: { id: reviewSessionID },
              query: { directory: sessionDirectory },
            }),
            5000,
          ).catch(() => {})
        }
        this.reviewerSessions.delete(reviewSessionID)
        if (!this.config.retainReviewSessions && this.ctx.client.session.delete) {
          await withTimeout(
            this.ctx.client.session.delete({
              path: { id: reviewSessionID },
              query: { directory: sessionDirectory ?? this.ctx.directory },
            }),
            Math.min(this.config.timeoutMs, 5_000),
          ).catch(() => {})
        }
      }
    }
  }

  /**
   * Issue a single reviewer prompt in the review session and return the raw
   * response plus its elapsed time. `responseData` is applied by the caller so
   * the caller can record the elapsed time even when the response is invalid.
   * The role/safety rules live in the system prompt so they carry system-level
   * priority over the untrusted evidence; the per-request part (and an optional
   * corrective retry note) is appended as user content.
   */
  private async promptReviewer(
    reviewSessionID: string,
    sessionDirectory: string,
    model: { providerID: string; modelID: string },
    tools: Record<string, boolean>,
    prompt: string,
    attempt: ReviewAttempt,
    retryNote?: string,
  ): Promise<{ response: ClientResponse<Record<string, unknown>>; ms: number }> {
    const start = performance.now()
    attempt.signal.throwIfAborted()
    const response = await attempt.wait(
      withTimeout(
        this.ctx.client.session.prompt({
          signal: attempt.signal,
          path: { id: reviewSessionID },
          query: { directory: sessionDirectory },
          body: {
            model,
            variant: this.config.variant,
            tools,
            system: REVIEWER_SYSTEM_PROMPT,
            format:
              this.config.outputFormat === "text"
                ? { type: "text" }
                : {
                    type: "json_schema",
                    schema: DECISION_SCHEMA,
                    retryCount: 2,
                  },
            parts:
              retryNote === undefined
                ? [{ type: "text", text: prompt }]
                : [
                    { type: "text", text: prompt },
                    { type: "text", text: retryNote },
                  ],
          },
        }),
        this.config.timeoutMs,
      ),
    )
    return { response, ms: performance.now() - start }
  }
}
