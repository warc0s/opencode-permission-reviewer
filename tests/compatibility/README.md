# Real-host compatibility matrix

Build with `bun run build`, install pytest (`python -m pip install pytest==9.1.1`)
in a disposable Python environment, and set these executable paths:

```bash
export OPENCODE_V1_1_18_29=/absolute/path/to/opencode-1.18.29
export OPENCODE_V1_1_18_30=/absolute/path/to/opencode-1.18.30
export OPENCODE_V1_1_18_31=/absolute/path/to/opencode-1.18.31
export OPENCODE_V1_1_18_32=/absolute/path/to/opencode-1.18.32
export OPENCODE_V2_2_0_3=/absolute/path/to/opencode-2.0.3
export OPENCODE_V2_2_0_11=/absolute/path/to/opencode-2.0.11
export OPENCODE_V2_2_0_14=/absolute/path/to/opencode-2.0.14
python -m pytest tests/compatibility -q
```

`HOST_GENERATION=v1 bun tests/compatibility/install-hosts.ts` and the equivalent
`v2` command install pinned Linux binaries in new temporary directories and
print the required variables. They never replace an existing installation or
edit shell aliases. CI receives these paths through `GITHUB_ENV`.

The V2 server and TUI compile against the minimum supported plugin SDK while
the real-host matrix exercises the minimum and reference host binaries.

To verify every pinned stable V2 release locally without making CI install the
full compatibility window, run the sequential window harness. It installs one
host at a time, verifies its integrity, runs the real-host tests, and removes
the disposable installation before continuing:

```bash
PYTHON=/path/to/python-with-pytest \
  bun tests/compatibility/verify-v2-window.ts
```

The default command and CI remain limited to the minimum and reference V2
hosts. The optional window verifies the intermediate releases on demand.

`tests/live-v2-smoke.ts` is the paid-provider smoke for a fresh V2 service. Its
fixture uses a placeholder plugin path that must point at the checkout before
starting the host. Pass the registered service password through
`REVIEWER_LIVE_PASSWORD`; set `REVIEWER_LIVE_AUDIT_PATH` only when trusted
global config overrides the default audit path. The smoke proves a real allow
and execution, an LLM denial, and a deterministic emergency-brake denial.

The variables must point to the actual host executable. Do not point them at a
profile launcher that overwrites `HOME`, `XDG_*`, or `OPENCODE_CONFIG*`: that
would bypass the disposable profile created by `conftest.py` and can produce
misleading activation or authentication failures. Use the launcher's
underlying runtime binary or the pinned installer above. End users normally
run a direct OpenCode installation and do not need this distinction. Custom
launchers are also supported when they select a supported runtime and a
coherent configuration, but their profile behavior should be smoke-tested
separately from this isolated matrix.

The V1 and V2 pytest modules use independent protocol adapters and fresh hosts.
They share only the synthetic HTTP model provider and filesystem isolation.
The TUI module opens real PTYs and verifies visible reviewing and terminal
states. No provider account, key, or paid inference is required.

Without `PLUGIN_PACKAGE_PATH`, the functional tests load this checkout's built
package. To validate installation, run `PACKAGE_MANAGER=npm bun
tests/compatibility/install-package.ts` or use `PACKAGE_MANAGER=bun`, then set
`PLUGIN_PACKAGE_PATH` to its returned `packagePath`. Packing and installation
disable lifecycle scripts. CI exercises both installed graphs.

Temporary host logs, audit records, and terminal captures remain under pytest's
temporary directory for diagnosis. These artifacts must not be committed.
Only Linux is currently verified by this matrix; other operating systems need
equivalent live validation before being advertised as supported.

`fixtures/*-native.json` preserve sanitized projections captured from the
reference hosts. The tests compare live context, tool correlation, fork
provenance and form events against these contracts. `capture-contracts.ts`
also exercises the native form events through the production normalizer.

The rollback test switches a single disposable profile from V1 to V2 and back,
restoring exact configuration backups and checking the original session and
mixed historical audit records. It needs both reference binaries.
