#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <commit-msg-file>"
  exit 1
fi

msg_file="$1"

if [[ ! -f "$msg_file" ]]; then
  echo "[ERROR] Commit message file not found: $msg_file"
  exit 1
fi

if grep -Eq '^\[skip-governance\]' "$msg_file"; then
  exit 0
fi

if ! grep -Eq '^Base-Version:\s*v[0-9]+\.[0-9]+\.[0-9]+\s*$' "$msg_file"; then
  echo "[ERROR] Commit message must include trailer: Base-Version: vMAJOR.MINOR.PATCH"
  exit 1
fi

if grep -Eq '^Target-Version:' "$msg_file" && ! grep -Eq '^Target-Version:\s*v[0-9]+\.[0-9]+\.[0-9]+\s*$' "$msg_file"; then
  echo "[ERROR] Target-Version trailer must match vMAJOR.MINOR.PATCH when present"
  exit 1
fi

exit 0
