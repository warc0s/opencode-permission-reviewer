import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"
import type { NormalizedReviewRequest } from "../../core/contracts.ts"

type PermissionInput = Pick<
  PermissionEvaluation,
  "action" | "resources" | "metadata" | "source" | "effect"
> & { sessionID: string; agent?: string }

export function normalizeV2Permission(
  input: PermissionInput,
  scope: { reviewID: string; generation: string; directory: string; hostVersion: string },
  actionInput?: unknown,
): NormalizedReviewRequest {
  const permission =
    input.action === "shell" ? "bash" : input.action === "subagent" ? "task" : input.action
  const metadata = structuredClone(input.metadata ?? {})
  // Preserve the host hint as evidence, never as a trusted profile override.
  delete metadata.hostAgent
  if (input.agent !== undefined) metadata.hostAgent = input.agent
  const exactInput =
    typeof actionInput === "object" && actionInput !== null && !Array.isArray(actionInput)
      ? (structuredClone(actionInput) as Record<string, unknown>)
      : undefined
  if (exactInput) {
    metadata.toolInput = exactInput
    if (permission === "bash" && typeof exactInput.command === "string")
      metadata.command = exactInput.command
  }
  // A permission resource is a matching constraint, never the command itself.
  const actionEvidenceComplete =
    permission === "bash"
      ? typeof metadata.command === "string" && metadata.command.trim().length > 0
      : exactInput !== undefined
  return {
    ...scope,
    host: "v2",
    nativeAction: input.action,
    actionEvidenceComplete,
    request: {
      id: scope.reviewID,
      sessionID: input.sessionID,
      permission,
      patterns: [...input.resources],
      metadata,
      always: [],
      ...(input.source === undefined
        ? {}
        : {
            tool: { messageID: input.source.messageID, callID: input.source.id },
          }),
    },
  }
}
