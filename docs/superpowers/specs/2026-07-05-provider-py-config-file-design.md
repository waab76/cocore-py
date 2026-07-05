# provider-py config file support (env fallback)

Date: 2026-07-05
Status: approved (design), pending implementation plan

## Problem

`provider-py`'s configuration (`config.py`'s `load_config`) is entirely
environment-variable-driven today: `COCORE_API_KEY`, `COCORE_API_BASE`,
`COCORE_ADVISOR`, `COCORE_ADVISOR_DID`, `COCORE_LMSTUDIO_URL`,
`COCORE_IDENTITY_PATH`, `COCORE_MACHINE_LABEL`,
`COCORE_ALLOW_INSECURE_ADVISOR`. There's no way to keep an operator's full
configuration in one place on disk; every launch has to set env vars (or
wrap the launch in a shell script that does).

There is no existing config-file precedent anywhere in this repo — the
Rust provider (`provider/`) is also purely env-var driven — so this is a
new, additive pattern for `provider-py` specifically, not a port of an
existing convention.

## Goal

Let an operator put required and optional settings in a TOML config file.
Per setting: the config file's value wins if present and non-empty; the
corresponding environment variable is consulted only when the file omits
that key (or there's no config file at all); the existing hardcoded
defaults remain the last resort. Fully backward compatible — an operator
who never creates a config file sees no behavior change.

## Scope decisions (from brainstorming)

- **Format**: TOML, via the stdlib `tomllib` (read-only, Python 3.11+ — no
  new dependency). Matches `pyproject.toml`'s own format.
- **Default location**: `~/.cocore/provider-py/config.toml`, alongside the
  existing `~/.cocore/provider-py/identity.json` default.
- **Path override**: `--config PATH` CLI flag first, then `COCORE_CONFIG_PATH`
  env var, then the default — the same file-then-env-then-default
  precedence applied recursively to the config file's own path.
- **Fields covered**: all 8 current settings (`advisor_url`, `advisor_did`,
  `api_key`, `api_base`, `lmstudio_url`, `identity_path`, `machine_label`,
  `allow_insecure_advisor`), using the same snake_case names as
  `AgentConfig`'s fields — a config file is literally "the env vars, minus
  the `COCORE_` prefix, in TOML."
- **Secrets**: `api_key` may live in the file in plaintext, same trust
  model as `identity.json`'s persisted private key (local filesystem
  permissions are the security boundary, not a secrets-manager
  integration — out of scope for v1). The file is gitignored (see below)
  so it's never accidentally committed.

## Architecture

```
provider-py/
  src/cocore_provider/
    config_file.py     # NEW: find + parse the TOML config file
    config.py          # MODIFIED: load_config gains an optional config_file param
    cli.py             # MODIFIED: --config flag, wires config_file.py into load_config
  config.toml.example   # NEW: fully-commented sample, all 8 keys
  .gitignore            # NEW: ignores config.toml (not config.toml.example)
```

**`config_file.py` (new)**
- `DEFAULT_CONFIG_PATH = Path.home() / ".cocore" / "provider-py" / "config.toml"`
- `find_config_path(*, cli_arg: str | None, env: Mapping[str, str]) -> Path`
  — resolves `--config` → `COCORE_CONFIG_PATH` → `DEFAULT_CONFIG_PATH`.
- `load_config_file(path: Path, *, is_explicit: bool) -> dict[str, object]`
  — parses TOML if the file exists; returns `{}` if it doesn't AND
  `is_explicit` is `False` (the untouched default path); raises
  `ConfigError` if it doesn't exist AND `is_explicit` is `True` (operator
  pointed at a specific path that isn't there — almost certainly a typo);
  raises `ConfigError` (wrapping `tomllib.TOMLDecodeError`) on malformed
  TOML regardless of `is_explicit`.

**`config.py` (modified)**
- `load_config(env: Mapping[str, str], *, config_file: Mapping[str, object] | None = None) -> AgentConfig`
  — new optional parameter, defaults to `None`/treated as `{}`, so every
  existing call site and test is unaffected.
