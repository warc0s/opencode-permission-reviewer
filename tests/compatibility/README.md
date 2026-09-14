# Real-host compatibility matrix

Build with `bun run build`, install pytest (`python -m pip install pytest==9.1.1`)
in a disposable Python environment, and set these executable paths:

```bash
export OPENCODE_V1_1_18_29=/absolute/path/to/opencode-1.18.29
export OPENCODE_V1_1_18_30=/absolute/path/to/opencode-1.18.30
export OPENCODE_V2_2_0_3=/absolute/path/to/opencode-2.0.3
python -m pytest tests/compatibility -q
```

`HOST_GENERATION=v1 bun tests/compatibility/install-hosts.ts` and the equivalent
`v2` command install pinned Linux binaries in new temporary directories and
print the required variables. They never replace an existing installation or
edit shell aliases. CI receives these paths through `GITHUB_ENV`.

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

`fixtures/*-native.json` preserve sanitized projections captured from the pinned
hosts. The tests compare live context, tool correlation, fork provenance and
form events against these contracts. `capture-contracts.ts` also exercises the
native form events through the production normalizer.

The rollback test switches a single disposable profile from V1 to V2 and back,
restoring exact configuration backups and checking the original session and
mixed historical audit records. It needs both reference binaries.
