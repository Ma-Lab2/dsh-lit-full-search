#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <tag> [branch-name]"
  echo "Example: $0 v1.2.3 feature/diagnostics-refactor"
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 1
fi

tag="$1"
branch_name="${2:-}"

if ! [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "[ERROR] Tag must match vMAJOR.MINOR.PATCH, got: $tag"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "[ERROR] Working tree is not clean. Commit or stash before creating branch from tag."
  exit 1
fi

git fetch --tags --prune

if ! git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "[ERROR] Tag not found: $tag"
  exit 1
fi

if [[ -z "$branch_name" ]]; then
  ts="$(date +%Y%m%d-%H%M%S)"
  branch_name="work/${tag}-${ts}"
fi

if git rev-parse -q --verify "refs/heads/$branch_name" >/dev/null; then
  echo "[ERROR] Branch already exists: $branch_name"
  exit 1
fi

git checkout -b "$branch_name" "$tag"
echo "[OK] Created branch '$branch_name' from '$tag'"
