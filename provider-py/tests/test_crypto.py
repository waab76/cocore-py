from __future__ import annotations

import base64

from cocore.seal import open_from_provider, seal_to_provider
from nacl.public import PrivateKey

from cocore_provider.crypto import open_from_requester, seal_to_requester


def test_requester_to_provider_round_trip() -> None:
    provider_key = PrivateKey.generate()
    provider_pub_b64 = base64.b64encode(bytes(provider_key.public_key)).decode("ascii")

    framed, requester_pub_b64 = seal_to_provider(b"hello provider", provider_pub_b64)
    plaintext = open_from_requester(framed, requester_pub_b64, provider_key)
    assert plaintext == b"hello provider"


def test_provider_to_requester_round_trip() -> None:
    provider_key = PrivateKey.generate()
    requester_key = PrivateKey.generate()
    requester_pub_b64 = base64.b64encode(bytes(requester_key.public_key)).decode("ascii")
    provider_pub_b64 = base64.b64encode(bytes(provider_key.public_key)).decode("ascii")

    framed = seal_to_requester(b"hello requester", requester_pub_b64, provider_key)
    plaintext = open_from_provider(framed, provider_pub_b64, requester_key)
    assert plaintext == b"hello requester"
