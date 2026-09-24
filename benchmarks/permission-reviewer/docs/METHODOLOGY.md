# Model evaluation protocol

This document records how PRB-600 evaluates reviewer models. It is a research
protocol, not a claim that a subscription permits unlimited automated traffic.
Check the provider's current terms and account usage before increasing volume.

## What is held constant

- The committed synthetic corpus has 600 requests in 140 related families.
  Paired variants stay in the same `dev`, `validation`, or public `holdout`
  partition. Reference labels are single-author drafts.
- The harness imports the pinned plugin source to build evidence and reviewer
  prompts, parse decisions, and apply the plugin's core gates. It never runs a
  fixture command or uses a case's reference label in the model prompt.
- Every case starts a fresh model conversation. The model output, reachable
  subset, and effective gated result are scored separately. Invalid outputs
  remain missing model decisions.
- Runs record corpus, source, harness, model, transport, output profile,
  variant, seed, and settings. A resumed run must match its fingerprint.

## OpenCode V1 subscription transport

`opencode-v1` sends prompts to the documented HTTP API of a real, locally
running OpenCode V1 server. OpenCode handles its own provider login and token
refresh. The benchmark never reads, copies, forwards, or stores OAuth tokens.
The host URL must be loopback HTTP; the benchmark does not impersonate
OpenCode in requests to model providers. Protect the local HTTP server with
OpenCode's `OPENCODE_SERVER_PASSWORD`. The benchmark reads only that temporary
local-server password from the named environment variable and sends HTTP Basic
authentication to loopback. It never handles the provider's OAuth credential.

For each attempt, the harness creates a private temporary directory and a new
OpenCode session, submits the plugin-generated system prompt and evidence,
selects the exact `provider/model` and named variant, sets all operational
tools to disabled, records the response, deletes the session, disposes the
directory-scoped OpenCode instance, and removes the temporary directory. A host
error or repeated instance-disposal failure requests a global stop. Use `--concurrency 1` by
default; at most three workers are supported when explicitly requested. With three
workers, two requests can already be in flight when the other fails. Set retry
limits explicitly. `--max-calls` bounds host prompt attempts; OpenCode
may perform provider-side retries that this counter cannot see.

Start OpenCode V1 from an otherwise empty workspace, on loopback, with external
plugins disabled. Keep your existing authenticated OpenCode data directory so
the host can use your subscription, but isolate its config, cache, state, and
workspace from the project under review. Do not copy authentication files into
the benchmark. Do not put the local-server password in the model JSON, shell
history, logs, or the repository.
Record the host version, model catalog, account plan, output profile, variant,
date, and relevant config for each public result. Inspect the host's behavior
with a tiny transport check before running a partition.

In a separate terminal, set `PRB_OPENCODE_SERVER_PASSWORD` to a fresh random
password from a trusted secret manager (or a hidden shell prompt), then start
the official V1 executable. Use the _same_ variable in the benchmark terminal.
Replace `/path/to/opencode-v1` with the installed V1 binary; do not assume an
unqualified `opencode` points to V1.

```sh
eval_dir="$(mktemp -d)"
mkdir -p "$eval_dir/config" "$eval_dir/cache" "$eval_dir/state" "$eval_dir/workspace"
cd "$eval_dir/workspace"
env -u OPENCODE_CONFIG -u OPENCODE_CONFIG_DIR \
  XDG_CONFIG_HOME="$eval_dir/config" XDG_CACHE_HOME="$eval_dir/cache" \
  XDG_STATE_HOME="$eval_dir/state" OPENCODE_CONFIG_CONTENT='{}' \
  OPENCODE_SERVER_PASSWORD="$PRB_OPENCODE_SERVER_PASSWORD" \
  /path/to/opencode-v1 serve --pure --hostname 127.0.0.1 --port 4096
```

