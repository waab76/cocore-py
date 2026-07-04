"""Provider-side NaCl crypto_box sealing — the other half of the
requester<->provider handshake `sdk/py/cocore/seal.py` implements for
the client. Wire format: 24-byte nonce prefix || crypto_box ciphertext,
identical on both sides."""

from __future__ import annotations

import base64

from nacl.public import Box, PrivateKey, PublicKey
from nacl.utils import random as nacl_random


def open_from_requester(framed: bytes, requester_pub_b64: str, my_secret: PrivateKey) -> bytes:
    """Open a ciphertext framed as nonce || body, sent by a requester."""
    nonce, body = framed[: Box.NONCE_SIZE], framed[Box.NONCE_SIZE :]
    box = Box(my_secret, PublicKey(base64.b64decode(requester_pub_b64)))
    return box.decrypt(body, nonce)


def seal_to_requester(plaintext: bytes, requester_pub_b64: str, my_secret: PrivateKey) -> bytes:
    """Seal `plaintext` to a requester using this provider's persistent
    encryption key (reused across a session's chunks, unlike the requester's
    fresh-ephemeral-key convention — NaCl box is symmetric in the keys used,
    so reusing the provider's static key here is safe)."""
    box = Box(my_secret, PublicKey(base64.b64decode(requester_pub_b64)))
    nonce = nacl_random(Box.NONCE_SIZE)
    body = box.encrypt(plaintext, nonce).ciphertext
    return nonce + body
