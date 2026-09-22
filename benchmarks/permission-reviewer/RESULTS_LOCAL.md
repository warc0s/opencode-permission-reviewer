# Local model benchmark results

These results use the same 600 synthetic PRB-600 cases as the cloud model
benchmark. They are evidence for choosing a permission reviewer, not a
production safety certification. Local runs use the actual served model ID and
record the quantization because it can change the result.

| Model                     | Quantization | Profile     | Model/100 | Valid decisions | Correct escalations | Critical approvals | Mean host latency |
| ------------------------- | ------------ | ----------- | --------: | --------------: | ------------------: | -----------------: | ----------------: |
| MiMo V2.6 Distill Qwen 9B | Q6_K_L       | text        |     72.47 |         488/600 |              82/191 |                  3 |            7.37 s |
| MiMo V2.6 Distill Qwen 9B | Q6_K_L       | json_schema |      0.00 |         599/600 |               0/191 |                  6 |            7.67 s |

MiMo V2.6 Distill Qwen 9B is **not recommended** as a permission reviewer under
either profile. Text gave more meaningful escalation decisions, but still
approved six cases labeled `deny`, three of them critical, and returned 112
invalid decisions. The structured profile nearly eliminated format errors but
did not correctly escalate any of the 191 cases labeled `escalate`: it approved
85 and denied 106. Its zero score follows from zero escalation recall in the
benchmark's multiplicative metric, not from JSON formatting. Six critical
requests were approved in that profile.

Both runs used the `mimo-v2.6-distill-qwen-9b` model ID through a local Chat
Completions endpoint. Text measured first responses without format retries; its
four interrupted transport attempts were repeated separately and only their
valid replacements were scored. JSON Schema allowed one corrective format retry:
594 first attempts and 599 final decisions were valid in 606 requests. The
Q6_K_L quantization was reported for the loaded model from the
[bartowski GGUF repository](https://huggingface.co/bartowski/MiMo-V2.6-Distill-Qwen-9B-GGUF);
the endpoint itself did not expose the quantization. Host latency includes the
local server, so it is specific to this setup. The source was pinned at
`dc5fd3d`; raw prompts, responses, and endpoint details remain local.

The text and structured profiles also use different final prompt instructions.
This model behaved much worse with the complete structured profile, but these
runs do not isolate the API format parameter or establish the same effect for
other local or cloud models. Evaluate decision quality as well as JSON validity
before choosing a profile.

The direct local transport differs from the OpenCode host transport in the
[cloud results](./RESULTS.md), so their scores are not a controlled model-only
comparison. See the [evaluation protocol](./docs/METHODOLOGY.md) for the scoring
rules and limitations.
