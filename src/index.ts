import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { loadResolvedConfig } from "./config/loader.ts"
import { ApprovalReviewerRuntime } from "./runtime.ts"
import { extractPermissionRequest } from "./opencode/event-normalizer.ts"
import { createV1Adapter } from "./opencode/v1-adapter.ts"
import { AskDecisionRegistry } from "./context/ask-decisions.ts"
import type { RuntimeContext } from "./opencode/types.ts"
import { createAuditWriter } from "./audit.ts"

export const server: Plugin = async (input, options) => {
  const config = loadResolvedConfig(options, input.directory)
  const logger = config.debug
    ? (message: string, details?: unknown) => {
        console.error(`[opencode-permission-reviewer] ${message}`, details ?? "")
      }
    : undefined
  const writeAudit = createAuditWriter(config, logger)
  const ctx: RuntimeContext = {
    ...createV1Adapter(
      {
        client: input.client,
        directory: input.directory,
        worktree: input.worktree,
      },
      logger,
    ),
    ...(writeAudit === undefined ? {} : { writeAudit }),
  }
  // Ask-decision capture runs only when enabled; the registry is the sole
  // consumer of question events and never affects permission handling.
  const askDecisions = config.askDecisions ? new AskDecisionRegistry(logger) : undefined
  const runtime = new ApprovalReviewerRuntime(ctx, config, logger, undefined, askDecisions)

  return {
    event: async ({ event }) => {
      // Observe synchronously first: reviews started by later events must see
      // ask decisions captured by this one. The observer is total.
      askDecisions?.observe(event)
      runtime.handlePermissionReply(event)
      const request = extractPermissionRequest(event)
      if (!request) return
      runtime.handle(request)
    },
    // Approvals no longer annotate tool results. `annotateToolResult` remains
    // exported as a deprecated no-op for external callers; the host hook is
    // omitted so it is not invoked after every tool execution for no effect.
    dispose: async () => {
      await runtime.waitForIdle()
    },
  }
}

const module: PluginModule = {
  id: "opencode-permission-reviewer",
  server,
}

export default module
export { ApprovalReviewerRuntime } from "./runtime.ts"
export { extractPermissionRequest } from "./opencode/event-normalizer.ts"
export { resolveConfig } from "./config.ts"
export { loadResolvedConfig } from "./config/loader.ts"
export { parseDecision, enforceDecision, DECISION_SCHEMA } from "./decision.ts"
export { applyEscalationDisposition, resolveEscalationDisposition } from "./escalation.ts"
export { emergencyBrakeReason } from "./emergency-brake.ts"
export { redactSecrets } from "./redact.ts"
export { createUiStatus, decodeUiStatus, encodeUiStatus, permissionAction } from "./ui-protocol.ts"
export { ReviewUiState } from "./ui-state.ts"
export { createAuditWriter, DEFAULT_AUDIT_PATH } from "./audit.ts"
export { enrichSshEvidence } from "./ssh-evidence.ts"
export { enrichLocalScriptEvidence } from "./local-script-evidence.ts"
export { enrichGitEvidence } from "./git-evidence.ts"
export { AskDecisionRegistry, DISMISSED_ANSWER } from "./context/ask-decisions.ts"
export type * from "./types.ts"
