from __future__ import annotations

import argparse
import asyncio
import os
import sys
from collections.abc import Awaitable, Callable

import httpx

from cocore_provider import __version__
from cocore_provider.attestation import build_attestation_record
from cocore_provider.config import REGISTER_LXM, AgentConfig, ConfigError, load_config
from cocore_provider.identity import load_or_create
from cocore_provider.lmstudio import LMStudioClient
from cocore_provider.pds_client import PdsClient
from cocore_provider.protocol import InferenceRequestFrame
from cocore_provider.session import SessionContext, run_session
from cocore_provider.ws_client import AdvisorConnection


def _build_lmstudio_http() -> httpx.AsyncClient:
    return httpx.AsyncClient()


def _build_console_http() -> httpx.AsyncClient:
    return httpx.AsyncClient()


async def serve(config: AgentConfig, *, provider_did: str) -> None:
    identity = load_or_create(config.identity_path)
    console_http = _build_console_http()
    pds = PdsClient(api_base=config.api_base, api_key=config.api_key, http=console_http)

    lmstudio_http = _build_lmstudio_http()
    lmstudio = LMStudioClient(base_url=config.lmstudio_url, http=lmstudio_http)
    supported_models = await lmstudio.list_models()
    if not supported_models:
        raise RuntimeError(f"no models loaded in LMStudio at {config.lmstudio_url}")

    attestation_record = build_attestation_record(identity, provider_did=provider_did)
    published_attestation = await pds.publish("dev.cocore.compute.attestation", attestation_record)

    ctx = SessionContext(
        identity=identity,
        provider_did=provider_did,
        lmstudio=lmstudio,
        pds=pds,
        attestation_uri=published_attestation.uri,
        attestation_cid=published_attestation.cid,
    )

    async def mint_auth_jwt() -> str | None:
        try:
            return await pds.mint_service_auth(config.advisor_did, REGISTER_LXM)
        except Exception:
            return None

    async def on_inference_request(
        req: InferenceRequestFrame, send: Callable[[dict[str, object]], Awaitable[None]]
    ) -> None:
        await run_session(req, send, ctx)

    conn = AdvisorConnection(
        config=config,
        identity=identity,
        provider_did=provider_did,
        mint_auth_jwt=mint_auth_jwt,
        attestation_uri=published_attestation.uri,
        supported_models=supported_models,
    )
    await conn.run(on_inference_request=on_inference_request)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cocore-provider")
    parser.add_argument("--version", action="store_true", help="print version and exit")
    subparsers = parser.add_subparsers(dest="command")
    serve_parser = subparsers.add_parser("serve", help="connect to the advisor and serve jobs")
    serve_parser.add_argument("--provider-did", required=True, help="this provider's DID")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.version:
        print(__version__)
        return 0
    if args.command == "serve":
        try:
            config = load_config(os.environ)
        except ConfigError as e:
            print(f"config error: {e}", file=sys.stderr)
            return 1
        asyncio.run(serve(config, provider_did=args.provider_did))
        return 0
    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
