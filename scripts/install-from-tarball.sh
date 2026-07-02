#!/usr/bin/env bash
# Install cocore on macOS from a prebuilt tarball.
#
# This script ships inside dist/cocore-mac-arm64.tar.gz produced by
# `make mac-installer`. It assumes the binary is already built and just
# does the install/pair/service phases.
#
# Usage (after extracting the tarball on the target Mac):
#   cd cocore-mac-arm64
#   ./install.sh
#
# Same env knobs as scripts/install-mac-provider.sh; see that script
# for the full list. The most relevant ones:
#   COCORE_CONSOLE        URL of the cocore console (default: https://console.cocore.dev)
#   COCORE_ADVISOR        wss URL of the advisor   (default: wss://advisor.cocore.dev/v1/agent)
#   COCORE_PREFIX         install prefix           (default: $HOME/.local)
#   COCORE_SKIP_PAIR      1 to skip the device-pair step
#   COCORE_SKIP_SERVICE   1 to skip the LaunchAgent install

set -euo pipefail

readonly STAGE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly LABEL="dev.cocore.provider"

# Console / advisor default to whatever the bundled menu-bar app was built for
# — its Info.plist CocoreConsoleURL / CocoreAdvisorURL, stamped by
# scripts/build-mac-app.sh. A PR build bakes its PR stack there; a plain
# release leaves them unset and we fall through to prod. This keeps the CLI
# pair + LaunchAgent on the SAME stack the app targets, instead of pairing a
# PR/dev build against prod. An explicit COCORE_CONSOLE / COCORE_ADVISOR env
# still wins.
# CLI-only tarballs ship no cocore.app, and PlistBuddy reports a missing
# *file* on stdout ("File Doesn't Exist, Will Create: …"), which a bare
# capture would take as the baked value and sed into the LaunchAgent
# plist (issue #157). Require the plist to exist and the value to look
# like a URL before trusting it; otherwise emit nothing so the prod
# defaults below win.
_baked() {
  local plist="$STAGE/cocore.app/Contents/Info.plist" v
  [[ -f "$plist" ]] || return 0
  v="$(/usr/libexec/PlistBuddy -c "Print :$1" "$plist" 2>/dev/null)" || return 0
  case "$v" in
    http://*|https://*|ws://*|wss://*) printf '%s\n' "$v" ;;
  esac
  return 0
}
COCORE_CONSOLE="${COCORE_CONSOLE:-$(_baked CocoreConsoleURL)}"
COCORE_CONSOLE="${COCORE_CONSOLE:-https://console.cocore.dev}"
COCORE_ADVISOR="${COCORE_ADVISOR:-$(_baked CocoreAdvisorURL)}"
COCORE_ADVISOR="${COCORE_ADVISOR:-wss://advisor.cocore.dev/v1/agent}"
COCORE_PREFIX="${COCORE_PREFIX:-$HOME/.local}"
COCORE_LOG="${COCORE_LOG:-info}"
COCORE_SKIP_PAIR="${COCORE_SKIP_PAIR:-0}"
COCORE_SKIP_SERVICE="${COCORE_SKIP_SERVICE:-0}"
# Set by the console-served wrapper (`agent-install.sh`) when it
# invokes this script. The wrapper owns the pair + registration-
# wait + final-status output,
# so when set we suppress the redundant phases below:
#   * the "pair (skipped, COCORE_SKIP_PAIR=1)" phase header
#   * the "==> done" + "==> next steps" tail
# Stand-alone invocations of this script (operator running the
# tarball install.sh directly) keep the full output.
COCORE_WRAPPER_INVOKED="${COCORE_WRAPPER_INVOKED:-0}"
# `COCORE_INFERENCE_MODELS` is a comma-separated list of HF model
# NSIDs; the agent spawns one subprocess engine per id at serve
# time. The console-served wrapper (`agent-install.sh`) sets this
# from the interactive picker so the installer + plist + venv all
# agree on which model to advertise. `COCORE_INFERENCE_MODEL`
# (singular) is honored as a back-compat fallback for v0.4.0 plists.
COCORE_INFERENCE_MODELS="${COCORE_INFERENCE_MODELS:-${COCORE_INFERENCE_MODEL:-}}"
# Where the uv-managed Python venv lands. Default matches what
# `bootstrap-python-venv.sh` writes by default, and what
# `engines::subprocess::SubprocessEngine` looks for at runtime.
COCORE_PYTHON_VENV="${COCORE_PYTHON_VENV:-$HOME/.cocore/python}"
# Set to 1 to skip the venv bootstrap. Useful for stub-only
# protocol tests or for re-running this script after a successful
# bootstrap (since the venv is idempotent, leaving the default 0
# is harmless — it just adds a few seconds of "everything's already
# installed" output).
COCORE_SKIP_VENV="${COCORE_SKIP_VENV:-0}"

