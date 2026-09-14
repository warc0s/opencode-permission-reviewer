/** Portable, read-only protocol. No UI message can approve a permission. */
export const ReviewerRpc = {
  id: "opencode-permission-reviewer",
  methods: {
    identity: {
      input: { type: "object", additionalProperties: false },
      output: { type: "string" },
    },
    status: { input: { type: "object", additionalProperties: false }, output: { type: "object" } },
    snapshot: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object" },
    },
  },
  events: { "review.updated": { schema: { type: "object" } } },
} as const
