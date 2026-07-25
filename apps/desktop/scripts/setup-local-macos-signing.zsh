#!/bin/zsh
set -euo pipefail

if [[ "$(/usr/bin/uname -s)" != "Darwin" ]]; then
  print -u2 "Local Bridge signing setup only supports macOS."
  exit 1
fi

for command in /usr/bin/openssl /usr/bin/security; do
  if [[ ! -x "$command" ]]; then
    print -u2 "Required command is unavailable: $command"
    exit 1
  fi
done

signing_home="${BRIDGE_LOCAL_SIGNING_HOME:-$HOME/Library/Application Support/Bridge/build-signing}"
keychain="$signing_home/BridgeLocalSigning.keychain-db"
password_file="$signing_home/keychain-password"
identity_file="$signing_home/identity-sha1"
certificate_file="$signing_home/BridgeLocalCodeSigning.pem"
identity_label="Bridge Local Code Signing"

if [[ -e "$keychain" || -e "$password_file" || -e "$identity_file" ]]; then
  print -u2 "Bridge local signing already exists at:"
  print -u2 "  $signing_home"
  print -u2 "Nothing was changed. Remove it manually only if you intentionally want a new identity."
  exit 1
fi

if [[ "${BRIDGE_LOCAL_SIGNING_CONFIRM:-}" != "CREATE" ]]; then
  if [[ ! -t 0 ]]; then
    print -u2 "Interactive confirmation is required. Re-run in Terminal."
    exit 1
  fi
  /bin/cat <<'EOF'
This one-time setup creates a dedicated keychain and a self-signed certificate
trusted for code signing only. It does not install a system-wide TLS root and
does not add the private key to the repository.

The identity is suitable only for stable builds used on this Mac. It is not a
replacement for Developer ID signing or Apple notarization, and other Macs
must not treat these builds as publicly trusted software.
EOF
  read -r "answer?Type CREATE to add the local code-signing trust: "
  if [[ "$answer" != "CREATE" ]]; then
    print -u2 "Cancelled. Nothing was changed."
    exit 1
  fi
fi

umask 077
/bin/mkdir -p "$signing_home"
/bin/chmod 700 "$signing_home"
temporary="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/bridge-signing.XXXXXX")"
created_keychain=0

cleanup() {
  exit_code=$?
  /bin/rm -rf "$temporary"
  if [[ $exit_code -ne 0 && $created_keychain -eq 1 ]]; then
    /usr/bin/security delete-keychain "$keychain" >/dev/null 2>&1 || true
    /bin/rm -f "$password_file" "$identity_file" "$certificate_file"
  fi
  exit $exit_code
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

keychain_password="$(/usr/bin/openssl rand -hex 32)"
archive_password="$(/usr/bin/openssl rand -hex 32)"

/bin/cat > "$temporary/openssl.cnf" <<'EOF'
[req]
prompt = no
distinguished_name = subject
x509_extensions = codesign

[subject]
CN = Bridge Local Code Signing
O = Bridge Local Development

[codesign]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
EOF

/usr/bin/openssl req \
  -new \
  -x509 \
  -newkey rsa:3072 \
  -nodes \
  -sha256 \
  -days 3650 \
  -config "$temporary/openssl.cnf" \
  -keyout "$temporary/private-key.pem" \
  -out "$temporary/certificate.pem"

/usr/bin/openssl pkcs12 \
  -export \
  -name "$identity_label" \
  -inkey "$temporary/private-key.pem" \
  -in "$temporary/certificate.pem" \
  -passout "pass:$archive_password" \
  -out "$temporary/identity.p12"

/usr/bin/security create-keychain -p "$keychain_password" "$keychain"
created_keychain=1
/usr/bin/security set-keychain-settings -lut 21600 "$keychain"
/usr/bin/security unlock-keychain -p "$keychain_password" "$keychain"
/usr/bin/security import "$temporary/identity.p12" \
  -k "$keychain" \
  -P "$archive_password" \
  -T /usr/bin/codesign \
  -T /usr/bin/security >/dev/null
/usr/bin/security add-trusted-cert \
  -d \
  -r trustRoot \
  -p codeSign \
  -k "$keychain" \
  "$temporary/certificate.pem"
/usr/bin/security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s \
  -k "$keychain_password" \
  "$keychain" >/dev/null

identity_line="$(/usr/bin/security find-identity -v -p codesigning "$keychain" \
  | /usr/bin/grep "\"$identity_label\"" \
  | /usr/bin/head -n 1 || true)"
identity_sha1="$(print -r -- "$identity_line" | /usr/bin/awk '{print $2}')"
if [[ -z "$identity_sha1" ]]; then
  print -u2 "The new keychain does not expose a valid code-signing identity."
  exit 1
fi

print -r -- "$keychain_password" > "$password_file"
print -r -- "$identity_sha1" > "$identity_file"
/bin/cp "$temporary/certificate.pem" "$certificate_file"
/bin/chmod 600 "$password_file" "$identity_file" "$certificate_file"
/usr/bin/security lock-keychain "$keychain"
created_keychain=0

print "Bridge local signing is ready."
print "Identity: $identity_sha1"
print "Keychain: $keychain"
print "Build with: npm run make:local-signed -w @bridge/desktop"
