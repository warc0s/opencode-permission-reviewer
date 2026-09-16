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
tools to disabled, records the response, and deletes the session and temporary
directory. A host error requests a global stop. Use `--concurrency 1` and set
retry limits explicitly. `--max-calls` bounds host prompt attempts; OpenCode
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

For a full low-effort run, use one serial worker and independently sample a
random pause of 2-4 seconds between completed host prompts. The selected pause
is recorded as a `request-wait` event. This is a pacing control, not a guarantee
about subscription quotas or provider-side retries. Keep the same options and
source checkout for `--resume`; the delay range and request cap are included in
the run fingerprint.

```sh
bun cli.mjs run --repo ../.. \
  --models examples/models.opencode-v1.example.json \
  --out runs/grok-46-low-full --concurrency 1 \
  --min-request-delay-ms 2000 --max-request-delay-ms 4000 \
  --max-calls 600 \
  --http-retries 0 --format-retries 0
```

The run is complete only when all 600 results have been written and reviewed.
If it stops, inspect the run journal and account status before deciding whether
to resume. Never silently replace a missing or failed model decision with the
core's escalation. Raw run output stays ignored by Git.

The OpenCode transport is closer to the plugin's V1 reviewer host than direct
Chat Completions, but it is still a core replay, not a full pending-permission
cycle. Host prompts can add host-owned context, and this harness does not test
V2 sessions, cancellation races, real permission application, or native tool
result registration. Report the transport and output profile with every score;
do not merge them into a supposedly controlled comparison with direct calls.

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
