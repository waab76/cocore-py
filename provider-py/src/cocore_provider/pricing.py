"""The uniform rate every off-catalog model falls back to in the Rust
provider (`provider/src/pricing.rs::UNIFORM_*`): 1,000,000 minor units per
MTok in each direction, currency "CC". provider-py has no curated per-model
catalog — every LMStudio model prices at this uniform rate."""

from __future__ import annotations

UNIFORM_INPUT_PER_MTOK = 1_000_000
UNIFORM_OUTPUT_PER_MTOK = 1_000_000
UNIFORM_CURRENCY = "CC"


def price_minor(tokens_in: int, tokens_out: int) -> int:
    in_charge = (UNIFORM_INPUT_PER_MTOK * tokens_in) // 1_000_000
    out_charge = (UNIFORM_OUTPUT_PER_MTOK * tokens_out) // 1_000_000
    return in_charge + out_charge


def estimate_tokens(data: bytes) -> int:
    """~4 bytes/token, ceiling — used only when LMStudio doesn't report usage."""
    return -(-len(data) // 4)
