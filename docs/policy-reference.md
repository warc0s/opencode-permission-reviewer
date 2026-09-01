# Policy reference

The declarative policy engine evaluates capability and actor facts against
user-defined rules with most-restrictive resolution. It is **off by default**
(observe mode, empty rule set) and produces zero behavior change until you
configure rules and switch to `enforce`.

## Modes

| Mode                | Behavior                                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observe` (default) | The policy trace is computed and recorded in the audit, but the reviewer LLM always runs. The trace is injected into the reviewer prompt as `EFFECTIVE_POLICY_SUMMARY`. |
| `enforce`           | `manual` and `deny` routes skip the LLM entirely. The emergency brake always runs first and is never weakened.                                                          |

Set the mode in global or inline config (a project config cannot enable or
downgrade it):

```jsonc
// ~/.config/opencode/permission-reviewer.jsonc
{
  "enforcementMode": "enforce",
}
```

## Effects and precedence

Rules propose one of four effects. When multiple rules match, the
**most-restrictive** wins:

```
deny (3)  >  manual (2)  >  review (1)  >  allow (0)
```

- If no rule matches, the final route is `review` (the LLM runs normally).
- In enforce mode, `manual` escalates to the user without an LLM call; `deny`
  returns a denial with `decisionSource: "deterministic-policy"`.
- A `review` or `allow` route **does not** auto-approve: both proceed to the
  reviewer LLM. There is no rule effect that skips the model with an approval.
- Project-sourced `allow` rules are **filtered out** before evaluation — a
  repository cannot relax security.

## Rule shape

```ts
interface PolicyRule {
  id: string
  source: "builtin" | "global" | "project" | "inline"
  when: PolicyCondition // all specified conditions are AND-ed
  effect: "allow" | "review" | "manual" | "deny"
  reason: string
}
```

`source` is required and determines how the trust boundary treats the rule.
Project-layer rules are relabeled to `source: "project"` automatically.

## Condition reference (`PolicyCondition`)

All conditions are **positive-only**: a boolean condition checks `=== true`.
An `"unknown"` fact never matches. If `capability` is `undefined` (analysis was
not possible) and a condition references a capability field, the match fails.
All specified conditions are AND-ed; omitting a field means "do not constrain
on this".

| Field                 | Type                      | Matches when                                                                                                 |
| --------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `actionClass`         | `CapabilityActionClass[]` | `cap.actionClass.value` is in the list                                                                       |
| `actorProfile`        | `ActorProfile[]`          | `actor.profile.value` is in the list                                                                         |
| `writesWorkspace`     | `boolean`                 | `cap.writeEffects.workspaceWrite.value === true`                                                             |
| `writesExternal`      | `boolean`                 | `cap.writeEffects.externalWrite.value === true`                                                              |
| `writesTemporary`     | `boolean`                 | `cap.writeEffects.temporaryWrite.value === true`                                                             |
| `deletion`            | `boolean`                 | `cap.writeEffects.deletion.value === true`                                                                   |
| `executesCode`        | `boolean`                 | `cap.executesCode.value === true`                                                                            |
| `createsAdHocCode`    | `boolean`                 | `cap.createsAdHocCode.value === true`                                                                        |
| `packageManagement`   | `boolean`                 | `cap.invokesPackageLifecycleScripts.value === true` **and** `cap.actionClass.value === "package-management"` |
| `gitMutation`         | `boolean`                 | `cap.git.possible.value === true`                                                                            |
| `networkObserved`     | `boolean`                 | `cap.network.observed.value === true`                                                                        |
| `privilegeEscalation` | `boolean`                 | `cap.process.privilegeEscalation.value === true`                                                             |
| `remoteEnabled`       | `boolean`                 | `cap.remote.enabled.value === true`                                                                          |
| `persistence`         | `boolean`                 | `cap.process.persistence.value === true`                                                                     |
| `repositoryTrust`     | `RepositoryTrust[]`       | the resolved `config.repositoryTrust` is in the list                                                         |

See the [Capability model reference](./capability-model.md) for the
`CapabilityAssessment` fields, and the [Actor resolution reference](./actor-resolution.md)
for `actor.profile`.

### `CapabilityActionClass` values

`read-only`, `workspace-write`, `temporary-write`, `external-write`,
`destruction`, `code-execution`, `package-management`, `git-mutation`,
`network`, `remote-operation`, `service-management`, `persistence`,
`privilege-escalation`, `unknown`

### `ActorProfile` values

`read-only`, `validation`, `workspace`, `operator`, `reviewer`, `unknown`

By default every actor resolves to `"unknown"` until you map a name in
`actorProfiles` (global/inline config only).

## Built-in profile templates

The engine ships five documented rule templates. They are **not active by
default** (the default rule set is empty). Copy any of them into your own
`policyRules` to opt in.

| Rule id                         | Condition                                                              | Effect | Reason                                                   |
| ------------------------------- | ---------------------------------------------------------------------- | ------ | -------------------------------------------------------- |
| `read-only-workspace-write`     | `actorProfile: ["read-only"]`, `writesWorkspace: true`                 | manual | read-only actor attempting workspace write               |
| `read-only-code-execution`      | `actorProfile: ["read-only"]`, `executesCode: true`                    | manual | read-only actor attempting code execution                |
| `any-actor-package-untrusted`   | `packageManagement: true`, `repositoryTrust: ["untrusted", "unknown"]` | manual | package management in an untrusted or unknown repository |
| `unknown-actor-remote-mutation` | `actorProfile: ["unknown"]`, `remoteEnabled: true`                     | manual | unknown actor attempting remote operation                |
| `unknown-actor-external-write`  | `actorProfile: ["unknown"]`, `writesExternal: true`                    | manual | unknown actor attempting external write                  |

## Policy trace

Every evaluation produces a `PolicyTrace` that is recorded in the audit
(`schemaVersion: 2`):

```ts
interface PolicyTrace {
  effectivePolicyHash: string // sha256, first 16 hex, of the effective rule set
  matchedRules: Array<{ id: string; source: string; effect: string; reason: string }>
  finalRoute: "review" | "manual" | "deny" | "allow"
  mode: "observe" | "enforce"
}
```

The `effectivePolicyHash` is computed over the full effective rule set (after
filtering project `allow` rules), so audit records can be correlated with the
policy that was in effect. In observe mode, `finalRoute` is the
**counterfactual** route (what enforce _would_ have done).

The reviewer prompt also receives an `EFFECTIVE_POLICY_SUMMARY` JSON section
with the hash, the counterfactual route, the mode, and the matched rule ids and
reasons.

## Examples

### Deny broad destruction in an untrusted repo

```jsonc
// ~/.config/opencode/permission-reviewer.jsonc
{
  "enforcementMode": "enforce",
  "policyRules": [
    {
      "id": "deny-destruction-untrusted",
      "source": "global",
      "when": {
        "actionClass": ["destruction"],
        "repositoryTrust": ["untrusted", "unknown"],
      },
      "effect": "deny",
      "reason": "Destructive actions are not auto-approved in untrusted repos",
    },
  ],
}
```

### Manual-escalate unknown-actor remote operations

```jsonc
{
  "enforcementMode": "enforce",
  "policyRules": [
    {
      "id": "unknown-remote",
      "source": "global",
      "when": { "actorProfile": ["unknown"], "remoteEnabled": true },
      "effect": "manual",
      "reason": "Unknown actor attempting a remote operation",
    },
  ],
}
```

### Combine: a read-only validator must not execute code or write

```jsonc
{
  "actorProfiles": { "my-validator": "read-only" },
  "enforcementMode": "enforce",
  "policyRules": [
    {
      "id": "validator-no-code",
      "source": "global",
      "when": { "actorProfile": ["read-only"], "executesCode": true },
      "effect": "manual",
      "reason": "Read-only validator attempting code execution",
    },
    {
      "id": "validator-no-write",
      "source": "global",
      "when": { "actorProfile": ["read-only"], "writesWorkspace": true },
      "effect": "manual",
      "reason": "Read-only validator attempting workspace write",
    },
  ],
}
```

## Escalation disposition

After the reviewer, declarative policy, gates, or fail-safe produce an internal
`allow | deny | escalate`, a single enforcement boundary disposes escalations:

| Config                         | Effect                                                              |
| ------------------------------ | ------------------------------------------------------------------- |
| `escalationMode: "manual"`     | Default. Internal escalate is left for a human (interactive).       |
| `escalationMode: "deny"`       | Every final escalate becomes a reject with the original reason.     |
| `riskPolicy.onInvalidDecision` | `"manual"` (default) or `"deny"` — only invalid structured output.  |
| `riskPolicy.onReviewerFailure` | `"manual"` (default) or `"deny"` — only timeout/transport failures. |

Precedence is monotonic: any `deny` wins; nothing can relax a more restrictive
setting. `manual-superseded` (human already answered) is never converted.

Audit fields (additive, `schemaVersion` stays `2`):

- `reviewerOutcome` — structured LLM outcome before gates/disposition (absent
  when no valid decision was produced).
- `escalationDisposition` — `"manual"` or `"deny"` when an internal escalate was
  disposed; absent for explicit allow/deny.
- `askDecisions` — snapshot of the user's answers to agent ask dialogs that were
  surfaced to the reviewer prompt (observe-only; most recent few).

## Inspecting your policy

- **`opencode-permission-reviewer doctor`** — prints the resolved mode,
  repository trust, rule count, and `effectivePolicyHash`.
- **`opencode-permission-reviewer config print-effective`** — prints the full
  resolved config and the engine-equivalent policy hash.
- **`opencode-permission-reviewer explain --command '...'`** — dry-runs a
  command through the capability analyzer and policy engine, printing the
  assessment and trace as JSON.
