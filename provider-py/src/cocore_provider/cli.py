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

from cocore_provider import __version__, geoip
from cocore_provider.attestation import build_attestation_record
from cocore_provider.config import (
    REGISTER_LXM,
    AgentConfig,
    ConfigError,
    load_config,
    resolve_provider_did,
)
from cocore_provider.config_file import find_config_path, load_config_file
from cocore_provider.diagnostics import check_attestation_status, format_check, run_doctor
from cocore_provider.identity import load_or_create
from cocore_provider.lmstudio import LMStudioClient, LMStudioError
from cocore_provider.logging_setup import configure_logging
from cocore_provider.pds_client import PdsClient, PdsError
from cocore_provider.protocol import InferenceRequestFrame
from cocore_provider.provider_record import (
    build_attestation_fault,
    build_engine_fault,
    build_provider_record,
    find_my_provider_record,
    publish_provider_record,
)
from cocore_provider.session import SessionContext, run_session
from cocore_provider.ws_client import AdvisorConnection


def _ram_gb() -> int:
    return int(psutil.virtual_memory().total // (1024**3))


def _cpu_cores() -> int | None:
    count = psutil.cpu_count(logical=True)
    return int(count) if count is not None else None


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
    # A dead/empty LMStudio must not crash the whole agent -- the Rust agent
    # keeps serving `stub` and surfaces `engineFault` on the provider record
    # instead. provider-py has no stub engine to fall back to, so it
    # registers with an empty `supported_models` (excluded from routing,
    # per registry.ts's M2 rule) rather than not appearing at all.
    engine_fault: dict[str, object] | None = None
    try:
        supported_models = await lmstudio.list_models()
    except LMStudioError as e:
        supported_models = []
        engine_fault = build_engine_fault(
            code="model-load-failed",
            message=f"LMStudio unreachable at {config.lmstudio_url}: {e}",
            models=[],
        )
        logger.error(
            "LMStudio unreachable at %s: %s; continuing with no models", config.lmstudio_url, e
        )
    else:
        if not supported_models:
            engine_fault = build_engine_fault(
                code="model-load-failed",
                message=f"no models loaded in LMStudio at {config.lmstudio_url}",
                models=[],
            )
            logger.error(
                "no models loaded in LMStudio at %s; continuing degraded", config.lmstudio_url
            )
        else:
            logger.info(
                "LMStudio at %s reports models: %s",
                config.lmstudio_url,
                ", ".join(supported_models),
            )

    # Same principle for a failed attestation publish: the Rust agent keeps
    # serving with an empty attestation_uri (receipts just aren't published
    # for that job) and surfaces `attestationFault`, rather than crashing.
    attestation_fault: dict[str, object] | None = None
    attestation_uri = ""
    attestation_cid = ""
    try:
        attestation_record = build_attestation_record(identity, provider_did=provider_did)
        published_attestation = await pds.publish(
            "dev.cocore.compute.attestation", attestation_record
        )
        attestation_uri = published_attestation.uri
        attestation_cid = published_attestation.cid
        logger.info("published attestation record %s", attestation_uri)
    except PdsError as e:
        attestation_fault = build_attestation_fault(
            code="attestation-publish-failed",
            message=f"failed to publish attestation record: {e}",
        )
        logger.error(
            "failed to publish attestation record: %s; continuing without one "
            "(receipts will be skipped)",
            e,
        )

    ram_gb = config.ram_gb if config.ram_gb is not None else _ram_gb()

    # Coarse, opt-in location (refresh-on-serve). Only when the owner opted
    # in via the console's `shareLocation` switch -- read off our OWN
    # existing record, before deciding whether to make the geoip call at
    # all -- do we resolve this machine's country from its public IP.
    # Absent/no-record-yet/read-failure all mean "not opted in", matching
    # `provider/src/main.rs::find_my_provider_record`'s fallback.
    existing_provider = await find_my_provider_record(pds, identity.signing_public_b64)
    share_location = bool(existing_provider and existing_provider.get("shareLocation") is True)
    region: str | None = None
    region_source: str | None = None
    if share_location:
        region = await geoip.resolve_country(console_http)
        if region is not None:
            region_source = geoip.REGION_SOURCE_IP_GEO
            logger.info("location sharing on — stamping provider record region=%s", region)
        else:
            logger.warning(
                "location sharing on but country lookup failed; leaving region unset this serve"
            )

    provider_record = build_provider_record(
        machine_label=config.machine_label,
        chip=f"lmstudio:{platform.system().lower()}",
        ram_gb=ram_gb,
        supported_models=supported_models,
        encryption_pub_key=identity.encryption_public_b64,
        attestation_pub_key=identity.signing_public_b64,
        binary_version=__version__,
        engine_fault=engine_fault,
        attestation_fault=attestation_fault,
        cpu_cores=_cpu_cores(),
        os_name=platform.platform(),
        region=region,
        region_source=region_source,
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
        attestation_uri=attestation_uri,
        attestation_cid=attestation_cid,
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
        attestation_uri=attestation_uri,
        supported_models=supported_models,
        ram_gb=ram_gb,
        lmstudio=lmstudio,
    )
    logger.info("connecting to advisor at %s", config.advisor_url)
    await conn.run(on_inference_request=on_inference_request)


async def doctor(config: AgentConfig, *, provider_did: str) -> int:
    print(f"==> cocore-provider doctor {__version__}")
    print(f"  console: {config.api_base}")
    print(f"  advisor: {config.advisor_url}")
    print(f"  provider_did: {provider_did}")
    print()
    lmstudio_http = _build_lmstudio_http()
    console_http = _build_console_http()
    checks = await run_doctor(config, lmstudio_http=lmstudio_http, console_http=console_http)
    for check in checks:
        print(format_check(check))
    failed = [c for c in checks if not c.ok]
    print()
    if not failed:
        print("==> all checks passed.")
        return 0
    print(f"==> {len(failed)} check(s) failed:")
    for c in failed:
        print(f"  - {c.name}: {c.note}")
    return 1


async def attestation_status(config: AgentConfig, *, provider_did: str) -> int:
    print(f"==> cocore-provider attestation-status {__version__}")
    print(f"  provider_did: {provider_did}")
    print()
    identity = load_or_create(config.identity_path)
    console_http = _build_console_http()
    pds = PdsClient(
        api_base=config.api_base, api_key=config.api_key, http=console_http, did=provider_did
    )
    check = await check_attestation_status(pds, identity)
    print(format_check(check))
    return 0 if check.ok else 1


def _add_config_args(subparser: argparse.ArgumentParser) -> None:
    subparser.add_argument(
        "--provider-did",
        default=None,
        help=(
            "this provider's DID (default: --provider-did flag > provider_did config file key "
            "> COCORE_PROVIDER_DID env var)"
        ),
    )
    subparser.add_argument(
        "--config",
        default=None,
        help=(
            "path to a TOML config file (default: --config flag > "
            "COCORE_CONFIG_PATH env var > ~/.cocore/provider-py/config.toml)"
        ),
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cocore-provider")
    parser.add_argument("--version", action="store_true", help="print version and exit")
    subparsers = parser.add_subparsers(dest="command")
    serve_parser = subparsers.add_parser("serve", help="connect to the advisor and serve jobs")
    _add_config_args(serve_parser)
    doctor_parser = subparsers.add_parser(
        "doctor",
        help="read-only health checks: LMStudio reachability, API key, cross-system status",
    )
    _add_config_args(doctor_parser)
    attestation_parser = subparsers.add_parser(
        "attestation-status",
        help="report this machine's latest published attestation record and any fault",
    )
    _add_config_args(attestation_parser)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.version:
        print(__version__)
        return 0
    if args.command in ("serve", "doctor", "attestation-status"):
        try:
            config, provider_did = _resolve_agent_config(args, os.environ)
        except ConfigError as e:
            print(f"config error: {e}", file=sys.stderr)
            return 1
        if args.command == "serve":
            configure_logging(config.log_level, config.log_file)
            asyncio.run(serve(config, provider_did=provider_did))
            return 0
        if args.command == "doctor":
            return asyncio.run(doctor(config, provider_did=provider_did))
        return asyncio.run(attestation_status(config, provider_did=provider_did))
    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
