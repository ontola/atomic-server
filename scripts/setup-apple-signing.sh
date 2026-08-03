#!/usr/bin/env bash
#
# Generate Apple signing material and load it into GitHub Actions secrets, for
# the desktop (macOS) and ios jobs in .github/workflows/tauri-release.yml.
#
# WHAT THIS DOES AND DOES NOT DO
#
# Apple has no API for issuing a signing certificate without an App Store
# Connect API key, so the two round trips through developer.apple.com are
# manual by necessity: this script generates the keypair and CSR, you upload
# the CSR and download the .cer, and it takes over again from there. Everything
# either side of that — key generation, .p12 packaging, base64, secret upload —
# is automated, so no key material is ever passed as a command argument
# (visible in `ps`), echoed, or written into the repo.
#
# WHY NOT KEYCHAIN ACCESS
#
# The documented path is Certificate Assistant, which puts the private key in
# your login keychain and exports a .p12 by right-click. That works, but it is
# unscriptable, easy to do subtly wrong (exporting the certificate without the
# key produces a .p12 that fails in CI with a misleading error), and it cannot
# be repeated identically when a certificate expires. openssl gives the same
# artifact deterministically.
#
# BACK UP THE .p12 FILES. A Developer ID Application certificate cannot be
# re-downloaded with its private key, and a team is limited to five of them —
# so losing one is not a free do-over. The .p12 is the only complete copy.
#
# Usage:  scripts/setup-apple-signing.sh [--macos-only|--ios-only] [workdir]

set -euo pipefail

WORKDIR=""
DO_MACOS=true
DO_IOS=true

while [ $# -gt 0 ]; do
  case "$1" in
    --macos-only) DO_IOS=false ;;
    --ios-only)   DO_MACOS=false ;;
    -*) echo "unknown flag: $1" >&2; exit 1 ;;
    *)  WORKDIR="$1" ;;
  esac
  shift
done

WORKDIR="${WORKDIR:-$HOME/apple-signing}"

die() { echo "error: $*" >&2; exit 1; }

command -v openssl >/dev/null || die "openssl not found."
command -v gh >/dev/null || die "gh not found — install the GitHub CLI."
gh auth status >/dev/null 2>&1 || die "gh is not authenticated — run 'gh auth login'."

repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)

# OpenSSL 3 defaults PKCS#12 to AES-256-CBC + PBKDF2. macOS `security import`
# — which is exactly what the CI keychain step runs — cannot read that, and
# fails with "MAC verification failed" or a bare error -25264, neither of which
# points at the encryption algorithm. `-legacy` restores the RC2/3DES format
# Apple's tooling expects. LibreSSL (/usr/bin/openssl) already writes that
# format and has no such flag, so this must be conditional rather than always
# passed.
P12_LEGACY=()
if openssl version | grep -q '^OpenSSL 3'; then
  P12_LEGACY=(-legacy)
  echo "note: OpenSSL 3 detected — exporting .p12 in legacy format for macOS."
fi

# 0077 so the private keys below are never group- or world-readable, even for
# the instant between creation and the explicit chmod.
umask 077
mkdir -p "$WORKDIR"
cd "$WORKDIR"

echo "Repository: $repo"
echo "Workdir:    $WORKDIR"
echo

read -r -p "Apple Team ID [Q9WPWRTU7G]: " TEAM_ID
TEAM_ID="${TEAM_ID:-Q9WPWRTU7G}"
[ -n "$TEAM_ID" ] || die "a team ID is required."

# Piping on stdin keeps values out of `ps` and out of shell history, the same
# reason setup-android-signing.sh does it.
set_secret() { printf '%s' "$2" | gh secret set "$1" --repo "$repo"; }
set_secret_file() { base64 < "$2" | tr -d '\n' | gh secret set "$1" --repo "$repo"; }

# One password per .p12, 32 chars of base64 entropy with the shell-awkward
# characters removed.
gen_pass() { openssl rand -base64 32 | tr -d '/+=' | head -c 32; }

