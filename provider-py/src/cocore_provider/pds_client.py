"""HTTP client for this agent's PDS interactions, mirroring
`provider/src/pds.rs`'s `PdsClient`. Writes go through the console's
PDS-proxy (`POST {api_base}/api/pds/createRecord` / `/api/pds/getServiceAuth`
with a plain `Bearer <api_key>`) since the agent has no DPoP-bound OAuth
session to write with directly. Reads (`list_records` / `get_provider_active`)
go straight to the provider's own PDS instead: `com.atproto.repo.listRecords`
is public, unauthenticated AT Protocol XRPC, and the console proxy exposes no
read endpoint to route them through anyway."""

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
    def __init__(self, *, api_base: str, api_key: str, http: httpx.AsyncClient, did: str) -> None:
        self._api_base = api_base.rstrip("/")
        self._api_key = api_key
        self._http = http
        self._did = did

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

    async def put_record(
        self, collection: str, rkey: str, record: dict[str, object]
    ) -> PublishedRecord:
        """Idempotent upsert at a stable rkey via the console's putRecord
        proxy. Used to republish this machine's provider record under its
        EXISTING rkey on every serve start instead of minting a fresh one
        (see `provider_record.publish_provider_record`). Mirrors
        `provider/src/pds.rs::put_record`, without its swap-guard/CAS-retry
        loop -- provider-py is a single process, so the rare concurrent-write
        race is accepted rather than built out."""
        resp = await self._http.post(
            f"{self._api_base}/api/pds/putRecord",
            headers={"Authorization": f"Bearer {self._api_key}"},
            json={"collection": collection, "rkey": rkey, "record": record},
        )
        if resp.status_code != 200:
            raise PdsError(
                f"console proxy putRecord {collection} returned {resp.status_code}: {resp.text}"
            )
        try:
            body = resp.json()
            return PublishedRecord(uri=body["uri"], cid=body["cid"])
        except (KeyError, ValueError) as e:
            raise PdsError(
                f"console proxy putRecord {collection} returned 200 but malformed: {e}"
            ) from e

    async def delete_record(self, collection: str, rkey: str) -> None:
        """Delete a record via the console's deleteRecord proxy. Used to trim
        duplicate provider records found by
        `provider_record.publish_provider_record`. An already-absent record
        (the proxy's `alreadyGone` case) is treated as success, same as
        `provider/src/pds.rs::delete_record`."""
        resp = await self._http.post(
            f"{self._api_base}/api/pds/deleteRecord",
            headers={"Authorization": f"Bearer {self._api_key}"},
            json={"collection": collection, "rkey": rkey},
        )
        if resp.status_code != 200:
            raise PdsError(
                f"console proxy deleteRecord {collection} returned {resp.status_code}: {resp.text}"
            )

    async def resolve_pds_endpoint(self) -> str:
        """Resolve this agent's own DID to its PDS's HTTP base URL: the PLC
        directory for `did:plc`, the well-known doc for `did:web`. Both are
        public, unauthenticated lookups. Mirrors
        `provider/src/pds.rs::resolve_pds_endpoint`."""
        if self._did.startswith("did:plc:"):
            resp = await self._http.get(f"https://plc.directory/{self._did}")
            if resp.status_code != 200:
                raise PdsError(f"plc resolve {self._did} returned {resp.status_code}")
            doc = resp.json()
            for svc in doc.get("service") or []:
                if svc.get("id") == "#atproto_pds":
                    endpoint = svc.get("serviceEndpoint")
                    if isinstance(endpoint, str) and endpoint:
                        return endpoint
            raise PdsError(f"no atproto_pds service in PLC doc for {self._did}")
        if self._did.startswith("did:web:"):
            host = self._did[len("did:web:") :]
            return f"https://{host}"
        raise PdsError(f"unsupported DID method: {self._did}")

    async def list_records(self, collection: str) -> list[dict[str, object]]:
        """List every record this DID owns under `collection`, read straight
        off its own PDS's public `com.atproto.repo.listRecords` (no console
        proxy involved). Paginated the same way
        `provider/src/pds.rs::list_my_records` is: 100 pages of up to 100
        records, comfortably above any realistic count."""
        pds_endpoint = await self.resolve_pds_endpoint()
        out: list[dict[str, object]] = []
        cursor: str | None = None
        for _ in range(100):
            params: dict[str, str | int] = {
                "repo": self._did,
                "collection": collection,
                "limit": 100,
            }
            if cursor is not None:
                params["cursor"] = cursor
            resp = await self._http.get(
                f"{pds_endpoint.rstrip('/')}/xrpc/com.atproto.repo.listRecords",
                params=params,
            )
            if resp.status_code != 200:
                raise PdsError(f"listRecords {collection} returned {resp.status_code}: {resp.text}")
            body = resp.json()
            records = body.get("records") or []
            out.extend(records)
            next_cursor = body.get("cursor")
            if not next_cursor or not records:
                break
            cursor = next_cursor
        return out

    async def get_provider_active(self, rkey: str) -> bool | None:
        """Read the owner's start/stop switch off this DID's own
        `dev.cocore.compute.provider` record at `rkey`. `None` means the
        field is absent (the lexicon default: serving) or the read failed --
        callers should treat that the same as `True`. Mirrors
        `provider/src/pds.rs::get_provider_active`."""
        try:
            records = await self.list_records("dev.cocore.compute.provider")
        except PdsError:
            return None
        for record in records:
            uri = record.get("uri")
            if isinstance(uri, str) and uri.rsplit("/", 1)[-1] == rkey:
                value = record.get("value")
                active = value.get("active") if isinstance(value, dict) else None
                return active if isinstance(active, bool) else None
        return None
