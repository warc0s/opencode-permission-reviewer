# OpenCode Permission Reviewer

> [!NOTE]
> This is an **unofficial community plugin** for OpenCode. It is not affiliated
> with or endorsed by [Anomaly](https://anoma.ly).

> **A tool-free AI reviewer for every `ask` permission.** It reads the request,
> your policy, and the session context, then **allows, denies with
> feedback, or escalates to you** — so safe actions don't wait for a keystroke,
> and genuinely risky ones still get blocked or surfaced.

[![OpenCode](https://img.shields.io/badge/OpenCode-%E2%89%A51.18.29-6E56CF)](https://opencode.ai)
[![Bun](https://img.shields.io/badge/Bun-%E2%89%A51.3.0-000000)](https://bun.sh)
[![npm](https://img.shields.io/npm/v/opencode-permission-reviewer?color=CB3837)](https://www.npmjs.com/package/opencode-permission-reviewer)
[![Downloads](https://img.shields.io/npm/dw/opencode-permission-reviewer)](https://www.npmjs.org/package/opencode-permission-reviewer)
[![License](https://img.shields.io/github/license/Warc0s/opencode-permission-reviewer?color=blue)](./LICENSE)
[![Checks](https://img.shields.io/github/actions/workflow/status/Warc0s/opencode-permission-reviewer/ci.yml?branch=main&label=checks)](https://github.com/Warc0s/opencode-permission-reviewer/actions/workflows/ci.yml)
[![Open issues](https://img.shields.io/github/issues/Warc0s/opencode-permission-reviewer?color=555)](https://github.com/Warc0s/opencode-permission-reviewer/issues)

OpenCode pauses on **every** `ask` permission and waits for a keystroke — even
for safe, routine actions. This plugin adds a Codex-Guardian-style reviewer: a
dedicated, tool-free model session reads the pending request, bounded
transcript evidence, recovered user intent, and **a tenant policy you control**,
then allows, denies with rationale, or escalates to you.
Actions the reviewer classifies as critical are not auto-approved. Failures do
not become new approvals: they lead to manual review or denial, depending on
the host and configuration.

- **Preserves your policy** — `allow` continues, `deny` stays blocked; neither
  ever reaches the reviewer.
- **Isolated, tool-free reviewer session** — the reviewer runs in a scratch
  directory outside your project (no `AGENTS.md`, project instructions, or
  project MCP servers) with every tool denied through a wildcard session
  permission rule, so it can neither call tools (MCP included) nor request
  permissions recursively.
- **Read-only enrichment** — bounded, sanitized SSH / local-script / Git
  evidence for the reviewer; the filesystem is never modified.
- **Auditable** — one JSONL record per review, with remote commands stored as
  SHA-256, not plaintext.
- **Optional TUI overlay** — shows review state and gets out of the way of your
  native approval controls.

> **Policy design inspired by [OpenAI Codex Guardian](https://github.com/openai/codex/tree/main/codex-rs/core/src/guardian).**
> The wording and implementation are independent. See [`NOTICE`](./NOTICE).

---

## Quickstart

### Requirements

- [Bun](https://bun.sh) ≥ 1.3.0 (CI runs 1.3.0 and 1.3.5)
- [OpenCode](https://opencode.ai) V1 `>=1.18.29 <2` (**tested with 1.18.31**), or V2 `2.0.3` (**tested with 2.0.3**)
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

The CLI can register the plugin for you (`--tui` writes V1 `tui.json` or V2 global `cli.json`;
`--npm` emits an npm package name instead of a path; it never clobbers an
existing entry):

```bash
bunx opencode-permission-reviewer init --host auto --npm --tui --yes
```

### Configure OpenCode V1

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

### Configure OpenCode V2

V2 uses `plugins` with object entries. The same package supplies `setup()` for
the server and a separate TUI adapter. Use `--host v2` to select this format:

```bash
bunx opencode-permission-reviewer init --host v2 --npm --tui --yes
```

```jsonc
// opencode.json
{
  "plugins": [{ "package": "opencode-permission-reviewer", "options": {} }],
  "permissions": [{ "action": "shell", "resource": "*", "effect": "ask" }],
}
```

The optional interface belongs in the global `cli.json`, not a project
`tui.json`. The installer writes the correct destination. Reviewer settings
belong in the trusted global `permission-reviewer.jsonc`; V2 inline options
of unknown provenance can only tighten security restrictions. The TUI reads
effective settings and review status from the server.

V2 uses the official authenticated client to manage isolated reviewer sessions.
The registered service is discovered without starting or stopping it. For an
independent `serve`, configure `OPENCODE_PERMISSION_REVIEWER_HOST_URL` and the
host's `OPENCODE_PASSWORD` in the trusted process environment. An identity check
rejects connections to a different plugin instance. Provider credentials stay
inside OpenCode. See [Migration and rollback](./MIGRATION.md).

Structured output uses a dedicated schema-validated result tool. All operational
tools remain disabled. `retainReviewSessions: false` removes the auxiliary
session; `true` keeps it for inspection. `reviewBudgetMs` bounds the whole
review; by default it is `2 * timeoutMs + 60000`. Retries consume this budget.

## Choosing the reviewer model

The reviewer is a normal OpenCode model invocation (every tool denied at the
session-permission level), so it can be **any model from any provider you have
configured**. In V1, keep shared options identical in `opencode.json` and
`tui.json` when using the overlay. In V2, configure reviewer settings in the
trusted global `permission-reviewer.jsonc`; the TUI reads them from the server.
The model options are:

- **`model`** — in `provider/model` form. Must match a configured provider and
  a model that provider exposes.
- **`variant`** — reasoning effort the model supports (`max`, `high`, `medium`,
  `low`, `none`). Passed straight through to OpenCode.
- **`outputFormat`** — how the reviewer returns its decision: `json_schema`
  (default; uses OpenCode's structured output, needs provider support) or
  `text` (ask the model to emit JSON in plain text and parse it locally). Use
  `text` for models that reject the `json_schema` format, e.g.
  `opencode-go/deepseek-v4-flash`.
- **`timeoutMs`**: review timeout; match it across the V1 config files.

The default reviewer is **`openai/gpt-5.6-luna`** (`max` reasoning) — a real
model that follows JSON schemas well. Override `model` to use any other
provider/model you have configured; whichever you pick should follow structured
output reliably. Model mistakes can cause unsupported approvals as well as
unnecessary escalations, so compare both safety errors and format validity.
Higher reasoning variants may cost more or take longer without always improving
the result.

### Reviewer models without structured-output support

Some models (for example `opencode-go/deepseek-v4-flash`) do not support
OpenCode's `json_schema` structured-output format and fail with a format error
when it is requested. For those, set `"outputFormat": "text"` so the reviewer
asks the model to emit its decision as plain JSON and parses it locally. For V1
with the optional overlay, set this option identically in `opencode.json` and
`tui.json`. For V2, set it in the trusted global `permission-reviewer.jsonc`:

```jsonc
{
  "model": "opencode-go/deepseek-v4-flash",
  "variant": "high",
  "outputFormat": "text",
  "timeoutMs": 120000,
}
```

Text mode has no host-side schema enforcement: the plugin re-prompts the
reviewer once if the response is unparseable (mirroring the auto-retry that
`json_schema` mode gets from OpenCode). A response that is still invalid is not
auto-approved; it escalates or is denied according to `escalationMode`. Parsing
is deliberately strict and fail-closed: the entire response must be exactly one
JSON object (optionally wrapped in a single Markdown code fence). Prose around
the object, multiple objects, multiple fences, or any other ambiguity prevents
automatic approval: the parser never guesses which candidate the model meant. Every
parsed decision still passes the same strict `parseDecision` validation and
`enforceDecision` invariants (model-classified critical risk is not approved,
etc.), so text
mode cannot approve anything that structured mode would not.

One caveat applies to any output format: the deterministic gates check the
decision's _consistency_, not its semantic correctness. A reviewer model that
misclassifies an unsafe action as low risk can produce an unsafe `allow` in
either mode, so pick as strong a reviewer model as your budget allows.

### All configuration options

Every option is optional. Numeric/string options are clamped to safe bounds.

| Option                 | Default                                                   | Bounds / type                       | Description                                                                                   |
| ---------------------- | --------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `model`                | `openai/gpt-5.6-luna`                                     | `provider/model`                    | Reviewer model (override with any provider/model)                                             |
| `variant`              | `max`                                                     | non-empty string                    | Reasoning variant passed to OpenCode                                                          |
| `outputFormat`         | `json_schema`                                             | `json_schema` / `text`              | How the reviewer returns its decision (`text` for models without structured output)           |
| `timeoutMs`            | `120000`                                                  | `5000`–`600000`                     | Review timeout (match across V1 config files)                                                 |
| `confidenceThreshold`  | `0.7`                                                     | `0.5`–`1`                           | Minimum confidence to auto-act; below it escalates                                            |
| `maxContextChars`      | `32000`                                                   | `4000`–`200000`                     | Total transcript evidence budget                                                              |
| `maxPartChars`         | `8000`                                                    | `500`–`50000`                       | Per-message-part budget                                                                       |
| `maxEnrichmentChars`   | `24000`                                                   | `1000`–`100000`                     | SSH / script / Git enrichment budget                                                          |
| `maxIntentChars`       | `8000`                                                    | `1000`–`50000`                      | User-intent history budget                                                                    |
| `transcriptMessages`   | `12`                                                      | `1`–`100`                           | Recent messages shown to the reviewer                                                         |
| `intentMessages`       | `8`                                                       | `1`–`50`                            | Genuine user intents kept                                                                     |
| `historyMessages`      | `200`                                                     | `20`–`500`                          | Messages fetched to recover intent                                                            |
| `retainReviewSessions` | `false`                                                   | boolean                             | Keep reviewer child sessions (debug only; see below)                                          |
| `audit`                | `true`                                                    | boolean                             | Append one JSONL audit record per review                                                      |
| `auditPath`            | `~/.local/share/opencode/permission-reviewer-audit.jsonl` | path                                | Audit file location                                                                           |
| `policy`               | built-in default                                          | string                              | Full local override of the tenant policy text                                                 |
| `debug`                | `false`                                                   | boolean                             | Verbose logs to stderr                                                                        |
| `enforcementMode`      | `observe`                                                 | `observe` / `enforce`               | `enforce` applies declarative policy routes; `observe` audits them only                       |
| `escalationMode`       | `manual`                                                  | `manual` / `deny`                   | How final escalations are disposed (`manual` = human; `deny` = fail-closed reject)            |
| `maxSessionDepth`      | `8`                                                       | `1`–`32`                            | Parent-session lineage walk depth                                                             |
| `maxParentSessions`    | `8`                                                       | `0`–`32`                            | Max parent sessions resolved for actor context                                                |
| `actorProfiles`        | `{}`                                                      | name → profile map                  | Trusted agent name → profile (`read-only`, `validation`, `workspace`, …)                      |
| `riskPolicy`           | built-in conservative matrix                              | object                              | Override `allow` cells per risk level and failure modes (`onInvalidDecision`, …)              |
| `repositoryTrust`      | `unknown`                                                 | `trusted` / `untrusted` / `unknown` | Repository trust level used by the policy engine                                              |
| `policyRules`          | `[]`                                                      | array                               | Declarative rules (most-restrictive wins); project rules combine with trusted ones            |
| `askDecisions`         | `true`                                                    | boolean                             | Show the reviewer what the user answered in agent ask dialogs (scoped authorization evidence) |

Config is layered: built-in defaults ← global
`~/.config/opencode/permission-reviewer.jsonc` ← project
`.opencode/permission-reviewer.jsonc` ← inline plugin options (later wins).
The project layer crosses a trust boundary: it can only **tighten**
security-sensitive fields, and its hardening survives even when a trusted layer
set the same field. The project layer cannot choose the reviewer `model` or
replace the `policy` text (both decide where code/context travels and what the
reviewer enforces), cannot redirect `auditPath`, grant `actorProfiles`, set
`repositoryTrust: "trusted"`, downgrade a global `enforcementMode: "enforce"`,
or relax a trusted `escalationMode: "deny"` / failure-mode deny knob /
`confidenceThreshold` / `riskPolicy`. Project values of the wrong type
(including `null`) are ignored, never normalized back to defaults.

A config file that exists but cannot be honored fails CLOSED on the trusted
side: a malformed or unreadable **global** config, or trusted `policyRules`
dropped by validation, marks the run _degraded_ — reviews still run, but
automatic approval stays off (everything escalates) until the file is fixed,
and the degradation is reported on stderr. A malformed **project** file is
reported and ignored (the untrusted layer adds nothing anyway).

In declarative `policyRules`, a `when` condition with an unknown key (a typo),
a `false` flag, or an empty object drops the whole rule — a mistyped rule must
never degrade into a universal match. Catch-all rules are spelled explicitly:
omit `when` entirely, or use `"when": { "always": true }` (valid only alone).
When a catch-all comes from the trusted global config it simply matches
everything; project-sourced allow rules are still rejected outright.

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
the audit path with mode `0600` (`schemaVersion: 3`): outcome, decision source,
rationale, risk, authorization, confidence, per-phase latency, reviewer model,
optional `reviewerOutcome` / `escalationDisposition` (to distinguish an explicit
deny from fail-closed escalate→deny), and a bounded SSH summary. Remote commands
are stored as **SHA-256**, never in clear text. Set `audit: false` to disable.

## What you'll see

```text
✓ Review approved · bash · rm -rf /tmp/scratch-cache
Narrowly scoped temp cleanup; matches user intent.
```

While reviewing on V2, the optional TUI shows a compact two-line status strip
at the bottom, matching the result strip's placement. It includes an animated
indicator, **Reviewing this permission**, the reviewer model and reasoning
variant, elapsed time, and the action. Long commands are truncated instead of
expanding over the conversation. V1 retains its larger overlay covering the
native approval controls, including **No action needed**.

Once resolved, both hosts show a compact status strip: one line for the result
and a second for its rationale, with long text truncated. The review keymap is
released immediately; the result stays visible for 5 s. Editor availability
during a pending review depends on the host; the V2 strip is not a keyboard
lock. On a final escalation in interactive mode, the overlay is removed and
OpenCode's native approval controls become available with a **manual review
required** warning. Host interruption, event-stream loss, and fail-closed
settings can instead deny the request. A broken TUI
transport **never changes the safety decision**.

## How it works

1. OpenCode V1 emits `permission.asked` for an `ask`-classified action. V2 calls
   the `permission.evaluate` hook; the plugin preserves decisions already made
   by the host or other plugins and reviews only requests that remain `ask`.
2. A deterministic **emergency brake** rejects unmistakable root destruction and
   direct credential export before any model call. It is wrapper-aware
   (`sudo`, `doas`, `env`, `command`, `nice`, `nohup`, …), so `sudo rm -rf /`,
   `env VAR=x rm -rf /`, `/bin/rm -rf /`, `sh -c 'rm -rf /'`, `ssh host rm -rf /`,
   and `busybox rm -rf /` are all caught.
3. The plugin builds bounded **evidence**: recent transcript, recovered user
   intent, and optional read-only enrichment for SSH commands, local
   interpreter scripts, and Git state. Intent attribution uses a single origin
   rule: synthetic/host-flagged parts are never human intent, and in a
   delegated (subagent) session **no** user-role message counts as human
   authorization — the initial briefing and every later `task_id` follow-up
   are agent-authored and surface only as labeled delegation context.
   Recognized common credential formats are redacted from this evidence
   (`Bearer`, AWS / GitHub / OpenAI / Anthropic / Slack / Google / Stripe /
   GitLab keys, JWTs, private keys, URL userinfo, cookies, and
   credential-bearing assignments). Redaction reduces exposure but cannot
   prove that every secret format has been detected.
4. An **isolated, tool-free reviewer session** runs the reviewer model with
   schema-validated output or strict text parsing and returns
   `{ outcome, risk_level, user_authorization,
rationale, confidence }`. The session is created in a scratch directory
   outside your project so the host does not prepend repository instructions
   (`AGENTS.md`, project config `instructions`, project MCP context) to the
   reviewer's system prompt — only your trusted global instructions remain.
   Tool denial is a wildcard session permission rule, which takes precedence
   over agent-config allows and therefore also covers MCP tools and MCP
   resource tools. If the host refuses the isolated directory, the review is
   not run in the project directory: the failure cannot auto-approve the
   request, so isolation is never silently degraded.
5. Decisions are enforced with invariants: **risk classified as critical by the
   reviewer is not auto-approved**,
   **high risk with low/unknown authorization is escalated**, **medium risk
   with unknown authorization is escalated**, low confidence is escalated,
   invalid output is escalated, and reviewer errors and timeouts cannot become
   approvals. Two
   deterministic blocks also apply regardless of model confidence: a degraded
   trusted config (see above) and evidence where a material part of the action
   itself was elided or truncated — neither can auto-approve. A single
   enforcement boundary then disposes every internal `escalate` according to
   `escalationMode` (`manual` → human; `deny` → reject with the original reason).
   V2 also denies requests invalidated by cancellation, review deadline, or
   loss of the host event connection.
6. V1 approvals reply `once` (never `always`); V2 approvals return `allow` from
   the evaluation hook. Both continue **silently** if the host applies the
   decision: the
   tool output is not annotated, so approval rationale never contaminates the
   primary agent context (rationale still lands in audit, TUI, and debug logs).
   Denials return a short actionable rationale as tool feedback. A manual reply
   that arrives mid-review **supersedes** the automatic one (no double reply).

By default final reviewer escalations go to **manual review**. With
`escalationMode: "deny"`, they become rejections with reasons instead. V2 host
interruptions and event-stream failures can deny directly in either mode.

## Evidence enrichment

The reviewer never sees the raw filesystem — only bounded, sanitized evidence.
Enrichment is deliberately conservative and **never makes an approval decision
by itself** (one narrow deterministic exception exists for SSH, below).

- **SSH commands** are parsed into destination, options, remote command,
  environment/mutation/secret/stdin signals, and bounded stdin content for the
  common `cat script | ssh ... python -` pattern. Sensitive paths,
  credential-like literal content, binary files, unresolved shell expressions,
  and symlinks escaping approved roots are excluded.
- **Verified remote shell scripts** have an opt-in command form. Stage the exact
  script locally inside the workspace or `/tmp/opencode`, then generate the
  command rather than hand-writing its hash guard:

  ```bash
  bunx opencode-permission-reviewer script command --file /tmp/opencode/deploy.sh --host deploy.example
  ```

  Ask the agent to execute the printed command. It streams that local file to
  the host, checks its SHA-256 there **before** running `bash`, and removes the
  remote temporary copy. Add `--port 2222` or `--shell sh` when needed. The
  supported command is deliberately exact: extra shell actions, dynamic paths,
  or a remote-only script are **not** treated as verified. The local source is
  a copy of the intended executable bytes; if the script comes from Git, stage
  the blob from a pinned commit locally before generating the command. It is
  re-read on each review and must remain regular, text-only, secret-free, and
  at most 64 KiB. A changed file fails the remote hash check even if it changes
  after permission approval. The plugin never connects to the host to inspect
  it.

  The first permission review includes the whole script. If that review is
  approved with sufficient evidence and a script analysis, later reviews in
  the same conversation can reuse only a compact, in-memory analysis for the
  same hash, host, interpreter, and configuration (up to one hour). **Each
  command still receives a fresh authorization decision.** A different script,
  host, configuration, or expired analysis requires full inspection again. The
  audit stores the hash and inspection status, never the script body. When an
  opaque or truncated SSH script is rejected, the agent receives guidance to
  stage a local copy and generate this form. The CLI and plugin must use the
  same installed package version.

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
  never modified.** Repository-configured conversion filters (`clean`,
  `smudge`, `process`) and diff `textconv` drivers are enumerated before every
  snapshot and neutralized with config overrides (including dotted names); if
  the configuration cannot be fully verified — too many filters, or the config
  scan itself fails — the snapshot is withheld rather than risk executing
  repository-configured commands. Verification and inspection are still two
  distinct moments: a filter configured between them is a residual race the
  snapshot does not claim to eliminate.

Only regular text files inside the working directory, the worktree, or
`/tmp/opencode` can be included. Missing, blocked, and truncated executable
stdin is explicitly identified so the reviewer fails safe.

The **only** deterministic SSH preflight rejection is an executable stdin file
that still does not exist after a 100 ms recheck — the primary agent gets an
actionable instruction to create it and retry. Every other SSH case (sensitive,
binary, blocked, or truncated evidence) remains a reviewer decision.

## Safety properties

- Reviews only `ask` requests: V1 handles `permission.asked`, while V2 handles
  `permission.evaluate` without replacing an existing host decision.
- **A decision the model labels critical cannot be auto-approved**, even if its
  outcome says `allow`. This does not guarantee that every dangerous action is
  classified correctly by the model.
- **High-risk actions with low or unknown authorization, and medium-risk
  actions with unknown authorization, are deterministically escalated** — the
  model cannot auto-approve them by labeling a contradictory combination.
- Invalid, low-confidence, or inconsistent output cannot create an approval.
  Final escalations reach the user or are denied according to `escalationMode`;
  some V2 host failures deny directly.
- Known common credential formats are redacted from reviewer evidence. Redaction
  is defense in depth, not a guarantee that every possible secret is detected.
- Reviewer sessions cannot request permissions recursively; every tool is
  denied by a wildcard session permission rule that also covers MCP tools and
  takes precedence over agent-config allows.
- The reviewer session runs outside the project directory, so repository
  instructions (`AGENTS.md` and project-config `instructions`) are not part of
  its system prompt; if the isolated directory cannot be established, the
  review cannot auto-approve rather than running with degraded isolation.
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

| Component             | Supported          | Notes                                                      |
| --------------------- | ------------------ | ---------------------------------------------------------- |
| OpenCode V1           | `>=1.18.29 <2`     | Dual object entrypoint; verified with **1.18.31**          |
| OpenCode V2           | `2.0.3`            | Pinned contracts; verified with **2.0.3**                  |
| `@opencode-ai/plugin` | `>=1.18.29 <2`     | Optional V1 peer dependency                                |
| Bun                   | `>=1.3.0`          | Declared in `engines.bun`; CI runs **1.3.0** and **1.3.5** |
| TUI overlay           | OpenCode V1 and V2 | Separate host adapters, shared raw TSX presentation        |
| OS                    | Linux (verified)   | Other operating systems require equivalent live validation |

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
- V2 evaluates pending permissions through `permission.evaluate`. `shell`
  and `subagent` map to the shared internal `bash` and `task` labels. Input
  already marked allow or deny is not elevated or reviewed.
- Full enrichment assumes a Unix-like system (macOS/Linux). On Windows, SSH and
  Git enrichment degrade gracefully toward fail-safe manual review.
- **`retainReviewSessions`**: keep it `false` in normal use. Set `true` to retain
  isolated reviewer sessions for inspection in either host generation.
- Run `opencode-permission-reviewer doctor` to compare installed versions
  against the ranges above.
- A standard OpenCode installation invokes its runtime directly. Custom
  profile launchers are also supported when they select a supported runtime
  and provide coherent config, data, state, and cache locations. For the
  isolated compatibility matrix, point the host variables at the underlying
  executable instead of a launcher that overrides the harness environment;
  see [`tests/compatibility`](./tests/compatibility/README.md).

## Troubleshooting

| Symptom                                       | Likely cause                                                                      | Fix                                                                                                                                                                         |
| --------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every `ask` escalates after a long wait       | Reviewer model not found / provider not configured                                | Check the model ID in V1's `opencode.json` (and `tui.json` if used), or V2's trusted global `permission-reviewer.jsonc`                                                     |
| Plugin does nothing                           | No `ask` rule in the host permission policy                                       | Set a V1 `"bash": "ask"` rule or a V2 shell permission with `effect: "ask"`                                                                                                 |
| TUI overlay never appears                     | Wrong TUI config; stale process; or host without Solid/OpenTUI pipeline           | Check V1 `tui.json` or V2 global `cli.json`. The overlay is raw TSX (`dist/tui/tui.tsx`); a prebundled `dist/tui.js` does not render. Fully restart OpenCode after rebuilds |
| Startup error: "authenticated SDK transport…" | OpenCode V1 outside `>=1.18.29 <2`, or an SDK change that hides the raw transport | Upgrade OpenCode and `@opencode-ai/plugin` into the supported range; report the version in an issue                                                                         |
| Reviewer host connection unavailable          | Independent V2 server without a registered endpoint                               | Configure the trusted server URL and authentication, then restart                                                                                                           |
| Reviews always time out                       | `timeoutMs` too low for the model                                                 | Raise `timeoutMs` (up to 600000)                                                                                                                                            |
| `GIT_STATE_ANALYSIS` shows `spawn git ENOENT` | `git` not on `PATH`                                                               | Install `git`; Git enrichment degrades safely until then                                                                                                                    |
| Want a version check                          | Host/SDK outside the supported range                                              | Run `opencode --version` and `opencode-permission-reviewer doctor`                                                                                                          |
| Want to turn it off                           | -                                                                                 | Remove the plugin from the host config and, if installed, V1 `tui.json` or V2 global `cli.json`                                                                             |

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

The [synthetic model benchmark](./benchmarks/permission-reviewer/README.md)
evaluates 600 permission-review cases against the current reviewer prompt and
core. It is a separate development tool, not part of the npm package or plugin
runtime. It does not collect OpenCode conversations or execute fixture actions.
See its [evaluation protocol](./benchmarks/permission-reviewer/docs/METHODOLOGY.md)
and [results table](./benchmarks/permission-reviewer/RESULTS.md).

## Attribution

The reviewer policy design is inspired by
[OpenAI Codex Guardian](https://github.com/openai/codex/tree/main/codex-rs/core/src/guardian).
The wording and implementation are independent. See [`NOTICE`](./NOTICE) for
full attribution and license details.

## License

[Apache License 2.0](./LICENSE) © 2026 Warc0s