Leave `XDG_DATA_HOME` and `HOME` at their normal values so OpenCode can use
its existing login and write its own session records. The temporary directory
contains only isolated host config/cache/state and can be removed after the
server exits. From `benchmarks/permission-reviewer`, with the server running:

```sh
OPENCODE_V1_BIN=/path/to/opencode-v1 node tests/live-opencode-v1.mjs
bun cli.mjs run --repo ../.. \
  --models examples/models.opencode-v1.example.json \
  --limit 1 --out runs/grok-low-pilot-one --concurrency 1 \
  --max-calls 1 --http-retries 0 --format-retries 0 --bootstrap 0
```

The first command starts its own isolated V1 host with a synthetic provider;
it makes no subscription model calls. The second sends exactly one synthetic
case through the authenticated host. The example config uses port 4096 and the
`PRB_OPENCODE_SERVER_PASSWORD` environment variable; change the port in the
ignored `models.local.json` if necessary. Check the host version and configured
model before sending model prompts. Stop the host when finished.

The one-case pilot checks transport and serialization only. `--limit` selects
the beginning of the corpus, not a representative sample; never report its
score as a model ranking. Advance by complete partitions only after reviewing
the pilot and account usage. Stop on 401/403, 429, missing variants, anomalous
model IDs, tools, or other host errors; do not rotate credentials or bypass
limits. Do not run `medium` or additional models merely because `low` works.

For a deliberately paced serial run, use one worker and independently sample a
random pause of 2-4 seconds between completed host prompts. The selected pause
is recorded as a `request-wait` event. This was used for the initial Grok
low-effort evaluation; it is a pacing control, not a guarantee about
subscription quotas or provider-side retries. Keep the same options and source
checkout for `--resume`; the delay range and request cap are included in the
run fingerprint.

```sh
bun cli.mjs run --repo ../.. \
  --models examples/models.opencode-v1.example.json \
  --out runs/grok-46-low-full --concurrency 1 \
  --min-request-delay-ms 2000 --max-request-delay-ms 4000 \
  --max-calls 600 \
  --http-retries 0 --format-retries 0
```

For an explicitly requested two-worker run, keep a single protected OpenCode
host, use two independent sessions, and disable benchmark pacing. The host may
have two prompts in flight. The benchmark still records each attempt and stops
new work on a transport error. Do not interpret the request cap as a billing
or subscription-usage cap.

```sh
bun cli.mjs run --repo ../.. --models models.local.json \
  --out runs/model-medium --concurrency 2 --max-calls 600 \
  --min-request-delay-ms 0 --max-request-delay-ms 0 \
  --http-retries 0 --format-retries 0
```

The run is complete only when all 600 results have been written and reviewed.
If it stops, inspect the run journal and account status before deciding whether
to resume. Never silently replace a missing or failed model decision with the
core's escalation. Raw run output stays ignored by Git.

`attempt.latencyMs` measures OpenCode session creation and the model response.
It excludes the pause before the request and the subsequent session cleanup.
`row.elapsedMs` and the operational `totalTimeMs` include pacing and must not
be presented as model latency. Published latency is host-transport latency,
not isolated provider inference time.

Changing pacing or concurrency changes the run fingerprint. Record a new
segment instead of silently resuming with different settings. If a selected
subset is used to avoid repeating completed cases, keep the original case
contents, labels, and dependency pairs intact. To consolidate segments,
require matching plugin source, harness, model, variant, and output profile;
verify every case hash against the full corpus and every duplicated prompt and
evidence hash. Select the first non-transport response per case, whether valid
or invalid. Never replace an invalid output with a more favorable duplicate.
Retain repeated controls, timeouts, and interrupted attempts separately in
provenance. A transport error is never a successful escalation or a substitute
for a model decision.

The OpenCode transport is closer to the plugin's V1 reviewer host than direct
Chat Completions, but it is still a core replay, not a full pending-permission
cycle. Host prompts can add host-owned context, and this harness does not test
V2 sessions, cancellation races, real permission application, or native tool
result registration. Report the transport and output profile with every score;
do not merge them into a supposedly controlled comparison with direct calls.

