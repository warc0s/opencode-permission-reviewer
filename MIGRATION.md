# OpenCode V1 and V2 migration

Use one package with separate server adapters. OpenCode V1 calls `server()`;
V2 calls `setup()`. The pinned contracts and package integrities are recorded
in `tests/compatibility/host-contracts.json`.

| Setting                | V1                            | V2                                    |
| ---------------------- | ----------------------------- | ------------------------------------- |
| Host                   | 1.18.29 or newer V1           | >=2.0.3 <3                            |
| Server config key      | `plugin`                      | `plugins`                             |
| Entry with options     | `[package, options]`          | `{package, options}`                  |
| Terminal config        | `tui.json` or `tui.jsonc`     | Global `cli.json`                     |
| Shell permission       | `bash`                        | `shell`                               |
| Delegation permission  | `task`                        | `subagent`                            |
| Permission application | `once`, `reject`, or no reply | `allow`, `deny`, or `ask` evaluation  |
| Interface transport    | Host TUI events               | Authenticated RPC snapshot and events |

## Install and connect

Build the checkout before registering its directory, or install the published
tarball. No installation lifecycle scripts are required to build the package.
The directory entrypoints and npm exports both resolve the generated files.

Run `init --host v1` or `init --host v2`, optionally with `--tui`. `--host auto`
uses the selected `--binary`; absence or contradictory config stops the write.
`--print`, `--dry-run`, and `--json` do not write files. The JSON report separates
`plannedWrites` from `writes`. Existing entries are detected, comments are
preserved, and changed files receive exclusive backups. Other permission rules
are not converted or reordered.

For V2, place model, variant, policy, and retention settings in the trusted
global `permission-reviewer.jsonc`. Repository config and unknown-origin inline
options cannot redirect the reviewer model or weaken trusted restrictions.
The reviewer model must be configured globally in OpenCode so its isolated
location can resolve it without loading project providers or instructions.

V2 service discovery reads OpenCode's local authenticated service registration
instead of probing version-specific health endpoints. The registration must
match the running host version, identify a live process, and use a loopback URL;
the reviewer then proves the plugin instance through its own RPC identity. It
never starts a service. An independent server requires these trusted environment
settings:

```bash
export OPENCODE_PERMISSION_REVIEWER_HOST_URL=http://127.0.0.1:4096
# Set OPENCODE_PASSWORD through your existing secure environment mechanism.
opencode serve --hostname 127.0.0.1 --port 4096
```

The password authenticates the OpenCode server, not the model provider. It is
never stored in audit records or exposed through reviewer RPC. A nonce check
must match this plugin instance before the client accesses reviewer sessions.
Remote TUI clients use the connection already supplied by their host.
The reviewer backend runs inside the server and requires its local filesystem
for isolated locations. An explicit endpoint must identify that same server,
not a separate machine. Non-loopback HTTP endpoints are rejected before sending
credentials; use HTTPS for non-loopback connections.

## Review behavior

Both formats use the same decision parser and policy gates. Structured mode
uses a validated result tool, while all operational and MCP tools are denied.
Text mode parses the complete response and rejects ambiguous JSON. A missing
model or unsupported variant is an explicit failure, never a silent fallback.
Validated low-confidence denials remain denials.

V2 isolates each reviewer in a temporary location with only its owned hooks.
The total `reviewBudgetMs` includes context and retries; its default is
`2 * timeoutMs + 60000`. Cancellation and unload close the attempt, interrupt
the auxiliary session, and discard late results. Retention keeps sessions for
inspection; otherwise the authenticated client removes them.
Deletion is verified after bounded retries. If cleanup cannot be confirmed,
the review fails safely and its isolation guards remain active. Further reviews
are refused if unresolved auxiliary sessions exhaust the cleanup capacity.

Review approval is not proof of tool execution. Both adapters write audit schema 3,
an independent `reviewID`, host generation, native action, and application state.
V1 preserves the published permission ID in `hostRequestID` and `requestID`;
`reply-accepted` means its transport acknowledged the reply. In V2 the compatibility
`requestID` is the review identity, not a host permission ID, and
`evaluation-returned` means the hook returned its evaluation.
If a V1 reply cannot be acknowledged, the UI reports an unknown application
instead of claiming that a human permission request is still pending.
Historical audit records remain readable without destructive migration.

The TUI subscribes before loading a snapshot, filters by location and generation,
and uses monotonic revisions. A watchdog or disconnection shows unknown status;
it cannot manufacture a pending human decision or approve a permission.

Other installed plugins can change hooks and tool definitions. Later plugins
can override evaluation results; do not treat this reviewer as an irrevocable
security boundary against arbitrary code loaded into the same host.
The adapter rechecks the captured action before returning and denies if it
changed during review. A plugin changing it after this hook returns remains
outside that guarantee. Losing the server event stream cancels active reviews
and prevents new approvals until the plugin is reactivated.

## Diagnostics and rollback

`doctor` reports local configuration explicitly as `local-only`. For V2 live
status, use `doctor --endpoint <server-url>` with server authentication in the
environment. `explain` reads effective reviewer config; `--defaults` requests
the legacy default-only calculation. It accepts V1 requests and V2 action/resource
inputs, with exact execution input where available.

Keep exact host and plugin versions and the configuration backups. To return
to V1, restore a V1 host and the matching `plugin`/`tui.json` configuration.
Installing an older V1-only plugin into V2 is not a rollback. Preserve audit
history and retained sessions. Release numbers and tags are chosen separately;
legacy maintenance uses the `v1` npm tag and must not replace `latest`.
