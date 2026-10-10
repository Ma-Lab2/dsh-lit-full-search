#!/usr/bin/env python3
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

SKILL_NAME = "laser-plasma-github-governance"
DEFAULT_SKILL_REPO = "https://github.com/Ma-Lab2/laser-plasma-github-governance.git"
DEFAULT_SKILL_VERSION = "0.2.1"

MANAGED_FILES = [
    ".github/workflows/governance-check.yml",
    ".github/workflows/release-tag-check.yml",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".pre-commit-config.yaml",
    ".governance/check-commit-trailer.sh",
    ".governance/prepare-release.sh",
    ".governance/start-from-tag.sh",
    ".governance/update-skill-lock.py",
    ".governance/validate-governance.py",
]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_manifest(repo_root: Path) -> Path:
    manifest_path = repo_root / ".governance/manifest.sha256"
    lines = []
    for rel in sorted(MANAGED_FILES):
        path = repo_root / rel
        if not path.exists():
            raise FileNotFoundError(f"Managed file missing for manifest: {rel}")
        lines.append(f"{sha256_file(path)}  {rel}")
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return manifest_path


def resolve_validator_path(repo_root: Path) -> Path:
    for rel in [".governance/validate-governance.py", "scripts/validate-governance.py"]:
        path = repo_root / rel
        if path.exists():
            return path
    raise FileNotFoundError("No validator script found in .governance/ or scripts/")


def write_lock(repo_root: Path, skill_version: str, skill_repo: str):
    lock_path = repo_root / ".governance/skill.lock.json"
    manifest_path = repo_root / ".governance/manifest.sha256"
    validator_path = resolve_validator_path(repo_root)

    payload = {
        "skill_name": SKILL_NAME,
        "skill_version": skill_version,
        "skill_repo": skill_repo,
        "installed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "validator_sha256": sha256_file(validator_path),
        "template_sha256": sha256_file(manifest_path),
    }

    lock_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return lock_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Update governance skill lock and manifest")
    parser.add_argument("--repo-root", default=".", help="Target repository root")
    parser.add_argument("--skill-version", default=DEFAULT_SKILL_VERSION)
    parser.add_argument("--skill-repo", default=DEFAULT_SKILL_REPO)
    args = parser.parse_args()

    repo_root = Path(args.repo_root).resolve()
    write_manifest(repo_root)
    write_lock(repo_root, args.skill_version, args.skill_repo)

    print(f"[OK] Updated {repo_root / '.governance/manifest.sha256'}")
    print(f"[OK] Updated {repo_root / '.governance/skill.lock.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
