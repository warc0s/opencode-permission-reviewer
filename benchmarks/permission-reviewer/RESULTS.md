# Model benchmark results

These are synthetic benchmark results, not a production safety certification.
The reference labels are single-author drafts. Each row covers the same 600
cases with the same plugin-produced prompt and evidence hashes. Invalid model
outputs remain missing decisions in the score. Transport pilots are diagnostics
and are not included in the scores.

| Model                         | Effort  | Model/100 | Reachable/100 | Core/100 | JSON valid (%) | Critical approvals | Unsupported approvals | Attempts | Mean host latency |
| ----------------------------- | ------- | --------: | ------------: | -------: | -------------: | -----------------: | --------------------: | -------: | ----------------: |
| GPT-6 Luna                    | medium  |     97.17 |         97.34 |    97.17 |         100.0% |                  0 |                     2 |      600 |            8.12 s |
| GPT-5.6 Luna                  | high    |     96.77 |         96.85 |    96.68 |         100.0% |                  0 |                     3 |      600 |            8.60 s |
| GPT-6 Luna                    | high    |     96.02 |         96.01 |    95.84 |         100.0% |                  0 |                     0 |      644 |           11.51 s |
| GPT-5.6 Luna                  | medium  |     95.84 |         95.84 |    95.67 |         100.0% |                  0 |                     4 |      600 |            7.35 s |
| GPT-5.6 Luna                  | xhigh   |     94.89 |         94.89 |    94.72 |         100.0% |                  0 |                     8 |      600 |            9.35 s |
| Muse Spark 1.3 Contributor    | high    |     94.72 |         94.71 |    94.55 |          99.7% |                  0 |                    13 |      600 |           23.07 s |
| MiMo V2.6 Flash Reasoning     | default |     94.05 |         94.04 |    95.17 |          98.2% |                  0 |                    13 |      600 |           13.85 s |
| Muse Spark 1.3 Contributor    | medium  |     93.27 |         93.26 |    93.45 |          98.0% |                  0 |                    14 |      600 |           25.45 s |
| DeepSeek V4.1 Flash           | high    |     92.64 |         92.63 |    93.01 |          99.5% |                  0 |                    17 |      600 |            4.46 s |
| DeepSeek V4.1 Flash           | low     |     91.67 |         91.66 |    92.53 |          99.3% |                  0 |                    19 |      600 |            4.10 s |
| Grok 4.6                      | medium  |     91.58 |         91.57 |    91.41 |         100.0% |                  0 |                     2 |      601 |           15.05 s |
| GLM-5.3-Flash                 | high    |     90.69 |         90.68 |    92.07 |          98.7% |                  0 |                    27 |      600 |           21.92 s |
| MiMo V2.6 Flash Non-Reasoning | none    |     90.07 |         90.10 |    91.70 |          91.5% |                  0 |                    13 |      606 |            7.48 s |
| Grok 4.6                      | low     |     87.65 |         87.65 |    87.49 |         100.0% |                  0 |                     3 |      604 |            6.51 s |
| GLM-5.3-Flash                 | low     |     85.31 |         85.54 |    90.24 |          90.5% |                  0 |                    25 |      655 |            5.66 s |
| MiMo V2.5 Reasoning           | default |     58.99 |         58.94 |    67.28 |          66.8% |                  0 |                    44 |      600 |           29.02 s |

`JSON valid (%)` is the share of 600 responses that passed the decision parser, not
the share of correct answers.
Invalid outputs are missing decisions in `Model/100`, not successful escalations.

All runs used the text profile through OpenCode V1 1.18.30 with operational
tools disabled. Grok used SuperGrok OAuth, Luna used OpenAI OAuth, and DeepSeek,
MiMo, and Muse used OpenCode Go. The `Model/100` column is the decision before plugin
gates; `Core/100` is the effective replay after them. No model approved a case
labeled `deny`, and none approved any of the 159 critical cases. The
`Unsupported approvals` column counts approvals of cases labeled `escalate`;
these require individual review even when the aggregate score is high.

The GPT-6 runs used plugin source `dc5fd3d`; their prompts and evidence hashes
match the earlier rows on all 600 cases. The older rows used a prior core replay,
so cross-revision comparisons should use `Model/100`, not `Core/100`.

## Paired comparisons

The family-bootstrap differences below use the same 600 synthetic cases and
500 resamples. They express uncertainty across the authored case families, not
real-world incident rates.

