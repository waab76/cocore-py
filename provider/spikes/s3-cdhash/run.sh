#!/usr/bin/env bash
# S3 spike: build + sign (hardened runtime + library validation) + run the
# cdhash probe, and confirm its cdHash equals `codesign -dvvv`.
set -euo pipefail
cd "$(dirname "$0")"

IDENT="${COCORE_SIGN_IDENTITY:-Developer ID Application: DEVIN FRANCIS GAFFNEY (4L45P7CP9M)}"

swiftc -O cdhash_probe.swift -o cdhash_probe
# Critical: runtime,library — see SPIKE_RESULTS.md. `runtime` alone leaves
# CS_REQUIRE_LV unset and libraryValidation reads false.
codesign --force --options runtime,library --timestamp=none --sign "$IDENT" cdhash_probe

./cdhash_probe | tee probe.json
echo "--- codesign ground truth ---"
codesign -dvvv cdhash_probe 2>&1 | grep -iE "CDHash=|TeamIdentifier=|flags=" | head

PROBE_CD=$(python3 -c "import json;print(json.load(open('probe.json'))['cdHash'])")
CS_CD=$(codesign -dvvv cdhash_probe 2>&1 | grep -i "^CDHash=" | head -1 | cut -d= -f2)
if [ "$PROBE_CD" = "$CS_CD" ]; then echo "cdHash MATCH ✅"; else echo "cdHash MISMATCH ❌"; exit 1; fi
