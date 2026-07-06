# cocore-provider (Python / LMStudio)

A standalone Python provider agent for cocore — joins the advisor network
and serves inference jobs through a local [LMStudio](https://lmstudio.ai)
instance. Sibling to the Rust agent in `../provider/`; same protocol, same
receipt lexicon, different runtime. Built for Windows machines running
LMStudio, at the `best-effort` attestation tier (software-backed identity,
no Secure Enclave / TPM measurement).

Single asyncio event loop: one WebSocket connection to the advisor, a
heartbeat every 30s, and one in-flight inference job at a time (matches one
local LMStudio instance — no queueing, no concurrency).

## Requirements

- Python ≥3.11
- [`uv`](https://docs.astral.sh/uv/)
- [LMStudio](https://lmstudio.ai) running locally with at least one model loaded
- A cocore console API key (`COCORE_API_KEY`) and console URL (`COCORE_API_BASE`)
- Your provider's DID (`did:plc:...` or `did:web:...`)

## Install

```bash
cd provider-py
uv sync --extra dev
```

This installs `cocore-provider` plus an editable path dependency on
`../sdk/py`'s `cocore` package (canonical-JSON encoding, P-256 sign/verify,
NaCl sealing — shared with the Rust agent's Python tooling, not duplicated
here).

## Configuration

Configuration can come from a TOML config file, environment variables, or
both. Per setting, the config file's value wins if present; the matching
environment variable is only used for settings the file omits (or when
there's no config file at all). Required:

| Variable | Config file key | Description |
|---|---|---|
| `COCORE_API_KEY` | `api_key` | Console API key, used as a bearer token against the console's PDS-proxy. |
| `COCORE_API_BASE` | `api_base` | Console base URL (e.g. `https://console.cocore.dev`). |

Optional (defaults shown):

| Variable | Config file key | Default | Description |
|---|---|---|---|
| `COCORE_ADVISOR` | `advisor_url` | `wss://advisor.cocore.dev/v1/agent` | Advisor WebSocket URL. Must be `wss://` unless `allow_insecure_advisor`/`COCORE_ALLOW_INSECURE_ADVISOR` is set. |
| `COCORE_ADVISOR_DID` | `advisor_did` | `did:web:advisor.cocore.dev` | DID the advisor authenticates as. |
| `COCORE_LMSTUDIO_URL` | `lmstudio_url` | `http://localhost:1234` | Base URL of your local LMStudio server. |
| `COCORE_IDENTITY_PATH` | `identity_path` | `~/.cocore/provider-py/identity.json` | Where the provider's P-256 signing key + X25519 encryption key are persisted (created on first run). |
| `COCORE_MACHINE_LABEL` | `machine_label` | hostname | Human-readable label sent at registration. |
| `COCORE_ALLOW_INSECURE_ADVISOR` | `allow_insecure_advisor` | unset / `false` | Allow a non-`wss://` advisor URL (local dev only). |

An empty value for any of these (in either source) is treated the same as
unset (falls back to the next source) — a variable or key that's
declared-but-blank won't silently produce a broken URL.

### Config file

Copy `config.toml.example` to `config.toml` and fill in what you need —
every key is optional, and `config.toml` itself is optional (delete it and
`provider-py` behaves exactly as it does with environment variables
alone). `config.toml` is gitignored since it may hold your API key in
plaintext; only `config.toml.example` is committed.

By default `provider-py` looks for the file at
`~/.cocore/provider-py/config.toml`. Override the path with, in order of
precedence:

```bash
cocore-provider serve --config path/to/config.toml --provider-did did:plc:<your-did>
# or
COCORE_CONFIG_PATH=path/to/config.toml uv run cocore-provider serve --provider-did did:plc:<your-did>
```

If you point `--config`/`COCORE_CONFIG_PATH` at a path that doesn't exist,
that's treated as a mistake (a clear error, not a silent fallback) — only
the untouched default path tolerates being absent.

## Running

```bash
cd provider-py
COCORE_API_KEY=<key> COCORE_API_BASE=<console-url> uv run cocore-provider serve --provider-did did:plc:<your-did>
```

On first run this:

1. Generates and persists a P-256 signing key + X25519 encryption key at
   `COCORE_IDENTITY_PATH`.
2. Calls LMStudio's `/v1/models` to discover what's loaded — fails fast if
   nothing is.
3. Builds and publishes a `dev.cocore.compute.attestation` record (software
   self-attestation; every hardware-measurement posture field is honestly
   reported `false` since there's no Secure Enclave off Apple silicon).
4. Connects to the advisor, registers, and serves jobs until stopped
   (`Ctrl+C` / `SIGTERM`).

Each dispatched job is decrypted (NaCl box), sent to LMStudio as a
streaming chat completion, sealed and streamed back to the requester chunk
by chunk, and — on success — settled with a signed
`dev.cocore.compute.receipt` record published to your PDS via the console
proxy. A recoverable LMStudio failure sends one sealed error chunk and a
zero-token completion (no receipt); a hard decrypt failure drops the
session silently. The connection reconnects with backoff on disconnect or
a 70s receive-idle timeout.

Pricing is uniform for every model — no per-model catalog in v1 — at
1,000,000 minor units per MTok in each direction, currency `CC`
(`src/cocore_provider/pricing.py`), matching the Rust provider's fallback
rate for off-catalog models.

## Scope (v1)

- No `dev.cocore.compute.provider` record is published — registration is
  WS-only, so the machine won't appear in the console's device list yet.
- No tool-calling, `output_schema`-guided decoding, or `reasoning` channel —
  plain `content`-channel chat completion only.
- `best-effort` attestation tier only (no confidential/enclave tier).

## Development

```bash
cd provider-py
uv run pytest -v              # test suite
uv run mypy src                # type check (strict, src/ only)
uv run ruff check .            # lint (whole package, including tests)
uv run ruff format --check .   # format check
```

## Layout

```
src/cocore_provider/
  cli.py          entry point: `cocore-provider serve --provider-did ...`
  config.py       AgentConfig loading: config file (wins) + env fallback + timing constants
  config_file.py  locates and parses the optional TOML config file
  identity.py     persisted P-256 signing key + X25519 encryption key
  crypto.py       NaCl box seal/open (provider side of the requester<->provider handshake)
  attestation.py  best-effort attestation record + challenge-response
  protocol.py     advisor WebSocket wire frames (encode/decode)
  ws_client.py    advisor connection: register, heartbeat, reconnect, job dispatch
  session.py      per-job orchestration: decrypt -> LMStudio -> seal chunks -> receipt
  lmstudio.py     LMStudio OpenAI-compatible client (models + streaming chat)
  pds_client.py   console PDS-proxy HTTP client (publish records, mint service auth)
  receipt.py      dev.cocore.compute.receipt record builder + signer
  pricing.py      uniform token pricing + byte-length token estimate
```