# $1 = slug, $2 = human name, $3 = the Apple portal certificate type.
# Emits: <slug>.key, <slug>.csr — then waits for you to bring back <slug>.cer.
request_cert() {
  local slug="$1" human="$2" apple_type="$3"

  if [ -e "$slug.p12" ]; then
    die "$WORKDIR/$slug.p12 already exists. Move it aside, or pass a different workdir."
  fi

  echo
  echo "──── $human ────"

  if [ -e "$slug.cer" ]; then
    echo "Found $slug.cer — skipping CSR generation."
  else
    openssl genrsa -out "$slug.key" 2048 2>/dev/null
    chmod 600 "$slug.key"
    openssl req -new -key "$slug.key" -out "$slug.csr" \
      -subj "/CN=$human/O=$TEAM_ID/C=NL"

    cat <<EOF

  1. Open https://developer.apple.com/account/resources/certificates/add
  2. Choose:  $apple_type
  3. Upload:  $WORKDIR/$slug.csr
  4. Download the .cer and save it as:
              $WORKDIR/$slug.cer

EOF
    read -r -p "Press Enter once $slug.cer is in place... " _
    [ -e "$slug.cer" ] || die "$WORKDIR/$slug.cer not found."
  fi

  # Apple serves DER; openssl needs PEM to bundle it.
  openssl x509 -inform DER -in "$slug.cer" -out "$slug.pem" 2>/dev/null \
    || openssl x509 -in "$slug.cer" -out "$slug.pem"

  PASS=$(gen_pass)

  # If anything below fails, PASS exists only in this shell and the .p12 it
  # protects is unopenable — the same trap setup-android-signing.sh needed
  # after a mid-run abort stranded a keystore.
  trap 'status=$?; [ $status -eq 0 ] && exit $status; {
    echo
    echo "!! Aborted before the secrets were stored."
    echo "!! Save this or delete $WORKDIR/'"$slug"'.p12 and re-run:"
    echo "!!   p12 password: '"$PASS"'"
  } >&2' EXIT

  openssl pkcs12 -export "${P12_LEGACY[@]}" \
    -inkey "$slug.key" -in "$slug.pem" \
    -out "$slug.p12" -passout "pass:$PASS"
  chmod 600 "$slug.p12"

  # The CN is what codesign matches on, so it has to be read from the
  # certificate rather than guessed — the exact string includes the team name
  # and ID, e.g. "Developer ID Application: Argu B.V. (Q9WPWRTU7G)".
  IDENTITY=$(openssl x509 -in "$slug.pem" -noout -subject -nameopt multiline \
    | sed -n 's/ *commonName *= //p')
  [ -n "$IDENTITY" ] || die "could not read the certificate common name from $slug.pem."
  echo "Identity: $IDENTITY"
}

if [ "$DO_MACOS" = true ]; then
  request_cert "developer-id" "Developer ID Application" "Developer ID Application"

  set_secret_file APPLE_CERTIFICATE "developer-id.p12"
  set_secret APPLE_CERTIFICATE_PASSWORD "$PASS"
  set_secret APPLE_SIGNING_IDENTITY "$IDENTITY"
  trap - EXIT
  echo "Set: APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY"

  echo
  echo "──── Notarization ────"
  cat <<'EOF'
Notarization needs an APP-SPECIFIC password, not your Apple ID password.
Generate one at https://appleid.apple.com -> Sign-In and Security ->
App-Specific Passwords. It looks like abcd-efgh-ijkl-mnop.
EOF
  read -r -p "Apple ID email: " APPLE_ID_VALUE
  read -r -s -p "App-specific password: " APPLE_PASSWORD_VALUE; echo
  [ -n "$APPLE_ID_VALUE" ] || die "an Apple ID is required."
  [ -n "$APPLE_PASSWORD_VALUE" ] || die "an app-specific password is required."

  set_secret APPLE_ID "$APPLE_ID_VALUE"
  set_secret APPLE_PASSWORD "$APPLE_PASSWORD_VALUE"
  set_secret APPLE_TEAM_ID "$TEAM_ID"
  echo "Set: APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID"
fi

if [ "$DO_IOS" = true ]; then
  request_cert "apple-distribution" "Apple Distribution" "Apple Distribution"

  set_secret_file IOS_CERTIFICATE "apple-distribution.p12"
  set_secret IOS_CERTIFICATE_PASSWORD "$PASS"
  trap - EXIT
  echo "Set: IOS_CERTIFICATE, IOS_CERTIFICATE_PASSWORD"

  echo
  echo "──── Provisioning profile ────"
  cat <<EOF
The workflow exports with --export-method app-store-connect, so this must be an
APP STORE profile (not Ad Hoc — those only install on registered UDIDs).

  1. Open https://developer.apple.com/account/resources/profiles/add
  2. Distribution -> App Store Connect
  3. App ID:       io.ontola.atomicserver
  4. Certificate:  the Apple Distribution certificate just created
  5. Download and save it as:
                   $WORKDIR/profile.mobileprovision

A profile snapshots the App ID's capabilities at creation time, so if you added
Associated Domains after making an earlier profile, regenerate it now or the
entitlement will be missing from the signed IPA.

EOF
  read -r -p "Press Enter once profile.mobileprovision is in place... " _
  [ -e "profile.mobileprovision" ] || die "$WORKDIR/profile.mobileprovision not found."

  set_secret_file IOS_MOBILE_PROVISION "profile.mobileprovision"
  echo "Set: IOS_MOBILE_PROVISION"
fi

trap - EXIT

cat <<EOF

Done.

BACK UP THESE FILES — they are not recoverable from GitHub, whose secrets are
write-only once set, and a Developer ID certificate cannot be re-downloaded
with its private key:

  $WORKDIR/*.p12          the certificates, with their private keys
  $WORKDIR/*.key          the private keys on their own

The .p12 passwords are in the GitHub secrets and nowhere else. If you want them
in a password manager, take them from the run you just did.

To verify, dispatch a build and read the preflight summary — it prints which
identities it resolved:

  gh workflow run tauri-release.yml --ref <branch> -f ref=<branch> -f upload=false
EOF
