import type { PermissionRequest, ReviewExecutionResult } from "../types.ts"

export interface NormalizedReviewRequest {
  reviewID: string
  hostRequestID?: string
  host: "v1" | "v2"
  hostVersion: string
  generation: string
  directory: string
  nativeAction: string
  actionEvidenceComplete: boolean
  request: PermissionRequest
}

export type ReviewResult = ReviewExecutionResult

/** Receiving an approval does not prove that a tool executed. */
export type ApplicationResult =
  | "evaluation-returned"
  | "reply-accepted"
  | "human-pending"
  | "superseded"
  | "cancelled"
  | "unknown"
