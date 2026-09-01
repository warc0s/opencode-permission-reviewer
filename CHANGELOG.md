# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] - 2026-09-01

### Added

- The reviewer now sees what the user answered in agent ask dialogs as scoped
  authorization evidence (`USER_ASK_DECISIONS` prompt section plus an additive
  `askDecisions` audit field; only the question and the selected option are
  captured). Configure with `askDecisions` (default `true`).

### Fixed

- The TUI overlay never rendered for npm-installed plugins: the app-slot
  factory rendered once at boot and never re-rendered, because it read no
  signal directly in its own scope. The factory now renders from direct signal
  reads, and `solid-js` is pinned to `@opentui/solid`'s exact peer so npm
  installs keep a single Solid runtime. Regression-guarded by headless slot
  contract tests and tarball-install checks.

## [1.2.4] - 2026-09-01

### Changed

- Bumped `@opencode-ai/plugin` to 1.18.25 and `@opentui/core`/`@opentui/solid`
  to 0.5.9, with `bun.lock` synchronized (dependency bumps only; no behavior
  change).

## [1.2.3] - 2026-08-25

### Changed

- Bumped `@opencode-ai/plugin` to 1.18.21, `@opentui/core`/`@opentui/solid`
  to 0.5.6, and `solid-js` to 1.9.15, with `bun.lock` synchronized
  (dependency bumps only; no behavior change). The OpenTUI updates pull in
  renderer fixes (stale mouse input, GNU Screen OSC 52 passthrough, Sixel
  fallback on Kitty).
- The live smoke harness now uses `opencode/mimo-v2.5-free` as its driver
  model after `opencode/deepseek-v4-flash-free` was retired from the gateway.

## [1.2.2] - 2026-08-20

### Fixed

- Text-mode reviews now re-prompt the reviewer once when the first response is
  missing, invalid, or unparseable, mirroring the auto-retry that `json_schema`
  mode already gets from OpenCode's `retryCount`. This absorbs the occasional
  flaky response from weaker models (e.g. `opencode-go/deepseek-v4-flash`) that
  previously escalated straight to "Manual review required". The retry is
  parsed with the same strict, fail-closed extractor, so it can never approve
  anything the first parse would not; a response that is still invalid after
  the retry escalates as before.
- Text-mode prompt now explicitly tells the reviewer not to echo the schema as
  an example (a schema copy plus a decision object in one response is
  ambiguous and escalates).

## [1.2.1] - 2026-08-18

### Changed

- Bumped `@opencode-ai/plugin` to 1.18.18 and `@opentui/core`/`@opentui/solid`
  to 0.5.3, with `bun.lock` synchronized (dependency bumps only; no behavior
  change).

## [1.2.0] - 2026-08-18

### Added

- New `outputFormat` config option (`json_schema` | `text`, default
  `json_schema`). `text` lets reviewer models that do not support OpenCode's
  `json_schema` structured-output format (e.g. `opencode-go/deepseek-v4-flash`)
  be used: the model emits its decision as plain JSON, which the plugin parses
  locally through the same strict `parseDecision` validation and
  `enforceDecision` invariants. Text-mode parsing is fail-closed: the response
  must be exactly one JSON object (optionally in a single code fence); any
  ambiguity escalates to a human. Text mode is safe but produces more
  escalations than structured output.

## [1.1.1] - 2026-08-08

### Fixed

- Fail-closed escalate→deny no longer invents a synthetic `ReviewDecision`
  (`risk_level: high`, `confidence: 1`) or a `reviewerOutcome` when no valid
  structured decision existed (timeout, invalid output, policy-manual, etc.).
  Real LLM `escalate` decisions keep `decision.outcome: "escalate"` under
  fail-closed deny.
- `ACTION_PURPOSE` now recovers prose from the exact assistant message that
  issued the tool call (`request.tool.messageID` / `callID`) before falling
  back to intent-derived evidence.
- Plugin no longer registers a no-op `tool.execute.after` hook; deprecated
  `annotateToolResult` remains exported for API compatibility.

## [1.1.0] - 2026-08-08

Non-interactive fail-closed mode and asymmetric agent feedback, without changing
the default interactive behavior.

### Added

- `escalationMode: "manual" | "deny"` (default `manual`). In `deny` mode every
  final internal escalation is converted to a reject with the original reason,
  so autonomous agents can run without human prompts while remaining fail-closed.
- Wired `riskPolicy.onInvalidDecision` and `riskPolicy.onReviewerFailure` so
  they harden invalid structured output and reviewer transport/timeout failures
  respectively (under `escalationMode: "manual"`). `escalationMode: "deny"`
  hardens every escalate path globally. Restrictive settings only block more.
