#!/bin/zsh
set -euo pipefail

if [[ "$(/usr/bin/uname -s)" != "Darwin" ]]; then
  print -u2 "Local Bridge signing only supports macOS."
  exit 1
fi

mode="${1:-make}"
if [[ "$mode" != "make" && "$mode" != "package" ]]; then
  print -u2 "Usage: $0 [make|package]"
  exit 1
fi

signing_home="${BRIDGE_LOCAL_SIGNING_HOME:-$HOME/Library/Application Support/Bridge/build-signing}"
keychain="$signing_home/BridgeLocalSigning.keychain-db"
password_file="$signing_home/keychain-password"
identity_file="$signing_home/identity-sha1"

if [[ ! -f "$keychain" || ! -f "$password_file" || ! -f "$identity_file" ]]; then
  print -u2 "Bridge local signing is not initialized."
  print -u2 "Run: npm run signing:setup-local -w @bridge/desktop"
  exit 1
fi
if [[ "$(/usr/bin/stat -f '%Lp' "$password_file")" != "600" ]]; then
  print -u2 "Refusing a local signing password file whose mode is not 0600."
  exit 1
fi

keychain_password="$(<"$password_file")"
identity_sha1="$(<"$identity_file")"
if [[ -z "$keychain_password" || ! "$identity_sha1" =~ '^[A-Fa-f0-9]{40}$' ]]; then
  print -u2 "Bridge local signing metadata is invalid."
  exit 1
fi

original_keychains=()
while IFS= read -r line; do
  normalized="$(print -r -- "$line" | /usr/bin/sed -E 's/^[[:space:]]*"//; s/"[[:space:]]*$//')"
  [[ -n "$normalized" ]] && original_keychains+=("$normalized")
done < <(/usr/bin/security list-keychains -d user)
search_list_changed=0

cleanup() {
  exit_code=$?
  trap - EXIT
  if [[ $search_list_changed -eq 1 ]]; then
    /usr/bin/security list-keychains -d user -s "${original_keychains[@]}" >/dev/null 2>&1 || true
  fi
  /usr/bin/security lock-keychain "$keychain" >/dev/null 2>&1 || true
  exit $exit_code
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

/usr/bin/security list-keychains -d user -s "$keychain" "${original_keychains[@]}"
search_list_changed=1
/usr/bin/security unlock-keychain -p "$keychain_password" "$keychain"
if ! /usr/bin/security find-identity -v -p codesigning "$keychain" | /usr/bin/grep -q "$identity_sha1"; then
  print -u2 "The configured Bridge code-signing identity is unavailable."
  exit 1
fi

BRIDGE_MAC_SIGN_IDENTITY="$identity_sha1" \
BRIDGE_MAC_SIGN_KEYCHAIN="$keychain" \
BRIDGE_MAC_SIGN_TIMESTAMP=none \
BRIDGE_MAC_LOCAL_SIGNING=1 \
npm run "$mode"

app_path="out/Bridge-darwin-arm64/Bridge.app"
if [[ ! -d "$app_path" ]]; then
  print -u2 "Packaged Bridge.app was not found at $app_path"
  exit 1
fi
requirement="$(/usr/bin/codesign -d -r- "$app_path" 2>&1)"
if [[ "$requirement" == *"cdhash H\""* ]]; then
  print -u2 "$requirement"
  print -u2 "Refusing a version-specific ad-hoc designated requirement."
  exit 1
fi

print "$requirement"
print "Stable local-signed Bridge build completed."
