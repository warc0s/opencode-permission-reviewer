# Real-host compatibility matrix

Build with `bun run build`, install pytest (`python -m pip install pytest==9.1.1`)
in a disposable Python environment, install the pinned hosts and run the suite:

```bash
HOST_GENERATION=v1 bun tests/compatibility/install-hosts.ts
HOST_GENERATION=v2 bun tests/compatibility/install-hosts.ts
export OPENCODE_V1_1_18_29=/absolute/path/to/opencode-1.18.29  # one per printed line
python -m pytest tests/compatibility -q
```

`install-hosts.ts` installs each pinned Linux binary in a new temporary
directory, checks its registry integrity and prints the `OPENCODE_V*_*`
variable the tests read. It never replaces an existing installation or edits
shell aliases. CI receives these paths through `GITHUB_ENV`.

## Which hosts are verified

`host-contracts.json` is the single source of host versions; the pytest
modules read it through `hosts.py`, so adding or retiring a host is a data
change. Each generation lists:

- `minimum`: the oldest supported host. It stays pinned until the supported
  range itself changes.
- `reference`: the newest verified host, quoted as "tested with" in the main
  README.
- `integrities`: the hosts CI runs on every push. That is the minimum, the
  reference, and one host for each range between contract boundaries, i.e.
  versions where a test branches on the host version (V2: `2.0.18` stands for
  `>=2.0.18 <2.0.28`).
- `optionalIntegrities`: previously verified releases outside the CI set,
  kept for the on-demand window below.

When a newer host is verified it replaces the previous reference in
`integrities`, and the previous reference moves to `optionalIntegrities`
unless it is the only host for a contract range. Extended V2 reviewer
scenarios and the evidence suites run on the minimum and the reference.

To verify every pinned and optional release of one generation, run the
sequential window harness. It installs one host at a time, verifies its
integrity, runs the real-host tests, and removes the disposable installation
before continuing:

```bash
HOST_GENERATION=v2 PYTHON=/path/to/python-with-pytest \
  bun tests/compatibility/verify-host-window.ts
```

`V1_HOST_VERSION` or `V2_HOST_VERSION` selects one release for the functional
tests, alongside its matching executable variable. For example,
`V1_HOST_VERSION=1.18.34` uses `OPENCODE_V1_1_18_34` without changing the
pinned matrix.

The `host compatibility advisory` workflow runs daily. It reports registry
releases newer than the reference and runs the functional suites against the
current `latest` host of each generation (`HOST_RELEASE=latest
bun tests/compatibility/install-hosts.ts`). That host is unpinned, so the
workflow is advisory and never gates merges; a failure means the next host
bump needs work before it is pinned.

The V2 server and TUI compile against the minimum supported plugin SDK while
the real-host matrix exercises the pinned host binaries.

`tests/live-v2-smoke.ts` is the paid-provider smoke for a fresh V2 host. Its
fixture uses a placeholder plugin path that must point at the checkout before
starting the host. Set `REVIEWER_LIVE_DIRECTORY` when running against a
disposable fixture copy, `REVIEWER_LIVE_PASSWORD` for a registered service,
and `REVIEWER_LIVE_AUDIT_PATH` when trusted global config overrides the
default audit path. The smoke proves a real allow and execution, an LLM denial,
and a deterministic emergency-brake denial.

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
The MCP regressions count real process starts across concurrent and sequential
reviews, verify that reviewer locations exclude MCP, and keep operational MCP
servers connected. V1 also exercises two project backends sharing the same
isolation files.
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
