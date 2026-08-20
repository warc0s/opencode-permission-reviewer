# OpenCode Permission Reviewer

> [!NOTE]
> This is an **unofficial community plugin** for OpenCode. It is not affiliated
> with or endorsed by [Anomaly](https://anoma.ly).

> **A tool-free AI reviewer for every `ask` permission.** It reads the request,
> your policy, and the session context, then **allows once, denies with
> feedback, or escalates to you** — so safe actions don't wait for a keystroke,
> and genuinely risky ones still get blocked or surfaced.

[![OpenCode](https://img.shields.io/badge/OpenCode-%E2%89%A51.18.11-6E56CF)](https://opencode.ai)
[![Bun](https://img.shields.io/badge/Bun-%E2%89%A51.3.0-000000)](https://bun.sh)
[![License](https://img.shields.io/github/license/Warc0s/opencode-permission-reviewer?color=blue)](./LICENSE)
[![Checks](https://img.shields.io/github/actions/workflow/status/Warc0s/opencode-permission-reviewer/ci.yml?branch=main&label=checks)](https://github.com/Warc0s/opencode-permission-reviewer/actions/workflows/ci.yml)
[![Open issues](https://img.shields.io/github/issues/Warc0s/opencode-permission-reviewer)](https://github.com/Warc0s/opencode-permission-reviewer/issues)

OpenCode pauses on **every** `ask` permission and waits for a keystroke — even
for safe, routine actions. This plugin adds a Codex-Guardian-style reviewer: a
dedicated, tool-free model session reads the pending request, bounded
transcript evidence, recovered user intent, and **a tenant policy you control**,
then allows `once`, denies with rationale, or escalates to you.
**Critical risk is never allowed**, and anything broken or uncertain
fails safe to manual review.

- **Preserves your policy** — `allow` continues, `deny` stays blocked; neither
  ever reaches the reviewer.
- **Tool-free child session** — the reviewer has no tools and cannot request
  permissions recursively.
- **Read-only enrichment** — bounded, sanitized SSH / local-script / Git
  evidence for the reviewer; the filesystem is never modified.
- **Auditable** — one JSONL record per review, with remote commands stored as
  SHA-256, not plaintext.
- **Optional TUI overlay** — shows review state and gets out of the way of your
  native approval controls.

> **Policy adapted from [OpenAI Codex Guardian](https://github.com/openai/codex/tree/main/codex-rs/core/src/guardian)**
> — the reviewer policy text in this project derives from Codex's auto-review
> policy (Apache-2.0). The implementation is independent. See [`NOTICE`](./NOTICE).

---

## Quickstart

### Requirements

- [Bun](https://bun.sh) ≥ 1.3.0 (CI runs 1.3.0 and 1.3.5)
- [OpenCode](https://opencode.ai) ≥ 1.18.11 and **&lt; 2** (**tested with 1.18.15**)
- `git` on `PATH` (only used for read-only Git-state enrichment; missing git
  degrades gracefully)
- A model provider configured in OpenCode, exposing a model that follows JSON
  schemas reliably (see [Choosing the reviewer model](#choosing-the-reviewer-model))
- A permission policy with at least one `ask` rule — **if nothing is `ask`, the
  plugin never activates** (everything is already `allow`/`deny`).

See [Supported versions](#supported-versions) for the full matrix.

### Install

The package is published to **npm**. Install it as a dependency, or clone and
build when you want to run from a checkout:

```bash
# From npm
bun add opencode-permission-reviewer   # or: npm install opencode-permission-reviewer

# From a checkout (development)
git clone https://github.com/Warc0s/opencode-permission-reviewer.git
cd opencode-permission-reviewer
bun install && bun run build
```

What ships in `dist/`:

- **Server** — `main` / `./server` → `dist/index.js` (bundled).
- **TUI overlay** — `./tui` → `dist/tui/tui.tsx` (**raw TSX**, not a JS bundle).
  OpenCode's host compiles that entry with its own Solid/OpenTUI pipeline and
  rewrites `solid-js` / `@opentui/*` onto the host runtime. A prebundled
  `dist/tui.js` loads but **never paints** the overlay.
- **CLI** — `./cli` / `bin` → `dist/explain.js`.

The CLI can register the plugin for you (`--tui` also writes `tui.json`;
`--npm` emits an npm package name instead of a path; it never clobbers an
existing entry):

```bash
bunx opencode-permission-reviewer init --npm --tui --yes
```

### Configure

Register the plugin in your `opencode.json` (project or
`~/.config/opencode/opencode.json`). Use an absolute path to a checkout, or the
npm package name after `bun add` / `npm install`:

```jsonc
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "/absolute/path/to/opencode-permission-reviewer",
      // or: "opencode-permission-reviewer"
      {
        "model": "openai/gpt-5.6-luna", // default reviewer; override with any provider/model
        "variant": "max",
        "timeoutMs": 120000,
      },
    ],
  ],
  "permission": {
    "bash": "ask", // at least one ask rule, or the plugin is a no-op
  },
}
```

For the optional TUI overlay, register the **same** plugin block in your
`tui.json` (`~/.config/opencode/tui.json`). Keep `model`, `variant`, and
`timeoutMs` **identical** in both files so the watchdog and server agree:

```jsonc
// tui.json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "/absolute/path/to/opencode-permission-reviewer",
      { "model": "openai/gpt-5.6-luna", "variant": "max", "timeoutMs": 120000 },
    ],
  ],
}
```

**Restart OpenCode fully** after install or rebuild. The host imports the plugin
once at startup; a live session keeps the previous code in memory and will not
show a rebuilt overlay.

Then ask the agent to run something safe, e.g. `printf hello`. An auto-approved
`ask` resolves itself with `once` and the tool runs normally — **without**
injecting rationale into the agent context. Denials still return a short reason
the agent can act on.

**Cost note:** every `ask` action now spawns one extra child-session model
call (up to `timeoutMs`). Your model spend scales with how much your policy
`ask`s. Lower the reasoning `variant` or raise `confidenceThreshold` to taste.

## Choosing the reviewer model

The reviewer is a normal OpenCode model invocation (tools disabled), so it can
be **any model from any provider you have configured**. Three options,
identical in both config files:

- **`model`** — in `provider/model` form. Must match a configured provider and
  a model that provider exposes.
- **`variant`** — reasoning effort the model supports (`max`, `high`, `medium`,
  `low`, `none`). Passed straight through to OpenCode.
- **`outputFormat`** — how the reviewer returns its decision: `json_schema`
  (default; uses OpenCode's structured output, needs provider support) or
  `text` (ask the model to emit JSON in plain text and parse it locally). Use
  `text` for models that reject the `json_schema` format, e.g.
  `opencode-go/deepseek-v4-flash`.
- **`timeoutMs`** — review timeout; must match across files.

The default reviewer is **`openai/gpt-5.6-luna`** (`max` reasoning) — a real
model that follows JSON schemas well. Override `model` to use any other
provider/model you have configured; whichever you pick should follow structured
output reliably, because weaker models just produce more escalations (safe, but
noisier). Higher reasoning variants give better safety judgments at higher
cost/latency.

### Reviewer models without structured-output support

Some models (for example `opencode-go/deepseek-v4-flash`) do not support
OpenCode's `json_schema` structured-output format and fail with a format error
when it is requested. For those, set `"outputFormat": "text"` so the reviewer
asks the model to emit its decision as plain JSON and parses it locally. This
needs the flag set identically in both `opencode.json` and `tui.json`:

```jsonc
{
  "model": "opencode-go/deepseek-v4-flash",
  "variant": "high",
  "outputFormat": "text",
  "timeoutMs": 120000,
}
```

Text mode is **safe but noisier**: without host-side schema enforcement the
plugin re-prompts the reviewer once if the response is unparseable (mirroring
the auto-retry that `json_schema` mode gets from OpenCode), and a response that
is still invalid escalates to a human rather than being auto-approved. Parsing
is deliberately strict and fail-closed: the entire response must be exactly one
JSON object (optionally wrapped in a single Markdown code fence). Prose around
the object, multiple objects, multiple fences, or any other ambiguity escalates
to a human — the parser never guesses which candidate the model meant. Every
parsed decision still passes the same strict `parseDecision` validation and
`enforceDecision` invariants (critical risk is never approved, etc.), so text
mode cannot approve anything that structured mode would not.

One caveat applies to any output format: the deterministic gates check the
decision's _consistency_, not its semantic correctness. A reviewer model that
misclassifies an unsafe action as low risk can produce an unsafe `allow` in
either mode, so pick as strong a reviewer model as your budget allows.

### All configuration options

Every option is optional. Numeric/string options are clamped to safe bounds.

| Option                 | Default                                                   | Bounds / type                       | Description                                                                         |
| ---------------------- | --------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------- |
| `model`                | `openai/gpt-5.6-luna`                                     | `provider/model`                    | Reviewer model (override with any provider/model)                                   |
| `variant`              | `max`                                                     | non-empty string                    | Reasoning variant passed to OpenCode                                                |
| `outputFormat`         | `json_schema`                                             | `json_schema` / `text`              | How the reviewer returns its decision (`text` for models without structured output) |
| `timeoutMs`            | `120000`                                                  | `5000`–`600000`                     | Review timeout (match in both files)                                                |
| `confidenceThreshold`  | `0.7`                                                     | `0.5`–`1`                           | Minimum confidence to auto-act; below it escalates                                  |
| `maxContextChars`      | `32000`                                                   | `4000`–`200000`                     | Total transcript evidence budget                                                    |
| `maxPartChars`         | `8000`                                                    | `500`–`50000`                       | Per-message-part budget                                                             |
| `maxEnrichmentChars`   | `24000`                                                   | `1000`–`100000`                     | SSH / script / Git enrichment budget                                                |
| `maxIntentChars`       | `8000`                                                    | `1000`–`50000`                      | User-intent history budget                                                          |
| `transcriptMessages`   | `12`                                                      | `1`–`100`                           | Recent messages shown to the reviewer                                               |
| `intentMessages`       | `8`                                                       | `1`–`50`                            | Genuine user intents kept                                                           |
| `historyMessages`      | `200`                                                     | `20`–`500`                          | Messages fetched to recover intent                                                  |
| `retainReviewSessions` | `false`                                                   | boolean                             | Keep reviewer child sessions (debug only; see below)                                |
| `audit`                | `true`                                                    | boolean                             | Append one JSONL audit record per review                                            |
| `auditPath`            | `~/.local/share/opencode/permission-reviewer-audit.jsonl` | path                                | Audit file location                                                                 |
| `policy`               | built-in default                                          | string                              | Full local override of the tenant policy text                                       |
| `debug`                | `false`                                                   | boolean                             | Verbose logs to stderr                                                              |
| `enforcementMode`      | `observe`                                                 | `observe` / `enforce`               | `enforce` applies declarative policy routes; `observe` audits them only             |
| `escalationMode`       | `manual`                                                  | `manual` / `deny`                   | How final escalations are disposed (`manual` = human; `deny` = fail-closed reject)  |
| `maxSessionDepth`      | `8`                                                       | `1`–`32`                            | Parent-session lineage walk depth                                                   |
| `maxParentSessions`    | `8`                                                       | `0`–`32`                            | Max parent sessions resolved for actor context                                      |
| `actorProfiles`        | `{}`                                                      | name → profile map                  | Trusted agent name → profile (`read-only`, `validation`, `workspace`, …)            |
| `riskPolicy`           | built-in conservative matrix                              | object                              | Override `allow` cells per risk level and failure modes (`onInvalidDecision`, …)    |
| `repositoryTrust`      | `unknown`                                                 | `trusted` / `untrusted` / `unknown` | Repository trust level used by the policy engine                                    |
| `policyRules`          | `[]`                                                      | array                               | Declarative rules (most-restrictive wins); project rules combine with trusted ones  |

Config is layered: built-in defaults ← global
`~/.config/opencode/permission-reviewer.jsonc` ← project
`.opencode/permission-reviewer.jsonc` ← inline plugin options (later wins).
For safety, project config cannot redirect `auditPath`, grant `actorProfiles`,
downgrade a global `enforcementMode: "enforce"`, or relax a trusted
`escalationMode: "deny"` / failure-mode deny knob.

#### Interactive vs autonomous

| Mode                        | Config                     | Behavior                                                                |
| --------------------------- | -------------------------- | ----------------------------------------------------------------------- |
| Interactive (default / 1.0) | `escalationMode: "manual"` | Uncertainty escalates to you; OpenCode's native approval UI takes over  |
| Autonomous / fail-closed    | `escalationMode: "deny"`   | Every final escalation becomes a reject with rationale; no human prompt |

For unattended agents, set fail-closed in **global** config (not in the repo):

```jsonc
// ~/.config/opencode/permission-reviewer.jsonc
{
  "escalationMode": "deny",
}
```

Optional fine-grained hardening under interactive mode (only their own cases):

```jsonc
{
  "riskPolicy": {
    "onInvalidDecision": "deny", // invalid structured output → reject
    "onReviewerFailure": "deny", // timeout / transport failure → reject
  },
}
```

`escalationMode: "deny"` hardens every escalate path globally. Restrictive
settings can only block more, never relax security.

`audit` defaults to `true`. Each completed review appends one JSON object to
the audit path with mode `0600` (`schemaVersion: 2`): outcome, decision source,
rationale, risk, authorization, confidence, per-phase latency, reviewer model,
optional `reviewerOutcome` / `escalationDisposition` (to distinguish an explicit
deny from fail-closed escalate→deny), and a bounded SSH summary. Remote commands
are stored as **SHA-256**, never in clear text. Set `audit: false` to disable.

## What you'll see

```
┌──────────────────────────────────────────────────────────┐
│ ✓ Review approved                          1.4s           │
│ bash  $ rm -rf /tmp/scratch-cache                        │
│ low risk · high authorization · 0.94 confidence           │
│ Narrowly scoped temp cleanup; matches user intent.       │
└──────────────────────────────────────────────────────────┘
```

While reviewing, the panel covers OpenCode's native approval controls and
switches the keymap out of approval mode. On a denial you get a red panel with
the rationale. On a technical failure or escalation, the overlay is removed and
OpenCode's native approval controls are exposed with a **manual review
required** warning. Completed approvals/denials stay visible for 5 s, then
close automatically. A broken TUI transport **never changes the safety
decision**.

## How it works

1. OpenCode emits `permission.asked` for any `ask`-classified action.
2. A deterministic **emergency brake** rejects unmistakable root destruction and
   direct credential export before any model call. It is wrapper-aware
   (`sudo`, `doas`, `env`, `command`, `nice`, `nohup`, …), so `sudo rm -rf /`,
   `env VAR=x rm -rf /`, `/bin/rm -rf /`, `sh -c 'rm -rf /'`, `ssh host rm -rf /`,
   and `busybox rm -rf /` are all caught.
3. The plugin builds bounded **evidence**: recent transcript, recovered user
   intent (filtering synthetic compaction messages), and optional read-only
   enrichment for SSH commands, local interpreter scripts, and Git state.
   **Common credential formats are always redacted** from this evidence
   (`Bearer`, AWS / GitHub / OpenAI / Anthropic / Slack / Google / Stripe /
   GitLab keys, JWTs, private keys, URL userinfo, cookies, and
   credential-bearing assignments) so a secret you once pasted into the
   session never travels to the reviewer's provider.
4. A **tool-free child session** runs the reviewer model with a strict JSON
   schema and returns `{ outcome, risk_level, user_authorization, rationale,
confidence }`.
5. Decisions are enforced with invariants: **critical risk is never approved**,
   **high risk with low/unknown authorization is escalated**, **medium risk
   with unknown authorization is escalated**, low confidence is escalated,
   invalid output is escalated, errors and timeouts are escalated. A single
   enforcement boundary then disposes every internal `escalate` according to
   `escalationMode` (`manual` → human; `deny` → reject with the original reason).
6. Approved actions get `once` (never `always`) and execute **silently** — the
   tool output is not annotated, so approval rationale never contaminates the
   primary agent context (rationale still lands in audit, TUI, and debug logs).
   Denials return a short actionable rationale as tool feedback. A manual reply
   that arrives mid-review **supersedes** the automatic one (no double reply).

By default everything fails safe to **manual review**. With
`escalationMode: "deny"`, uncertainty fails closed to a reject with reason
instead — suitable for non-interactive agents.

## Reference documentation

The README is the overview. For depth, see the dedicated references in
[`docs/`](./docs):

- [Migration guide](./docs/migration-guide.md) — upgrading to the 1.0 line,
  enabling enforcement, and rolling back.
- [Threat model](./docs/threat-model.md) — attack surfaces, mitigations, and
  what the plugin does and does not protect against.
- [Policy reference](./docs/policy-reference.md) — declarative rules, the
  condition schema, effects, and precedence.
- [Capability model](./docs/capability-model.md) — the static analysis fields
  that feed the policy engine and the reviewer.
- [Actor resolution](./docs/actor-resolution.md) — how the requester's identity
  and session lineage are recovered.
- [Compatibility and support](./docs/compatibility.md) — version matrix and
  support policy.
- [Decision records](./docs/adr/README.md) — architectural choices and their
  rationale.

## Evidence enrichment

The reviewer never sees the raw filesystem — only bounded, sanitized evidence.
Enrichment is deliberately conservative and **never makes an approval decision
by itself** (one narrow deterministic exception exists for SSH, below).

- **SSH commands** are parsed into destination, options, remote command,
  environment/mutation/secret/stdin signals, and bounded stdin content for the
  common `cat script | ssh ... python -` pattern. Sensitive paths,
  credential-like literal content, binary files, unresolved shell expressions,
  and symlinks escaping approved roots are excluded.
- **Local interpreter commands** (Python, Node, Bun, shell, Ruby, Perl, and
  compound commands that first activate an environment) get the same bounded
  inspection when they name an explicit script. Inline code, modules, stdin
  programs, dynamic paths, and remote-only SSH arguments are not misidentified
  as local files.
- **Git operations** (`add`, `commit`, `checkout`, `restore`, `rm`) get a
  read-only pre-command snapshot: current branch, files already staged before
  the command, unstaged/untracked files, planned targets, unresolved
  shell-expanded paths, and a bounded numstat for changes that would be
  discarded. Snapshots use fixed non-interactive Git queries with locking and
  hooks disabled, a two-second timeout, and bounded output. **The repository is
  never modified.**

Only regular text files inside the working directory, the worktree, or
`/tmp/opencode` can be included. Missing, blocked, and truncated executable
stdin is explicitly identified so the reviewer fails safe.

The **only** deterministic SSH preflight rejection is an executable stdin file
that still does not exist after a 100 ms recheck — the primary agent gets an
actionable instruction to create it and retry. Every other SSH case (sensitive,
binary, blocked, or truncated evidence) remains a reviewer decision.

## Safety properties

- Responds only to `permission.asked`.
- **Critical-risk actions cannot be approved**, even if model output says
  `allow`.
- **High-risk actions with low or unknown authorization, and medium-risk
  actions with unknown authorization, are deterministically escalated** — the
  model cannot auto-approve them by labeling a contradictory combination.
- Invalid, low-confidence, or inconsistent output is escalated to the user.
- **Common credential formats are always redacted** from the evidence before
  reaching the reviewer, so credentials never leak to the reviewer's provider.
- Reviewer sessions cannot request permissions recursively; all reviewer tools
  are explicitly disabled.
- A narrow deterministic emergency brake rejects unmistakable root destruction
  (including privilege-prefixed and command-string forms such as
  `sudo rm -rf /`, `sh -c 'rm -rf /'`, `ssh host rm -rf /`) and direct
  credential-file export before any model call.
- A manual reply that arrives while a review is in flight **supersedes** it: the
  reviewer stops without replying or resurrecting a UI state.
- Approvals are silent to the primary agent (no tool-result annotation); denials
  return the rationale as feedback. Rationale remains in audit/TUI/debug.
- SSH commands and executable stdin receive bounded, untrusted action
  enrichment; enrichment never makes an approval decision on its own.
- Long-session user intent is recovered separately from recent operational
  context; later explicit requests supersede conflicting older ones.
- Synthetic compaction/control messages are excluded from authorization
  evidence.
- Audit failures never affect or relax the safety decision.
- UI status messages are versioned, request-scoped, bounded, and transported
  through OpenCode's own workspace TUI event channel.

## Supported versions

| Component             | Supported      | Notes                                                        |
| --------------------- | -------------- | ------------------------------------------------------------ |
| OpenCode              | `>=1.18.11 <2` | Declared in `engines.opencode`; verified with **1.18.15**    |
| `@opencode-ai/plugin` | `>=1.18.11 <2` | Peer dependency for the server transport                     |
| Bun                   | `>=1.3.0`      | Declared in `engines.bun`; CI runs **1.3.0** and **1.3.5**   |
| TUI overlay           | OpenCode V1    | Needs the host Solid/OpenTUI plugin pipeline (raw TSX entry) |
| OS                    | macOS / Linux  | On Windows, SSH/Git enrichment degrade to fail-safe manual   |

- **TUI overlay** ships as **raw TSX** (`dist/tui/tui.tsx`). The host compiles
  it against its embedded Solid/OpenTUI runtime. A prebundled TUI entry loads
  but never paints. The server half does not depend on the overlay.
- **Server half** replies through an isolated transport chosen once at startup:
  public SDK reply with feedback `message` → public reply plus a separate
  feedback channel → authenticated raw HTTP
  (`/permission/{requestID}/reply` via `input.client._client.post`) → **refuse
  startup**. On OpenCode 1.18.x the message-bearing reply is only reachable via
  the raw transport, so the chain resolves there. That raw field is **not part
  of OpenCode's public plugin API** and can change without notice. If startup
  fails with _"authenticated SDK transport is unavailable"_, file an issue
  rather than downgrading.
- OpenCode **v2-generation** hosts are detected at startup and refused until
  their reply contract is verified.
- Full enrichment assumes a Unix-like system (macOS/Linux). On Windows, SSH and
  Git enrichment degrade gracefully toward fail-safe manual review.
- **`retainReviewSessions`**: keep it `false` in normal use. Set `true` only to
  debug the known `json_schema` structured-output serialization bug in OpenCode
  1.18.11 — it keeps the child session on disk so you can inspect the malformed
  response; it does not fix the bug.
- Run `opencode-permission-reviewer doctor` to compare installed versions
  against the ranges above.

## Troubleshooting

| Symptom                                       | Likely cause                                                                                     | Fix                                                                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every `ask` escalates after a long wait       | Reviewer model not found / provider not configured                                               | Ensure the model's provider is set up in OpenCode and the `model` ID is valid in **both** config files                                                                                          |
| Plugin does nothing                           | No `ask` rule in your `permission` policy                                                        | Add e.g. `"bash": "ask"`                                                                                                                                                                        |
| TUI overlay never appears                     | Not in `tui.json`; mismatched `timeoutMs`; stale process; or host without Solid/OpenTUI pipeline | Register the same block in `tui.json` with matching `timeoutMs`. Overlay is raw TSX (`dist/tui/tui.tsx`); a prebundled `dist/tui.js` does not render. **Fully restart OpenCode** after rebuilds |
| Startup error: "authenticated SDK transport…" | OpenCode outside `>=1.18.11 <2`, or an SDK change that hides the raw transport                   | Upgrade OpenCode and `@opencode-ai/plugin` into the supported range; report the version in an issue                                                                                             |
| Startup error: "Detected an OpenCode v2…"     | OpenCode v2-generation host                                                                      | Run an OpenCode 1.18.x host (v2 is not supported yet)                                                                                                                                           |
| Reviews always time out                       | `timeoutMs` too low for the model                                                                | Raise `timeoutMs` (up to 600000)                                                                                                                                                                |
| `GIT_STATE_ANALYSIS` shows `spawn git ENOENT` | `git` not on `PATH`                                                                              | Install `git`; Git enrichment degrades safely until then                                                                                                                                        |
| Want a version check                          | Host/SDK outside the supported range                                                             | Run `opencode --version` and `opencode-permission-reviewer doctor`                                                                                                                              |
| Want to turn it off                           | —                                                                                                | Remove the plugin entry from both `opencode.json` and `tui.json`                                                                                                                                |

Enable `"debug": true` for verbose stderr logs while investigating. TUI load
errors (`[tui.plugin] …`) are printed on the **TUI process console**, not in
`~/.local/share/opencode/log/opencode.log`.

## Development

```bash
bun install
bun run check          # format + lint + typecheck + tests + build (must pass before any push)
bun run test:stress    # stress suite only
bun run test:package   # npm pack ship-set smoke (raw TUI + server bundle)
```

`bun run build` bundles the server/CLI with tsup, then copies the slim TUI
source graph into `dist/tui/` as raw TSX (`scripts/copy-tui.ts`). Do not add a
prebundled TUI entry — it will not render on the host.

The live end-to-end harness in `tests/live-harness.ts` runs against a real
OpenCode server + model and is **not** part of `bun test`; see
[`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Attribution

The reviewer policy and prompt text in `src/policy.ts` are adapted from
[OpenAI Codex Guardian](https://github.com/openai/codex/tree/main/codex-rs/core/src/guardian)
(Apache-2.0). See [`NOTICE`](./NOTICE) for full attribution and license details.

## License

[Apache License 2.0](./LICENSE) © 2026 Warc0s
