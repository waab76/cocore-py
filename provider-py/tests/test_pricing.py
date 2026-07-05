from __future__ import annotations

from cocore_provider.pricing import estimate_tokens, price_minor


def test_price_minor_one_to_one_rate() -> None:
    assert price_minor(10, 0) == 10
    assert price_minor(0, 50) == 50
    assert price_minor(100_000, 0) == 100_000


def test_estimate_tokens_rounds_up() -> None:
    assert estimate_tokens(b"") == 0
    assert estimate_tokens(b"abcd") == 1
    assert estimate_tokens(b"abcde") == 2
