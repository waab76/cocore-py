"""HTTP client over the console's PDS-proxy, mirroring
`provider/src/pds.rs`'s `PdsClient` exactly: the agent never talks to a real
PDS/AT-Proto endpoint directly (no DPoP-bound OAuth session here) — every
write goes through `POST {api_base}/api/pds/createRecord` /
`/api/pds/getServiceAuth` with a plain `Bearer <api_key>`."""

from __future__ import annotations

from dataclasses import dataclass

import httpx


class PdsError(RuntimeError):
    pass


@dataclass
class PublishedRecord:
    uri: str
    cid: str

    @property
    def rkey(self) -> str:
        """The record key, i.e. the last `/`-separated segment of `at://did/collection/rkey`."""
        return self.uri.rsplit("/", 1)[-1]


class PdsClient:
    def __init__(self, *, api_base: str, api_key: str, http: httpx.AsyncClient) -> None:
        self._api_base = api_base.rstrip("/")
        self._api_key = api_key
        self._http = http

    async def mint_service_auth(self, aud: str, lxm: str) -> str:
        resp = await self._http.post(
            f"{self._api_base}/api/pds/getServiceAuth",
            headers={"Authorization": f"Bearer {self._api_key}"},
            json={"aud": aud, "lxm": lxm},
        )
        if resp.status_code != 200:
            raise PdsError(f"console proxy getServiceAuth returned {resp.status_code}: {resp.text}")
        try:
            return str(resp.json()["token"])
        except (KeyError, ValueError) as e:
            raise PdsError(f"console proxy getServiceAuth returned 200 but malformed: {e}") from e

    async def publish(self, collection: str, record: dict[str, object]) -> PublishedRecord:
        resp = await self._http.post(
            f"{self._api_base}/api/pds/createRecord",
            headers={"Authorization": f"Bearer {self._api_key}"},
            json={"collection": collection, "record": record},
        )
        if resp.status_code != 200:
            raise PdsError(
                f"console proxy createRecord {collection} returned {resp.status_code}: {resp.text}"
            )
        try:
            body = resp.json()
            return PublishedRecord(uri=body["uri"], cid=body["cid"])
        except (KeyError, ValueError) as e:
            raise PdsError(
                f"console proxy createRecord {collection} returned 200 but malformed: {e}"
            ) from e