## Command Code subscription transport

`command-code-cli` invokes the official Command Code CLI in headless mode with
the user's existing CLI login. It does not use Command Code's separately billed
Provider API, copy authentication files, or send a subscription token through
the benchmark. Set `commandCodeBinEnv` in the ignored model config to the name
of an environment variable containing the CLI binary path; never store a
personal path in a tracked config.

Each request starts a fresh CLI process in an empty temporary workspace with
no saved session, no skills, one model turn, and a non-interactive permission
mode. The benchmark sends the plugin-generated policy and evidence through
stdin, checks the returned model, rejects any tool event, and parses only the
final answer. Nonzero exit codes, quota errors, timeouts, and tool attempts
stop the run. The CLI's own system prompt is still present: it cannot accept
the plugin policy as a separate system message, so the benchmark folds policy
and evidence into one user message with explicit boundaries. This is a
different prompt profile from OpenCode V1 even when the synthetic cases and
plugin-produced text match. Its scores can be reported alongside OpenCode
scores with that caveat, but not as a controlled head-to-head comparison.

The CLI's token usage includes its own instructions; its latency includes
process startup. The subscription's usage limits still apply, and two workers
are the maximum supported by this transport. Use a one-case pilot to verify
the model and effort before a full run, and keep format retries disabled when
comparing first-shot decision quality.

## Jev System One transport

`system-one` sends the plugin's trusted policy and untrusted evidence as typed
state with a fixed set of choice and probability questions. It uses the small
official TypeSafe AI SDK and never creates a chat session or exposes tools. The
model configuration must use `format: "system_one"`, a Jev model ID, an HTTPS
API root, and an environment-variable name for the credential. Variants and
chat completion parameters are rejected because this API has no reasoning
effort control.

The runtime and benchmark share the same response parser and deterministic
reconciliation rules. A complete typed response may still be marked difficult
when its confidence is below the risk-specific floor, its signals conflict, or
it explicitly requests escalation. The pure benchmark records that classification
but does not call the optional runtime reasoning reviewer. Follow-up Luna runs
must therefore use a separately selected difficult-case subset and retain the
parent Jev run as provenance.

Use `--difficult-from runs/jev-private` for those follow-up runs. The selector
requires one complete System One model with one repeat, rejects transport-failed
rows, verifies the corpus and plugin source, and records the parent fingerprint
plus a hash of the selected case IDs. Run medium and high as separate immutable
outputs with the same two-worker and retry settings. This measures the hybrid
route without spending reasoning calls on decisions Jev already handled.

Use no more than two workers and set `--format-retries 0`. The SDK performs no
hidden retries in the benchmark; `--http-retries` is the only transport retry
control. Start with one case, verify the returned model and usage, then run the
complete corpus. Keep the model file ignored if it contains account-specific
details, even though the credential itself is only read from the environment.

System One evaluations are private. Raw runs, derived subsets, comparisons, and
scores must remain local and uncommitted. The harness rejects `export-public`
for any run containing a System One transport or format, so it cannot be added
to the public results table through the normal publication path.

## Logs, quotas, and publication

Raw `runs/` records contain prompts, evidence, model responses, host session
IDs, and provider usage. They are local and ignored by Git. OpenCode may retain
its own logs according to the user's host settings; this benchmark does not
capture other users' conversations. The public export omits prompts, raw
responses, rationales, endpoints, and credential references, and still needs
manual review before publication.

Subscription usage limits are separate from the benchmark's request cap. A
single large run can exhaust a weekly pool or trigger rate limits even at low
concurrency. The published results table must distinguish a pilot from a
complete run, state failures and excluded cases, and link the exact corpus and
harness revision. Scores from this synthetic corpus are evidence for candidate
selection, not a certification of production safety.
