#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "Usage: $0 <nginx-config> <relay-snippet> <frontend-container>" >&2
  exit 64
fi

config_path="$1"
snippet_path="$2"
frontend_container="$3"
marker="# BRIDGE_RELAY_MANAGED"

if grep -Fq "$marker" "$config_path"; then
  echo "Bridge Relay Nginx configuration is already installed."
  exit 0
fi

backup_path="${config_path}.bridge-relay-backup-$(date +%Y%m%d-%H%M%S)"
cp "$config_path" "$backup_path"
{
  printf "\n%s\n" "$marker"
  cat "$snippet_path"
} >> "$config_path"

if ! docker exec "$frontend_container" nginx -t; then
  cp "$backup_path" "$config_path"
  echo "Nginx validation failed; restored $backup_path" >&2
  exit 1
fi

docker exec "$frontend_container" nginx -s reload
echo "Installed Bridge Relay Nginx configuration; backup: $backup_path"
