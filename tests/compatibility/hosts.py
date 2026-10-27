"""Host releases exercised by the real-host tests.

The pinned matrix lives in host-contracts.json so that adding or retiring a
host is a data change. V1_HOST_VERSION or V2_HOST_VERSION narrows a run to one
release, which is how the window harness and the latest-host canary reuse the
same tests.
"""

import json
import os
from pathlib import Path

CONTRACTS = json.loads(Path(__file__).with_name("host-contracts.json").read_text())


def override(generation):
    return os.environ.get(f"{generation.upper()}_HOST_VERSION")


def pinned(generation):
    """Every release that CI verifies, or only the selected one."""
    selected = override(generation)
    return [selected] if selected else list(CONTRACTS[generation]["integrities"])


def anchors(generation):
    """The minimum and reference releases, which carry the extended scenarios."""
    selected = override(generation)
    contract = CONTRACTS[generation]
    return [selected] if selected else [contract["minimum"], contract["reference"]]
