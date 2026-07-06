"""Best-effort coarse-location resolution for the optional, owner-gated
`region` field on the `dev.cocore.compute.provider` record. Mirrors
`provider/src/geoip.rs`.

IMPORTANT -- this is an ADVISORY, self-asserted signal, not a proof of
location. We resolve the machine's country from its public IP at serve
start; a VPN/proxy moves it, so verifiers MUST treat the published
`region` as unverified (the same trust posture as `tier`). The provider
writes the claim to its OWN PDS; no coordinator owns or gates it -- but
the AGENT itself only resolves and stamps it when the owner has opted in
via `shareLocation` on their existing provider record (see
`provider_record.find_my_provider_record`).

The lookup endpoint is configurable via `COCORE_GEOIP_URL` so an operator
can point at their own geo service. The default returns an ISO 3166-1
alpha-2 code as plain text. Any failure (network, timeout, unparseable
body) resolves to `None`: the caller simply omits the field and never
blocks serving on it.
"""

from __future__ import annotations

import json
import os

import httpx

REGION_SOURCE_IP_GEO = "ip-geo"

DEFAULT_ENDPOINT = "https://ifconfig.co/country-iso"

REQUEST_TIMEOUT_SECS = 5.0

# A country code is 2 bytes and a small JSON envelope is well under this;
# anything larger is a misbehaving (or compromised) endpoint, discarded
# rather than buffered unbounded.
MAX_BODY_BYTES = 4096


def endpoint() -> str:
    raw = os.environ.get("COCORE_GEOIP_URL", "").strip()
    return raw or DEFAULT_ENDPOINT


def _is_alpha2(s: str) -> bool:
    return len(s) == 2 and s.isascii() and s.isalpha()


def parse_country(body: str) -> str | None:
    trimmed = body.strip()
    if _is_alpha2(trimmed):
        return trimmed.upper()
    try:
        value = json.loads(trimmed)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(value, dict):
        return None
    for key in ("country_code", "countryCode", "country_iso", "country"):
        candidate = value.get(key)
        if isinstance(candidate, str):
            candidate = candidate.strip()
            if _is_alpha2(candidate):
                return candidate.upper()
    return None


async def resolve_country(http: httpx.AsyncClient) -> str | None:
    """Resolve this machine's country as an ISO 3166-1 alpha-2 code
    (uppercased) from its public IP, best-effort. Returns `None` on any
    failure so the caller can omit `region` rather than block or publish a
    bad value."""
    url = endpoint()
    try:
        async with http.stream("GET", url, timeout=REQUEST_TIMEOUT_SECS) as resp:
            if resp.status_code != 200:
                return None
            buf = bytearray()
            async for chunk in resp.aiter_bytes():
                buf.extend(chunk)
                if len(buf) > MAX_BODY_BYTES:
                    return None
            body = bytes(buf).decode("utf-8", errors="strict")
    except (httpx.HTTPError, UnicodeDecodeError):
        return None
    return parse_country(body)
