#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <major|minor|patch> <base-tag>"
  echo "Example: $0 patch v1.2.3"
}

if [[ $# -ne 2 ]]; then
  usage
  exit 1
fi

bump_type="$1"
base_tag="$2"

if ! [[ "$base_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "[ERROR] base-tag must match vMAJOR.MINOR.PATCH"
  exit 1
fi

if [[ ! -f VERSION || ! -f CHANGELOG.md ]]; then
  echo "[ERROR] VERSION and CHANGELOG.md must exist in repository root"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "[ERROR] Working tree must be clean before preparing a release"
  exit 1
fi

current_version="$(tr -d '[:space:]' < VERSION)"
if ! [[ "$current_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "[ERROR] VERSION must be MAJOR.MINOR.PATCH, got: $current_version"
  exit 1
fi

IFS='.' read -r major minor patch <<< "$current_version"

case "$bump_type" in
  major)
    major=$((major + 1))
    minor=0
    patch=0
    ;;
  minor)
    minor=$((minor + 1))
    patch=0
    ;;
  patch)
    patch=$((patch + 1))
    ;;
  *)
    echo "[ERROR] bump type must be one of: major, minor, patch"
    exit 1
    ;;
esac

new_version="${major}.${minor}.${patch}"
new_tag="v${new_version}"
today="$(date +%Y-%m-%d)"

printf '%s\n' "$new_version" > VERSION

if ! grep -q '^## \[Unreleased\]' CHANGELOG.md; then
  echo "[ERROR] CHANGELOG.md must contain a '## [Unreleased]' section"
  exit 1
fi

python3 - "$new_version" "$today" <<'PY'
import sys
from pathlib import Path

version = sys.argv[1]
date = sys.argv[2]
path = Path("CHANGELOG.md")
text = path.read_text(encoding="utf-8")
marker = "## [Unreleased]"
insert = (
    f"\n\n## [{version}] - {date}\n"
    "### Added\n"
    "- [TODO] Describe new features.\n\n"
    "### Changed\n"
    "- [TODO] Describe behavior changes.\n\n"
    "### Fixed\n"
    "- [TODO] Describe bug fixes.\n"
)
idx = text.find(marker)
if idx == -1:
    raise SystemExit("Missing Unreleased section")
insert_at = idx + len(marker)
updated = text[:insert_at] + insert + text[insert_at:]
path.write_text(updated, encoding="utf-8")
PY

git add VERSION CHANGELOG.md
git commit -m "release: ${new_tag}" -m "Base-Version: ${base_tag}" -m "Target-Version: ${new_tag}"

echo "[OK] Release prepared and committed"
echo "     New version: ${new_tag}"
echo "     Next steps: git tag ${new_tag} && git push origin HEAD --follow-tags"