readonly INSTALL_BIN_DIR="$COCORE_PREFIX/bin"
readonly INSTALL_BIN="$INSTALL_BIN_DIR/cocore"
readonly STATE_DIR="$HOME/.cocore"
readonly LOG_DIR="$STATE_DIR/logs"
readonly LAUNCHAGENT_DIR="$HOME/Library/LaunchAgents"
readonly LAUNCHAGENT_PLIST="$LAUNCHAGENT_DIR/$LABEL.plist"
readonly STAGED_BIN="$STAGE/bin/cocore"
readonly PLIST_TEMPLATE="$STAGE/scripts/dev.cocore.provider.plist.template"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m  warn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m  error:\033[0m %s\n' "$*" >&2; exit 1; }
phase() { printf '\n'; bold "==> $*"; }

if [[ "$(uname -s)" != "Darwin" ]]; then
  die "this installer targets macOS; detected $(uname -s)"
fi
[[ -x "$STAGED_BIN" ]] || die "staged binary not found at $STAGED_BIN"
[[ -f "$PLIST_TEMPLATE" ]] || die "plist template not found at $PLIST_TEMPLATE"

phase "preflight"
note "console: $COCORE_CONSOLE"
note "advisor: $COCORE_ADVISOR"
note "prefix:  $COCORE_PREFIX"
case "$(uname -m)" in
  arm64) note "arch: arm64 (Apple Silicon)" ;;
  x86_64) warn "arch: x86_64 — Secure Enclave attestation requires Apple Silicon; will run as self-attested" ;;
esac

phase "install binary"
mkdir -p "$INSTALL_BIN_DIR" "$STATE_DIR" "$LOG_DIR"
chmod 700 "$STATE_DIR"
install -m 755 "$STAGED_BIN" "$INSTALL_BIN"
# Strip the download quarantine off the bare CLI too — the LaunchAgent and
# `cocore agent …` from a terminal both exec this ad-hoc-signed binary, and a
# quarantined ad-hoc binary trips "developer cannot be verified" on first run.
xattr -dr com.apple.quarantine "$INSTALL_BIN" 2>/dev/null || true
note "installed: $INSTALL_BIN"
case ":$PATH:" in
  *":$INSTALL_BIN_DIR:"*) ;;
  *) warn "$INSTALL_BIN_DIR is not on PATH. Add to your shell profile: export PATH=\"$INSTALL_BIN_DIR:\$PATH\"" ;;
esac

# Bootstrap the venv + uv-managed Python that the agent's
# subprocess engine spawns at runtime. v0.6.0 unified the previous
# stub vs. inference tarball variants — every install bootstraps
# the venv now, since the binary always supports real inference
# (subprocess, not PyO3) and there's no compile-time switch to
# omit it.
#
# Set COCORE_SKIP_VENV=1 to opt out (protocol-test-only installs;
# the agent will serve stub only and not advertise real models).
if [[ "$COCORE_SKIP_VENV" == "1" ]]; then
  phase "venv bootstrap (skipped, COCORE_SKIP_VENV=1)"
  note "agent will serve stub only — no real models will load."
