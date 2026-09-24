# PRB-600: permission reviewer model benchmark

PRB-600 is a development-only benchmark for the OpenCode Permission Reviewer.
It contains 600 synthetic permission requests in 140 related families and 19
categories. It imports the plugin's actual prompt, evidence renderer, decision
parser, capability analyzer, and review core. It is not installed with the npm
package and does not change plugin behavior.

The benchmark never executes fixture commands. It has no real-conversation
capture, log import, telemetry, or replay feature. `run` contacts only the
configured provider endpoint, local OpenCode host, or official Command Code
CLI. A private System One profile can call Jev with an explicitly named API-key
environment variable. The direct provider transport does not reuse OpenCode credentials. The
optional `opencode-v1` transport delegates authentication to an official
OpenCode V1 server; the benchmark never handles OAuth tokens. The optional
`command-code-cli` transport uses the CLI's existing login, not its separately
billed Provider API. See the [evaluation protocol](./docs/METHODOLOGY.md)
before using a subscription and the [results table](./RESULTS.md) for published
evaluations. Local model results are kept in a [separate table](./RESULTS_LOCAL.md).
System One runs are private and the harness refuses to export them.

## Validate without model calls

From this directory, with Node 22+ and Bun 1.3+ installed:

```sh
node cli.mjs validate
node --test tests/*.test.mjs
bun tests/plugin-parity.mjs --repo ../..
```

The parity test exercises all 600 cases and three decision outcomes per case
against the pinned plugin source. It verifies construction and core behavior,
not whether the synthetic reference labels are correct.

## Configure and run

Copy an example model configuration to `models.local.json` and replace its
placeholders. Use the exact model identifier served by a Chat Completions
compatible endpoint. Remote credentials must be supplied through the named
`apiKeyEnv` environment variable, never embedded in the JSON or URL. For local
models, start the server separately. Chat profiles are `text`, `json_schema`,
and `tool`; provider-specific reasoning settings belong in `parameters` and are
not inferred from an OpenCode variant. Jev uses the separate `system_one`
profile and accepts no reasoning variant or chat parameters.

For a local Chat Completions server, start with `json_schema` and check a long
case for context compatibility. Compare its decisions with `text` on the same
pilot cases before a full run: a profile can improve JSON validity while hurting
decision quality. If the server rejects the schema or the model performs worse
with it, use `text` in a separate run and state the fallback in the result. A
value outside the schema's allowed range is invalid just like malformed JSON.
Set `--format-retries 1` for one corrective attempt, and report first-attempt
and final validity separately.

For a local Granite 4.2 8B text run, `graniteThinkingMode` can be `off`, `low`,
or `full`. It applies the model's documented assistant prefill or low-effort
user marker when the local server does not expose reasoning controls. This is a
prompt-level profile, not a native API effort setting; verify the server's
reasoning-token counts before scoring each mode. It is restricted to the local
Chat Completions text transport.

```sh
cp examples/models.local.example.json models.local.json
bun cli.mjs render --repo ../.. --models models.local.json --out runs/render
bun cli.mjs run --repo ../.. --models models.local.json \
  --split dev --out runs/dev --max-calls 1200
node cli.mjs score --run runs/dev
node cli.mjs audit --run runs/dev --out reviews/dev.jsonl --sample 40
```

`render` makes no network calls. With direct transport, `--max-calls` bounds
HTTP requests; with `opencode-v1` or `command-code-cli`, it bounds host prompts,
not any internal provider retries. Neither is a cost or subscription-usage cap.
Start with a small
transport check, inspect failures, then evaluate complete partitions with the
same settings for each model. `--resume` requires an identical dataset, source,
model configuration, and run settings. Use `--track system` to skip calls that
the core would bypass deterministically; the default `reviewer` track still
tests those model decisions counterfactually.

For a Command Code subscription run, set `PRB_COMMAND_CODE_BIN` to the absolute
path of the official CLI binary and use
[`models.command-code-cli.example.json`](./examples/models.command-code-cli.example.json).
This transport accepts only the `text` profile and a named effort variant. It
starts a fresh headless process per case and stops if the CLI attempts a tool
action. Command Code adds its own system prompt and receives the plugin policy
and evidence together as user content, so its result is a distinct prompt
profile, not a controlled comparison with `opencode-v1`.

For a private Jev run, copy the [OpenCode Zen
profile](./examples/models.system-one.example.json) or the [Command Code Provider
API profile](./examples/models.system-one-commandcode.example.json),
export its named key, set `--concurrency 2 --format-retries 0`, and start with a
one-case transport check. The typed response is reconciled by the same plugin
code used at runtime. Raw prompts, answers, and scores stay local: System One
runs are rejected by `export-public` even when the corpus is synthetic.

After the complete Jev run, evaluate a reasoning model only on Jev's valid
difficult decisions with the recorded subset selector:

```sh
bun cli.mjs run --repo ../.. --models models.luna-medium.local.json \
  --difficult-from runs/jev-private --out runs/jev-difficult-luna-medium \
  --concurrency 2 --max-calls 600 --format-retries 0
```

Repeat with the high-effort model file. The selector rejects a different corpus,
plugin source, incomplete run, repeated run, or transport-failed source. It
stores hashes and the parent run fingerprint instead of a local path. Derived
reasoning runs are private and also rejected by `export-public`.

Raw `runs/` and `reviews/` stay local and private. They can contain prompts,
provider responses, rationale text, endpoint details, and usage metadata.
Never commit them. Once a synthetic run is complete, `export-public` creates an
allowlisted report without prompts, raw responses, rationales, endpoint URLs,
or credential environment variable names:

```sh
node cli.mjs export-public --run runs/dev --out reviews/dev-public.json
```

Review even that report before publication. The corpus hash, plugin source
hash, model identifiers, per-case outcomes, and aggregate metrics are retained
for reproducibility. `compare` requires matching case IDs, labels, and repeat
indices; see `node cli.mjs help` for options.

## Interpretation

`model` is the model's parsed decision. `reachable` restricts the score to
requests that reach the model. `effective` is the result after the plugin's
gates. Format and transport failures remain missing model decisions, never
invented escalations. A single score does not certify safety: inspect critical
approvals, false denials, unnecessary escalations, and the exposed rationales.

The corpus has 214 `allow`, 195 `deny`, and 191 `escalate` reference outcomes.
Related variants share a family and stay in one partition; bootstrap intervals
resample families, not individual rows. Reference labels are single-author
drafts, not independently adjudicated ground truth. The public holdout is not
secret or contamination-resistant. The direct Chat Completions transport and
core replay do not reproduce the complete OpenCode V1/V2 host lifecycle.

See [the annotation guide](./docs/ANNOTATION_GUIDE.md) for reviewing disputed
labels and model explanations. The repository's root [LICENSE](../../LICENSE)
and [NOTICE](../../NOTICE) apply.