- Central escalation disposition boundary (`applyEscalationDisposition`) applied
  after reviewer/policy/fail-safe produce `allow | deny | escalate`.
  `manual-superseded` is never converted.
- `ACTION_PURPOSE` evidence section in the reviewer prompt (agent-context →
  intent-derived → unavailable). Never invented; does not prove authorization.
- Additive audit/UI fields `reviewerOutcome` and `escalationDisposition` so
  reports and the TUI can distinguish an explicit deny from fail-closed
  escalate→deny (`schemaVersion` stays `2`).
- Trust-boundary clamps for `escalationMode` and risk-policy failure knobs
  (project config can only harden, never relax a trusted deny).

### Changed

- Approvals no longer annotate tool results. Allow is silent to the primary
  agent; deny still returns actionable feedback. `annotateToolResult` remains
  as a deprecated no-op for 1.x API compatibility.
- Reviewer system prompt version bumped to `2.1.0` (ACTION_PURPOSE guidance).
  Structured decision schema stays at version `2`.

### Fixed

- Partial project `riskPolicy` objects no longer wipe trusted
  `onInvalidDecision` / `onReviewerFailure` values back to defaults.

## [1.0.0] - 2026-08-07

The first stable release. The public configuration schema, the audit schema
(v2), and the OpenCode 1.x adapter contract are frozen for the 1.x line. See
[`docs/migration-guide.md`](./docs/migration-guide.md) for the upgrade path.

### Added

- Reference documentation: migration guide, threat model, policy reference,
  capability model, actor resolution, compatibility policy, and architecture
  decision records (`docs/`).
- Community health files: code of conduct, issue templates (bug report with
  adapter-diagnostics requirement, feature request with a safety checklist),
  pull-request template, and code owners.
- Release pipeline: tag-driven workflow that builds, publishes to npm with
  build provenance, generates SHA-256 checksums and a CycloneDX SBOM, and
  creates a GitHub Release with all artifacts attached (`.github/workflows/release.yml`).
- Security automation: CodeQL scan and Dependabot configuration.
- Coverage gate: `bun run test:coverage` enforces ≥ 90% global line coverage
  and 100% on safety-critical modules (decision, policy, emergency brake,
  event normalization, reply transport, redaction).

### Fixed

- TUI overlay renders again: the `./tui` export points at raw
  `dist/tui/tui.tsx` (copied by `scripts/copy-tui.ts`) instead of a prebundled
  JS file, so the OpenCode host compiles it with its own Solid/OpenTUI
  pipeline. The shipped TUI graph no longer pulls the server engine into the
  TUI process.
- Overlay selection no longer hides later reviews behind a stale manual toast:
  manual entries are excluded from the panel slot, in-flight reviews win over
  terminal results, and the start grace before "manual" is 15s (was 3s).
- UI status publishing treats the typed SDK `{ data, error }` resolve shape as
  a failure when `error` is set, and the declarative manual policy route emits
  a UI status. A failed `mode.push` no longer leaves the overlay half-registered.

### Changed

- Dropped the unused `@opentui/keymap` dependency.

## [0.9.0] - 2026-08-07

### Added

- Layered configuration: merges builtin defaults, global
  (`~/.config/opencode/permission-reviewer.jsonc`), project
  (`.opencode/permission-reviewer.jsonc`), and inline plugin options, with JSONC
  parsing support.
- Reviewer decision schema v2: `version: 2` is now required, and decisions must
  declare `scope_alignment` and `evidence_completeness`. In enforce mode, new
  deterministic gates escalate allows with misaligned scope or insufficient
  evidence. A model output that omits `version: 2` is rejected and routed to
  manual review, so a model that does not follow the v2 schema never produces an
  automatic decision.
- Audit schema v2: every record now carries `schemaVersion: 2`, `decisionSource`,
  an `actionHash` for cross-record correlation, per-phase timings, the reviewer
  model, evidence completeness, scope alignment, and actor
  `identitySource`/`confidence`. Capability and policy-trace objects remain
  additive, so v1 readers keep working.
- Isolated reply transport: permission replies flow through a dedicated module
  with a documented priority chain (public SDK reply with message, then public
  reply plus a feedback channel, then the authenticated raw transport, then
  refuse startup). Host capabilities are probed once at startup.
- Version gate: refuses to start against OpenCode v2-generation clients until
  their reply contract is verified.
- CLI subcommands via the `opencode-permission-reviewer` binary (no subcommand
  still runs `explain` for backward compatibility):
  - `doctor` — package/runtime versions, config sources with hashes, resolved
    model, policy mode and rule count, effective policy hash, audit-path
    writability.
  - `config print-effective` — resolved config and engine-equivalent policy hash.
  - `audit report` — summarizes the JSONL audit trail and flags unknown actors
    and records missing required fields.
