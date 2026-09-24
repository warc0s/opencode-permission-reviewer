# Local model benchmark results

These results use the same 600 synthetic PRB-600 cases as the cloud model
benchmark. They are evidence for choosing a permission reviewer, not a
production safety certification. Local runs use the actual served model ID and
record the quantization because it can change the result. Rows are sorted by
`Model/100`, highest first. Latency is omitted because GPU, server, and host
settings differ between users.

| Model                                                                                                   | Quantization | Profile              | Model/100 | Valid decisions | Correct escalations | Critical approvals |
| ------------------------------------------------------------------------------------------------------- | ------------ | -------------------- | --------: | --------------: | ------------------: | -----------------: |
| [Qwen3.8 27B UD](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/blob/main/Qwen3.8-27B-UD-Q4_K_XL.gguf) | Q4_K_XL      | text, xhigh thinking |     97.30 |         600/600 |             175/191 |                  0 |
| [Qwen3.5 9B UD](https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/blob/main/Qwen3.5-9B-UD-Q6_K_XL.gguf)    | Q6_K_XL      | text, server default |     83.70 |         598/600 |             112/191 |                  2 |
| MiMo V2.6 Distill Qwen 9B                                                                               | Q6_K_L       | text                 |     72.47 |         488/600 |              82/191 |                  3 |
| [Granite 4.2 8B](https://huggingface.co/ibm-granite/granite-4.2-8b-GGUF)                                | Q6_K         | text, full reasoning |     62.70 |         600/600 |              77/191 |                 45 |
| [Granite 4.2 8B](https://huggingface.co/ibm-granite/granite-4.2-8b-GGUF)                                | Q6_K         | text, low effort     |     45.02 |         573/600 |              26/191 |                 53 |
| [Granite 4.2 8B](https://huggingface.co/ibm-granite/granite-4.2-8b-GGUF)                                | Q6_K         | text, no reasoning   |     24.10 |         576/600 |               7/191 |                 93 |
| MiMo V2.6 Distill Qwen 9B                                                                               | Q6_K_L       | json_schema          |      0.00 |         599/600 |               0/191 |                  6 |

Qwen3.8 27B UD-Q4_K_XL is the strongest local candidate tested here. It
returned 600 valid decisions and approved no cases labeled `deny` or critical,
but approved four cases labeled `escalate`. It is promising for supervised local
use, **not as the sole unattended permission gate**. The text run used
`xhigh` thinking with no separate reasoning budget and a 16,384-token total
output cap. No response reached that cap.

Qwen3.5 9B UD is **not recommended for autonomous review**: it approved six
cases labeled `deny` and 58 labeled `escalate`, including two critical cases. It
also produced two invalid
final decisions. The text run used the server's default settings and one
corrective format retry, with 604 requests total and no context errors. The
server reported zero reasoning tokens and empty reasoning content throughout;
this result should not be treated as a thinking-mode evaluation.
It used the current development source with explicit drift allowance, so this
score is not a controlled model-only comparison with the pinned MiMo run.

Granite 4.2 8B is **not recommended** as a permission reviewer in any tested
mode. Full reasoning improved the score and produced 600/600 valid decisions,
but still approved 50 cases labeled dangerous and 88 labeled for escalation,
including 45 critical cases. No reasoning approved 117 dangerous cases,
including 93 critical cases; low effort approved 69, including 53 critical
cases. LM Studio did not expose per-request reasoning controls for this GGUF, so
the text runs used Granite's assistant prefill for no reasoning and its
low-effort prompt marker for low effort. Full reasoning used the model default.
The full run needed 610 requests and had no context errors, so no recovery run
was needed. These runs used the current development source with explicit drift
allowance, not the pinned source used for MiMo.

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
the endpoint itself did not expose the quantization. The source was pinned at
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
