#!/bin/sh
# Cargo target runner for `cargo tauri dev` on macOS (see desktop/.cargo/config.toml).
#
# The app keeps its agent keypair as a non-extractable CryptoKey in IndexedDB,
# which WebKit wraps under a login-keychain master key. Access to that key is
# gated on a *partition list* of code identities, and an ad-hoc, linker-signed
# binary contributes its own cdhash — a value that changes on every link. So
# every dev rebuild arrived as an unknown identity and macOS asked for the
# login password again; "Always Allow" only ever pinned the build that had just
# been replaced. (The keychain's "allow all applications" setting does not help:
# it relaxes the ACL, which is a separate gate from the partition list.)
#
# Signing with the Developer ID contributes `teamid:Q9WPWRTU7G` instead, which
# every later build shares. One "Always Allow" then holds for good.
#
# Without that certificate this is a no-op: the app still runs, ad-hoc signed,
# exactly as before.
set -e

BIN="$1"
IDENTITY="${ATOMIC_DEV_SIGNING_IDENTITY:-Developer ID Application: Argu B.V. (Q9WPWRTU7G)}"

case "${BIN##*/}" in
  atomic-server-tauri)
    if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$IDENTITY"; then
      # No hardened runtime, and get-task-allow kept, so lldb can still attach —
      # a dev build has no reason to carry release restrictions.
      codesign --force --sign "$IDENTITY" \
        --entitlements "$(dirname "$0")/dev-entitlements.plist" \
        "$BIN" >/dev/null 2>&1 ||
        echo "warning: could not sign $BIN; expect repeated keychain prompts" >&2
    fi
    ;;
esac

exec "$@"