- Public npm package: drops the private flag, points `main`/`types`/`exports` at
  the built `dist/` bundle, generates d.ts, rebuilds on install, and ships only
  `dist` plus docs (verified by a pack smoke test).
- TUI status publishing migrated to the typed v1 `client.tui.publish` API.
- Reviewer prompt v2.0.0 with new `EFFECTIVE_POLICY_SUMMARY`,
  `LOCAL_SESSION_CONTEXT`, and `REPOSITORY_CONTEXT` sections.

### Security

- Trust boundary: project config can no longer redirect or silence the audit
  trail (`auditPath`) or grant its own agent a higher-privilege profile
  (`actorProfiles`) — both are restricted to global/inline config.
- Project config can no longer downgrade a global `enforcementMode: "enforce"`
  to `observe`.
- Project policy rules are now combined with trusted (global/inline) rules
  instead of replacing them, so a repository can no longer erase a user's deny
  or manual rules by declaring an empty or narrower set.

### Changed

- Model decisions missing `version: 2` are rejected instead of defaulting
  missing v2 fields to unknown.

### Fixed

- Bare backtick command substitution (e.g. `echo \`whoami\``) is now correctly
  detected as dynamic instead of being treated as complete.
- Single-quoted literal strings (e.g. `echo 'literal $VAR'`) are no longer
  misdetected as dynamic.
- Malformed policy rule conditions no longer crash the engine — the rule is
  dropped defensively.
- JSONC trailing-comma stripping is now string-aware; `,}` or `,]` inside a
  string value is no longer corrupted.
- `audit report` expands `~` in `--path`, and `actionHash` excludes
  per-invocation tool IDs so identical commands correlate across runs.
- Importing the CLI module no longer runs the dispatcher, and the audit
  writability probe creates files with mode `0600`.

## [0.8.0] - 2026-08-06

### Added

- Static capability analysis for bash commands: structured facts for code
  execution, write effects, network, process side-effects, remote/git mutation,
  and privilege escalation, with heredoc bodies extracted before lexing and an
  honest completeness marker (complete / partial / opaque).
- Capability assessment threaded into the reviewer prompt as a new
  `CAPABILITY_ASSESSMENT` section and into the audit record as an additive
  capability snapshot.
- Declarative policy engine: evaluates capability and actor facts against
  declarative rules with most-restrictive resolution. Default rules ship empty,
  so observe mode produces zero behavior change.
- Enforce mode: manual/deny policy routes skip the LLM entirely; the emergency
  brake always runs first and is never weakened.
- `explain` CLI: dry-runs a bash command through the capability analyzer and
  policy engine without a running opencode, reading a permission request from a
  JSON fixture or stdin and printing the capability assessment and policy trace
  as JSON.
- Configurable risk × authorization matrix via `RiskPolicy` with conservative
  defaults that reproduce the previous behavior exactly, plus a
  `RepositoryTrust` type.
- Policy traces (effective policy hash, matched rules, final route, mode) in the
  audit record, with a counterfactual trace in observe mode.

## [0.7.0] - 2026-08-06

### Added

- Agent-aware context: the requesting tool's `agent`/`mode` is resolved from the
  session, walking parent sessions via the SDK with cycle/depth guards, and
  degrading honestly to "unknown" on any failure — a review always proceeds.
- Reviewer prompt sections `ACTOR_CONTEXT`, `SESSION_LINEAGE`,
  `DIRECT_USER_INTENT`, `DELEGATED_TASK`, and `EVIDENCE_COMPLETENESS` before
  `PENDING_PERMISSION`.
- Audit records gain an additive actor snapshot (identity completeness) and
  `rootSessionID`; the TUI shows the actor name.
- New config knobs: `enforcementMode` (default `observe`), `maxSessionDepth`,
  `maxParentSessions`, and `actorProfiles`.

### Changed

- Observe-only release: the decision schema and enforcement gates are
  untouched, so reviewer decisions do not change.

## [0.6.0] - 2026-08-06

### Changed

- Internal architecture boundary: the approval pipeline is extracted into a
  dedicated adapter, review coordinator, and evidence providers with
  byte-identical behavior — no user-facing behavior change versus 0.5.2.
- Audit records now carry an additive `schemaVersion: 1` (readers default
  missing values to 1).
- Tooling: ESLint 9, tsup ESM build, and Prettier are added; `bun run check`
  now runs format, lint, typecheck, tests, and build as a single gate.