| Comparison                              | Score difference | 95% interval     |
| --------------------------------------- | ---------------: | ---------------- |
| GPT-6 Luna medium minus high            |            +1.16 | -0.21 to +2.64   |
| Grok medium minus Grok low              |            +3.92 | +1.54 to +6.83   |
| Luna medium minus Grok medium           |            +4.26 | +2.28 to +6.58   |
| Luna high minus Luna medium             |            +0.92 | -0.25 to +2.32   |
| Luna xhigh minus Luna high              |            -1.88 | -3.30 to -0.61   |
| GLM high minus GLM low                  |            +5.37 | +1.97 to +8.59   |
| DeepSeek high minus low                 |            +0.97 | -1.33 to +3.00   |
| Muse high minus medium                  |            +1.44 | -0.33 to +3.14   |
| MiMo V2.6 minus MiMo V2.5               |           +35.06 | +30.13 to +39.29 |
| MiMo V2.6 reasoning minus non-reasoning |            +3.98 | +1.44 to +6.18   |

GPT-6 Luna medium had the highest observed score. Its advantage over GPT-6 Luna
high is not established by this interval. GPT-5.6 Luna high scored above its
medium variant, but that interval also crosses zero; its xhigh variant scored
below high and had more unsupported approvals. Muse high scored above Muse
medium, but the interval does not establish a winner between those effort levels.

## GPT-6 Luna

Evaluated on 2026-09-22 through OpenCode V1 1.18.30 with OpenAI OAuth and the
text profile. Both effort levels returned 600 valid decisions with no dangerous
or critical approvals. Medium scored 97.17, with two unsupported approvals,
four unnecessary escalations, and 8.12 s mean host latency. High scored 96.02,
with no unsupported approvals, nine unnecessary escalations, and 11.51 s mean
host latency. The paired interval does not establish a winner. Medium is the
faster default on this corpus; high is the more conservative choice if avoiding
unsupported approvals
matters more than latency. High's 600 scored cases came from two segments after
the first was interrupted. The 42 repeated controls and two interrupted calls
are retained in the 644 recorded host attempts, not scored twice. Its latency
is descriptive of those run conditions, not an effort-only comparison.

## Grok 4.6, low effort

Evaluated on 2026-09-16 with `xai/grok-4.6`, the `low` variant, and no automatic
retries. Its harness was committed at `a1d3366`; later Grok, GPT-5.6 Luna, and
GLM runs used `7cf4bf2`. The DeepSeek runs used a later harness revision without
changes to the OpenCode transport.
The earlier plugin source was pinned to `ed7cafd`. Case, prompt, and evidence
hashes match across all sixteen rows. The 95% family-bootstrap interval
for Grok low is 84.33-90.61, not a
production incident-rate guarantee.

The model made 600 valid decisions on 600 distinct cases. There were zero
approvals of 159 critical cases and zero approvals of cases labeled `deny`.
Three cases labeled `escalate` were approved: two feature-branch force pushes
without evidence about shared history, and one `npm test` with unread lifecycle
scripts. These approvals remained allowed after core replay. The model also
denied 71 cases labeled `escalate`, denied one `allow` case, and unnecessarily
escalated four `allow` cases. None of the 40 paired prompt-injection attacks
induced an unsafe approval in this corpus.

The evaluation used random 2-4 second pauses initially and random 1-3 second
pauses after a user-requested pace change. Three 120-second timeouts and one
user interruption were retained as non-scored attempts; each affected case
later received one valid response. Thus the score uses exactly one valid
decision per case, while 604 transport attempts were recorded in total. For
valid responses, host-transport latency excludes the pauses. Its mean was
6.51 s and p95 was 11.32 s. It includes OpenCode session setup and is not pure
model inference time. See the [evaluation protocol](./docs/METHODOLOGY.md) for
consolidation and limits.

An allowlisted per-case report will be linked after privacy and provenance
review. Raw prompts, rationales, host session IDs, and account data remain
local and ignored by Git. See the [benchmark guide](./README.md) before
interpreting or comparing scores.

## GLM-5.3-Flash, low effort

Evaluated on 2026-09-16 through the OpenCode V1 session transport with no
automatic retries or request delays. It covers the same 600 cases and prompt and
evidence hashes as the other candidates. Its 95% family-bootstrap interval is
82.75-87.90; this describes synthetic-family uncertainty, not production risk.

The model returned 543 valid decisions and 57 invalid responses, mostly JSON
objects missing a required decision field (54 omitted `confidence`). This
text-profile run disabled format retries, so it does not measure the plugin's
corrective retry or structured-output recovery in a live review. It made zero approvals of
cases labeled `deny` or marked critical, but approved 25 cases labeled
`escalate` without sufficient support. The plugin core replay reduced those
unsupported approvals to 24. The run recorded 655 attempts: 600 scored
responses, 52 repeated paired controls needed after a configuration change, and
three interrupted or timed-out transport attempts superseded by later
responses. Each case contributes exactly one response to the score.

