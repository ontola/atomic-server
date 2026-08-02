#!/usr/bin/env bash
#
# Generate a fresh Android release keystore and load it into GitHub Actions
# secrets, for the Android job in .github/workflows/tauri-release.yml.
#
# WHY THIS EXISTS
#
# desktop/gen/android/keystore.properties was committed to this PUBLIC repo in
# "Run on android #25" with the release keystore's store and key passwords in
# plain text. The .jks itself was never committed, so nothing could actually be
# signed with them — but the passwords are public and must be treated as burned.
#
# Rotating is cheap right now and expensive later: once an app is on the Play
# Store, its signing key IS its identity, and changing it means either Play App
# Signing key rotation or shipping users an app they cannot upgrade into.
#
# The generated keystore is written OUTSIDE the repo, and its passwords are
# piped straight into `gh secret set` on stdin — never passed as arguments
# (visible in `ps`), never echoed, never written to shell history.
#
# BACK UP THE .jks FILE. If you lose it you cannot ever ship an update to an
# already-published app under the same identity. A password manager or an
# encrypted backup is the right home for it; this script will not do it for you.
#
# Usage:  scripts/setup-android-signing.sh [output-path]

set -euo pipefail

KEYSTORE="${1:-$HOME/atomic-server-release.jks}"
ALIAS="atomic-server"
VALIDITY_DAYS=10950 # ~30 years. A release key that expires strands the app.
DNAME="CN=Atomic Server, OU=Ontola, O=Ontola, L=Utrecht, C=NL"

die() { echo "error: $*" >&2; exit 1; }

command -v keytool >/dev/null || die "keytool not found — install a JDK (brew install temurin, or apt install default-jdk)."
command -v gh >/dev/null || die "gh not found — install the GitHub CLI."
command -v openssl >/dev/null || die "openssl not found."

# Refuse to clobber. Overwriting a keystore that already signed a published
# build destroys the only copy of that identity.
[ -e "$KEYSTORE" ] && die "$KEYSTORE already exists. Move it aside first, or pass a different path."

gh auth status >/dev/null 2>&1 || die "gh is not authenticated — run 'gh auth login'."

repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
echo "Repository:  $repo"
echo "Keystore:    $KEYSTORE"
echo "Alias:       $ALIAS"
echo
read -r -p "Generate a NEW release signing key and overwrite the GitHub secrets? [y/N] " reply
[[ "$reply" =~ ^[Yy]$ ]] || die "aborted."

# 32 bytes of entropy, base64'd. Long enough that the password is not the weak
# part, and free of characters that need shell quoting downstream.
STORE_PASS=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)
KEY_PASS=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)

echo "Generating keystore..."
keytool -genkeypair \
  -alias "$ALIAS" \
  -keyalg RSA \
  -keysize 4096 \
  -validity "$VALIDITY_DAYS" \
  -keystore "$KEYSTORE" \
  -storetype PKCS12 \
  -storepass "$STORE_PASS" \
  -keypass "$KEY_PASS" \
  -dname "$DNAME" \
  >/dev/null 2>&1

chmod 600 "$KEYSTORE"

echo "Uploading secrets to $repo..."
# base64 -w0 is GNU; macOS base64 has no -w and does not wrap by default.
if base64 --help 2>&1 | grep -q -- '-w'; then
  b64() { base64 -w0 "$1"; }
else
  b64() { base64 "$1" | tr -d '\n'; }
fi

b64 "$KEYSTORE"        | gh secret set ANDROID_KEYSTORE_BASE64   --repo "$repo"
printf '%s' "$STORE_PASS" | gh secret set ANDROID_KEYSTORE_PASSWORD --repo "$repo"
printf '%s' "$KEY_PASS"   | gh secret set ANDROID_KEY_PASSWORD     --repo "$repo"
printf '%s' "$ALIAS"      | gh secret set ANDROID_KEY_ALIAS        --repo "$repo"

# Fingerprint is safe to print and is what the Play Console shows you, so it is
# how you confirm a build was signed with this key rather than another.
echo
echo "Done. Signing key fingerprint:"
keytool -list -v -keystore "$KEYSTORE" -storepass "$STORE_PASS" -alias "$ALIAS" 2>/dev/null \
  | grep -E "SHA1:|SHA256:" | sed 's/^/  /'

cat <<EOF

Secrets set: ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD,
             ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD

NEXT, AND DO NOT SKIP THIS:

  Back up $KEYSTORE somewhere you will still have in five years.
  It is not in the repo and it is not recoverable from GitHub — the secret is
  write-only once set. Losing it means never shipping an update to a published
  app under this identity again.

  The passwords are in the GitHub secrets and nowhere else. If you want them in
  a password manager, take them from this keystore now; they are not printed.

The old passwords from the leaked keystore.properties remain in git history.
Rotating the key makes them worthless, so rewriting history is optional — but
see the note in desktop/.gitignore if you want them gone.
EOF
