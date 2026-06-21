#!/usr/bin/env bash
# Build + Developer-ID-sign the APNs receiver .app for the spike.
#   ./build-receiver.sh [path-to.provisionprofile]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PROFILE="${1:-$HOME/Downloads/cocore_provisioning_profile.provisionprofile}"
IDENTITY="Developer ID Application: DEVIN FRANCIS GAFFNEY (4L45P7CP9M)"
APP="$HERE/build/APNSReceiver.app"

[ -f "$PROFILE" ] || { echo "provisioning profile not found: $PROFILE" >&2; exit 1; }

rm -rf "$HERE/build"
mkdir -p "$APP/Contents/MacOS"

echo "==> compiling receiver"
swiftc -O "$HERE/receiver/main.swift" -o "$APP/Contents/MacOS/APNSReceiver"

echo "==> assembling bundle"
cp "$HERE/receiver/Info.plist"        "$APP/Contents/Info.plist"
# The embedded profile is what makes AMFI grant the aps-environment entitlement
# to a Developer-ID app at launch.
cp "$PROFILE"                         "$APP/Contents/embedded.provisionprofile"

echo "==> signing (Developer ID + hardened runtime + entitlements)"
codesign --force --options runtime --timestamp \
    --entitlements "$HERE/receiver/entitlements.plist" \
    --sign "$IDENTITY" "$APP"

echo "==> verifying signature + entitlements"
codesign -dvvv "$APP" 2>&1 | grep -iE 'Identifier|TeamIdentifier|Authority=Developer' || true
echo "--- entitlements ---"
codesign -d --entitlements - --xml "$APP" 2>/dev/null | plutil -p - 2>/dev/null | grep -iE 'aps-environment|application-identifier|team-identifier' || true

echo "built: $APP"