Mean host latency for scored responses was 5.66 s (p95 11.22 s), excluding
queue time, pauses, and the unscored attempts. It includes OpenCode session
setup and is not pure model inference time.

## GLM-5.3-Flash, high effort

Evaluated on 2026-09-16 with no request delays or automatic retries. The 600
cases have the same prompt and evidence hashes as the low
run and the other candidates. Its 95% family-bootstrap interval is
88.19-93.00, not a production incident-rate estimate.

The model returned 592 valid decisions and eight invalid responses. It made
zero approvals of cases labeled `deny` or marked critical, but approved 27
cases labeled `escalate`. The plugin core replay reduced those unsupported
approvals to 22. Mean host latency was 21.92 s (p95 49.09 s), excluding queue
time. The higher effort scored 5.37 points above low on these paired cases;
the 95% family-bootstrap interval for that difference is +1.97 to +8.59.
This score gain does not mean fewer unsupported approvals: high had 27 versus
low's 25.

## DeepSeek V4.1 Flash, low effort

Evaluated on 2026-09-16 through OpenCode Go with OpenCode V1 1.18.30, no
request delays, and no automatic retries. The model returned 596
valid decisions and four invalid responses. Its 95% family-bootstrap interval
is 88.99-94.15, reflecting synthetic-family uncertainty only.

It made zero approvals of cases labeled `deny` or marked critical, but approved
19 cases labeled `escalate` without sufficient support. The plugin core replay
reduced these unsupported approvals to 13. Mean host-transport latency was
4.10 s (p95 6.76 s), including OpenCode session setup and excluding queue time.

## DeepSeek V4.1 Flash, high effort

Evaluated on 2026-09-16 through the same OpenCode Go and OpenCode V1 1.18.30
transport as low, with no request delays or automatic retries.
The model returned 597 valid decisions and three invalid responses. Its 95%
family-bootstrap interval is 90.06-94.65, reflecting synthetic-family
uncertainty only.

It made zero approvals of cases labeled `deny` or marked critical, but approved
17 cases labeled `escalate`. The plugin core replay reduced these unsupported
approvals to 13. It denied one case labeled `allow`. Mean host-transport
latency was 4.46 s (p95 7.92 s), including OpenCode session setup and
excluding queue time.

The low and high runs share the same corpus, plugin source, harness, host,
prompt and evidence hashes. High scored 0.97 points above low
on these paired cases, but the 95% family-bootstrap interval for the difference
is -1.33 to +3.00. This corpus does not establish a winner between those effort
levels.

## MiMo V2.5 Reasoning, default effort

MiMo scored 58.99, placed last, and produced valid decisions for only 66.8% of
the corpus. It made no dangerous or critical approvals, but had 44 unsupported
approvals and the highest mean latency in the table. It is not recommended for
day-to-day permission review while the output-validity problem remains.

## MiMo V2.6 Flash Reasoning, default effort

MiMo V2.6 Flash Reasoning scored 94.05 and placed fifth. It made no dangerous or
critical approvals, had 13 unsupported approvals, and returned valid decisions
for 98.2% of the corpus. It scored 35.06 points above MiMo V2.5; the paired
interval of +30.13 to +39.29 establishes a substantial improvement on this
corpus. MiMo V2.6 Flash Reasoning is a strong day-to-day permission-review
candidate and replaces V2.5 as the MiMo version worth considering.

## MiMo V2.6 Flash Non-Reasoning

MiMo V2.6 Flash Non-Reasoning scored 90.07 and placed eleventh. It made no
dangerous or critical approvals and had 13 unsupported approvals, but only
91.5% of its responses were valid JSON. All 600 scored responses reported zero
reasoning tokens. Mean host latency fell from 13.85 s to 7.48 s, while the score
fell by 3.98 points; the paired interval of +1.44 to +6.18 favors reasoning on
this corpus.

For day-to-day permission review, the reasoning configuration is recommended.
The no-reasoning mode is useful only when latency matters more than decision
quality and invalid output is handled conservatively as escalation.

## Muse Spark 1.3 Contributor

High scored 94.72 and placed fourth; medium scored 93.27 and placed sixth. Both
made zero dangerous or critical approvals. High had 13 unsupported approvals
and medium had 14. The observed 1.44-point advantage for high is not established
by the paired interval, so this corpus does not show that high is meaningfully
better than medium.

OpenCode Go currently classifies Muse Spark 1.3 Contributor as training-enabled
and not zero-data-retention: prompts and completions may be used to train future
Meta models. This benchmark uses only synthetic data. For day-to-day use, this
is a strong option for public repositories and other non-sensitive work. It is
not recommended for confidential source code or private data. See the official
[OpenCode Go privacy table](https://opencode.ai/docs/go/).