else
  phase "bootstrap python venv via uv"
  note "this provisions ~/.cocore/python with vllm-mlx;"
  note "first run downloads ~30MB Python + ~250MB Python deps."
  # Delegate to the bootstrap script bundled alongside this one.
  # We export COCORE_PYTHON_VENV so the bootstrap writes to the
  # same path build_engines() looks for at runtime.
  if [[ -x "$STAGE/scripts/bootstrap-python-venv.sh" ]]; then
    COCORE_PYTHON_VENV="$COCORE_PYTHON_VENV" \
      "$STAGE/scripts/bootstrap-python-venv.sh"
  else
    die "bootstrap-python-venv.sh not found in tarball at $STAGE/scripts/. This tarball is broken — try re-downloading from console.cocore.dev/agent."
  fi
fi

# Pair flow. Under `curl … | sh` stdin isn't a TTY, so the
# interactive prompt the agent uses for the pair code can't be
# completed by the user. Treat "no TTY" the same as
# COCORE_SKIP_PAIR=1 — install the binary + LaunchAgent in
# "needs-pair" mode and tell the user to run `cocore agent pair`
# themselves once the install finishes.
if [[ ! -t 0 && "$COCORE_SKIP_PAIR" != "1" ]]; then
  warn "stdin is not a TTY (curl | sh?); auto-setting COCORE_SKIP_PAIR=1 so the install can finish; run 'cocore agent pair' manually after this completes."
  COCORE_SKIP_PAIR=1
fi

if [[ "$COCORE_SKIP_PAIR" == "1" ]]; then
  # Under a wrapper invocation, the wrapper does pair itself in a
  # later phase — printing "(skipped, COCORE_SKIP_PAIR=1)" here is
  # just noise that misleads the user into thinking pairing won't
  # happen. Stay silent and let the wrapper own the narrative.
  if [[ "$COCORE_WRAPPER_INVOKED" != "1" ]]; then
    phase "pair (skipped, COCORE_SKIP_PAIR=1)"
  fi
elif [[ -f "$STATE_DIR/session.json" ]]; then
  phase "pair (existing session at $STATE_DIR/session.json)"
  "$INSTALL_BIN" agent whoami || true
else
  phase "pair with ATProto identity"
  COCORE_CONSOLE="$COCORE_CONSOLE" "$INSTALL_BIN" agent pair --console "$COCORE_CONSOLE"
fi

if [[ "$COCORE_SKIP_SERVICE" == "1" ]]; then
  phase "LaunchAgent (skipped, COCORE_SKIP_SERVICE=1)"
else
  phase "install LaunchAgent"
  mkdir -p "$LAUNCHAGENT_DIR"
  sed \
    -e "s|@@LABEL@@|$LABEL|g" \
    -e "s|@@BIN@@|$INSTALL_BIN|g" \
    -e "s|@@CONSOLE@@|$COCORE_CONSOLE|g" \
    -e "s|@@ADVISOR@@|$COCORE_ADVISOR|g" \
    -e "s|@@LOG@@|$COCORE_LOG|g" \
    -e "s|@@LOG_DIR@@|$LOG_DIR|g" \
    -e "s|@@HOME@@|$HOME|g" \
    -e "s|@@INFERENCE_MODELS@@|$COCORE_INFERENCE_MODELS|g" \
    -e "s|@@PYTHON_VENV@@|$COCORE_PYTHON_VENV|g" \
    "$PLIST_TEMPLATE" > "$LAUNCHAGENT_PLIST.tmp"
  mv "$LAUNCHAGENT_PLIST.tmp" "$LAUNCHAGENT_PLIST"
  chmod 644 "$LAUNCHAGENT_PLIST"
  note "wrote $LAUNCHAGENT_PLIST"

  domain="gui/$(id -u)"
  if launchctl print "$domain/$LABEL" >/dev/null 2>&1; then
    note "previous LaunchAgent loaded; replacing"
    launchctl bootout "$domain/$LABEL" 2>/dev/null || true
  fi
  # `launchctl disable` writes a per-user denylist that persists even
  # after a `bootout`. If a previous uninstall (or our own earlier
  # boot-disable dance) left the label on that list, the next
  # `bootstrap` returns "Bootstrap failed: 5: Input/output error"
  # with no other explanation. Enable preemptively so a fresh
  # install always succeeds — `enable` on a not-disabled service
  # is a no-op.
  launchctl enable "$domain/$LABEL" 2>/dev/null || true
  # bootout sometimes returns before the domain is fully ready for the
  # next bootstrap (also surfaces as "Bootstrap failed: 5: Input/output
  # error"). Retry once after a short sleep; fail loudly if it still
  # doesn't take.
  if ! launchctl bootstrap "$domain" "$LAUNCHAGENT_PLIST"; then
    warn "launchctl bootstrap failed; retrying in 2s (likely transient bootout race)"
    sleep 2
    launchctl bootstrap "$domain" "$LAUNCHAGENT_PLIST" \
      || die "launchctl bootstrap $domain failed twice; LaunchAgent NOT loaded. Check: launchctl print $domain/$LABEL"
  fi
  launchctl kickstart -k "$domain/$LABEL" || true
  note "launchctl status:"
  launchctl print "$domain/$LABEL" 2>/dev/null | grep -E '^\s+(state|last exit code|pid)' || true
