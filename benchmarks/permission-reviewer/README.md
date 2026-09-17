# PRB-600: permission reviewer model benchmark

PRB-600 is a development-only benchmark for the OpenCode Permission Reviewer.
It contains 600 synthetic permission requests in 140 related families and 19
categories. It imports the plugin's actual prompt, evidence renderer, decision
parser, capability analyzer, and review core. It is not installed with the npm
package and does not change plugin behavior.

The benchmark never executes fixture commands. It has no real-conversation
capture, log import, telemetry, or replay feature. `run` contacts only the
configured provider endpoint or local OpenCode host. The direct provider
transport does not reuse OpenCode credentials. The optional `opencode-v1`
transport delegates authentication to an official OpenCode V1 server; the
benchmark never handles OAuth tokens. See the [evaluation protocol](./docs/METHODOLOGY.md)
before using a subscription and the [results table](./RESULTS.md) for published
evaluations.

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
models, start the server separately. The three output profiles are `text`,
`json_schema`, and `tool`; provider-specific reasoning settings belong in
`parameters` and are not inferred from an OpenCode variant.

```sh
cp examples/models.local.example.json models.local.json
bun cli.mjs render --repo ../.. --models models.local.json --out runs/render
bun cli.mjs run --repo ../.. --models models.local.json \
  --split dev --out runs/dev --max-calls 1200
node cli.mjs score --run runs/dev
node cli.mjs audit --run runs/dev --out reviews/dev.jsonl --sample 40
```

`render` makes no network calls. With direct transport, `--max-calls` bounds
HTTP requests; with `opencode-v1`, it bounds host prompts, not any internal
provider retries. Neither is a cost or subscription-usage cap. Start with a small
transport check, inspect failures, then evaluate complete partitions with the
same settings for each model. `--resume` requires an identical dataset, source,
model configuration, and run settings. Use `--track system` to skip calls that
the core would bypass deterministically; the default `reviewer` track still
tests those model decisions counterfactually.

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