- New private helper:
  ```python
  def _resolve(
      key: str, *, file: Mapping[str, object], env: Mapping[str, str],
      env_key: str, default: str | None = None,
  ) -> str | None:
      file_value = file.get(key)
      if isinstance(file_value, str) and file_value:
          return file_value
      env_value = env.get(env_key)
      if env_value:
          return env_value
      return default
  ```
  All 8 fields route through `_resolve` instead of today's per-field
  `env.get(...) or DEFAULT` calls. Non-string file values (wrong TOML
  type, e.g. a table where a string was expected) are treated as absent
  — falls through to env/default rather than raising, keeping this
  function's existing "loud error only for the two truly-required fields"
  behavior intact.
- Existing validation is unchanged: `api_key`/`api_base` still raise
  `ConfigError` if unresolved from any source; the insecure-URL check
  still runs against whatever `advisor_url` resolves to.

**`cli.py` (modified)**
- `build_parser()` gains `--config PATH` on the top-level parser.
- `main()` computes `is_explicit = args.config is not None or bool(os.environ.get("COCORE_CONFIG_PATH"))`
  itself (it already has both values in hand), then calls:
  `find_config_path(cli_arg=args.config, env=os.environ)` →
  `load_config_file(path, is_explicit=is_explicit)` →
  `load_config(os.environ, config_file=...)`.
  `find_config_path` only resolves *which* path to use; it does not report
  back whether that path came from an override or the default — the
  caller already knows, since it's the one holding `args.config` and
  reading the env var.

## Data flow

1. `main()` resolves the config file path: `--config` flag, else
   `COCORE_CONFIG_PATH`, else the default `~/.cocore/provider-py/config.toml`.
2. `load_config_file` reads and parses it (or returns `{}` if it's the
   untouched default and doesn't exist).
3. `load_config(os.environ, config_file=parsed)` resolves each of the 8
   fields: file value (if present, string, non-empty) → env var (if
   present, non-empty) → hardcoded default (where one exists) → error (for
   `api_key`/`api_base`, which have no default).
4. Everything downstream (`AgentConfig`, `serve()`) is unchanged.

## Error handling

- **No config file, default path**: not an error — `{}`, identical
  behavior to today.
- **No config file, explicit `--config`/`COCORE_CONFIG_PATH`**:
  `ConfigError` naming the missing path — an explicit override that
  doesn't resolve is a likely typo, not a "no file" situation.
- **Malformed TOML** (any path): `ConfigError` wrapping the underlying
  `tomllib.TOMLDecodeError`, naming the file path, via `raise ... from e`.
  Matches this codebase's established "fail loud on corruption, never
  silently fall back" philosophy (`identity.py`'s `IdentityError`).
- **Unknown keys in the file**: ignored, not an error — forward-compatible
  and lets an operator keep unused/commented-out keys.
- **Wrong-type value for a known key** (e.g. `ram_gb = 5` under a string
  field, or a table where a string is expected): treated as absent for
  that field, falls through to env/default — not a hard error, since one
  malformed value shouldn't block every other field from resolving.

## Testing

- **`config_file.py`**: `load_config_file` against a real `tmp_path` file
  — happy path, malformed TOML → `ConfigError`, missing implicit path →
  `{}`, missing explicit path → `ConfigError`. `find_config_path`
  precedence (flag beats env beats default) using plain strings/dicts, no
  real filesystem needed.
- **`config.py`**: extend the existing `test_config.py` with
  `config_file={...}` cases alongside `env={...}` — file wins per-key, env
  fills gaps the file omits, empty-string-in-file treated as unset (same
  rule as today's empty-string-in-env handling), and full backward
  compatibility (every existing test keeps passing with no `config_file`
  argument at all).
- **`cli.py`**: at least one test confirming `--config` is wired through
  `find_config_path`/`load_config_file`/`load_config` correctly (can reuse
  the pattern from the existing `test_cli_integration.py`, injecting a
  `tmp_path` config file instead of/alongside env vars).

## Out of scope

- Secrets-manager integration (keyring, Vault, etc.) for `api_key` — plain
  TOML on local disk, same trust model as `identity.json`.
- Config file hot-reload while `serve` is running — read once at startup.
- Writing/generating a config file from the CLI (`cocore-provider init` or
  similar) — `config.toml.example` is a manually-maintained sample, not
  machine-generated.
- Nested/sectioned TOML — flat top-level table only; no per-environment
  profiles or `[dev]`/`[prod]` sections in v1.