fi

# Menu-bar app. When the tarball bundles cocore.app (built by
# `make mac-release`), install it to /Applications and launch it once.
# The app is the default experience — it registers itself as a login
# item (SMAppService) so the tray icon returns after reboot, surfaces
# status/earnings/models, and drives the same headless CLI + LaunchAgent
# installed above. Skip with COCORE_SKIP_APP=1.
#
# This supersedes the earlier Rust `cocore agent menubar` companion
# (dev.cocore.menubar): the install no longer starts it, so there's a
# single tray icon. The uninstaller still tears down dev.cocore.menubar
# for machines upgrading from that build.
STAGED_APP="$STAGE/cocore.app"
COCORE_SKIP_APP="${COCORE_SKIP_APP:-0}"
if [[ -d "$STAGED_APP" && "$COCORE_SKIP_APP" != "1" ]]; then
  phase "install menu-bar app"
  rm -rf "/Applications/cocore.app"
  cp -R "$STAGED_APP" "/Applications/cocore.app"
  note "installed /Applications/cocore.app"
  # Clear the download quarantine so Gatekeeper doesn't block first launch.
  # PR / local builds are ad-hoc-signed (not notarized), so without this macOS
  # refuses to open the app and sends you to System Settings > Privacy &
  # Security. Running ./install.sh on a tarball you downloaded IS the trust
  # decision, so we pre-approve here. Recursive, so the bundled `cocore` CLI is
  # cleared too. (A real notarized release passes Gatekeeper regardless, so
  # this is a harmless no-op there.)
  xattr -dr com.apple.quarantine "/Applications/cocore.app" 2>/dev/null || true
  note "cleared Gatekeeper quarantine"
  if [[ -t 0 || "$COCORE_WRAPPER_INVOKED" == "1" ]]; then
    open "/Applications/cocore.app" 2>/dev/null \
      && note "launched — the cocore icon should appear in your menu bar" || true
  else
    note "open /Applications/cocore.app to start it (tray icon + login item)"
  fi
fi

# Stand-alone runs of this script print a final summary block;
# wrapper invocations skip it because the wrapper prints its own
# (post-pair, with the registration-wait outcome).
if [[ "$COCORE_WRAPPER_INVOKED" != "1" ]]; then
  phase "done"
  note "Menu-bar app: /Applications/cocore.app$([[ -d "$STAGED_APP" ]] || echo '  (not bundled in this tarball)')"
  note "Binary:       $INSTALL_BIN"
  note "Session:      $STATE_DIR/session.json"
  note "Logs:         $LOG_DIR/{stdout,stderr}.log"
  note "LaunchAgent:  $LAUNCHAGENT_PLIST"
fi
