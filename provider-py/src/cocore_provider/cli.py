from __future__ import annotations

import argparse
import asyncio
import logging
import os
import platform
import sys
from collections.abc import Awaitable, Callable, Mapping

import httpx
import psutil

from cocore_provider import __version__
from cocore_provider.attestation import build_attestation_record
from cocore_provider.config import (
    REGISTER_LXM,
    AgentConfig,
    ConfigError,
    load_config,
    resolve_provider_did,
)
from cocore_provider.config_file import find_config_path, load_config_file
from cocore_provider.identity import load_or_create
from cocore_provider.lmstudio import LMStudioClient
from cocore_provider.logging_setup import configure_logging
from cocore_provider.pds_client import PdsClient
from cocore_provider.protocol import InferenceRequestFrame
from cocore_provider.provider_record import build_provider_record, publish_provider_record
from cocore_provider.session import SessionContext, run_session
from cocore_provider.ws_client import AdvisorConnection


def _ram_gb() -> int:
    return int(psutil.virtual_memory().total // (1024**3))


logger = logging.getLogger(__name__)


def _resolve_agent_config(
    args: argparse.Namespace, env: Mapping[str, str]
) -> tuple[AgentConfig, str]:
    is_explicit = bool(args.config) or bool(env.get("COCORE_CONFIG_PATH"))
    config_path = find_config_path(cli_arg=args.config, env=env)
    config_file = load_config_file(config_path, is_explicit=is_explicit)
    config = load_config(env, config_file=config_file)
    provider_did = resolve_provider_did(cli_arg=args.provider_did, file=config_file, env=env)
    return config, provider_did


def _build_lmstudio_http() -> httpx.AsyncClient:
    return httpx.AsyncClient()


def _build_console_http() -> httpx.AsyncClient:
    return httpx.AsyncClient()


async def serve(config: AgentConfig, *, provider_did: str) -> None:
    logger.info("cocore-provider %s starting for provider_did=%s", __version__, provider_did)
    identity = load_or_create(config.identity_path)
    logger.info("identity loaded from %s", config.identity_path)
    console_http = _build_console_http()
    pds = PdsClient(
        api_base=config.api_base, api_key=config.api_key, http=console_http, did=provider_did
    )

    lmstudio_http = _build_lmstudio_http()
    lmstudio = LMStudioClient(base_url=config.lmstudio_url, http=lmstudio_http)
    supported_models = await lmstudio.list_models()
    if not supported_models:
        raise RuntimeError(f"no models loaded in LMStudio at {config.lmstudio_url}")
    logger.info(
        "LMStudio at %s reports models: %s", config.lmstudio_url, ", ".join(supported_models)
    )

    attestation_record = build_attestation_record(identity, provider_did=provider_did)
    published_attestation = await pds.publish("dev.cocore.compute.attestation", attestation_record)
    logger.info("published attestation record %s", published_attestation.uri)

    ram_gb = config.ram_gb if config.ram_gb is not None else _ram_gb()
    provider_record = build_provider_record(
        machine_label=config.machine_label,
        chip=f"lmstudio:{platform.system().lower()}",
        ram_gb=ram_gb,
        supported_models=supported_models,
        encryption_pub_key=identity.encryption_public_b64,
        attestation_pub_key=identity.signing_public_b64,
        binary_version=__version__,
    )
    published_provider = await publish_provider_record(
        pds, identity.signing_public_b64, provider_record
    )
    logger.info("published provider record %s", published_provider.uri)

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
        machine_id=published_provider.rkey,
        pds=pds,
        mint_auth_jwt=mint_auth_jwt,
        attestation_uri=published_attestation.uri,
        supported_models=supported_models,
        ram_gb=ram_gb,
        lmstudio=lmstudio,
    )
    logger.info("connecting to advisor at %s", config.advisor_url)
    await conn.run(on_inference_request=on_inference_request)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cocore-provider")
    parser.add_argument("--version", action="store_true", help="print version and exit")
    subparsers = parser.add_subparsers(dest="command")
    serve_parser = subparsers.add_parser("serve", help="connect to the advisor and serve jobs")
    serve_parser.add_argument(
        "--provider-did",
        default=None,
        help=(
            "this provider's DID (default: --provider-did flag > provider_did config file key "
            "> COCORE_PROVIDER_DID env var)"
        ),
    )
    serve_parser.add_argument(
        "--config",
        default=None,
        help=(
            "path to a TOML config file (default: --config flag > "
            "COCORE_CONFIG_PATH env var > ~/.cocore/provider-py/config.toml)"
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.version:
        print(__version__)
        return 0
    if args.command == "serve":
        try:
            config, provider_did = _resolve_agent_config(args, os.environ)
        except ConfigError as e:
            print(f"config error: {e}", file=sys.stderr)
            return 1
        configure_logging(config.log_level, config.log_file)
        asyncio.run(serve(config, provider_did=provider_did))
        return 0
    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
