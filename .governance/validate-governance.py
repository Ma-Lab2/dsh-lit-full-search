#!/usr/bin/env python3
import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

SKILL_NAME = "laser-plasma-github-governance"
DEFAULT_REQUIRED_SKILL_VERSION = "0.2.1"

SEMVER = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
TAGVER = re.compile(r"^v[0-9]+\.[0-9]+\.[0-9]+$")
BASE_TRAILER = re.compile(r"^Base-Version:\s*(v[0-9]+\.[0-9]+\.[0-9]+)\s*$", re.MULTILINE)
TARGET_TRAILER = re.compile(r"^Target-Version:\s*(v[0-9]+\.[0-9]+\.[0-9]+)\s*$", re.MULTILINE)
MANIFEST_LINE = re.compile(r"^([0-9a-f]{64})\s{2}(.+)$")

REQUIRED_FILES = [
    "VERSION",
    "CHANGELOG.md",
    "OWNERS.yaml",
    "CONTRIBUTING.md",
    "CODEOWNERS",
    "docs/HANDOVER.md",
    ".pre-commit-config.yaml",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/workflows/governance-check.yml",
    ".github/workflows/release-tag-check.yml",
    ".governance/check-commit-trailer.sh",
    ".governance/prepare-release.sh",
    ".governance/start-from-tag.sh",
    ".governance/validate-governance.py",
    ".governance/update-skill-lock.py",
    ".governance/manifest.sha256",
    ".governance/skill.lock.json",
]

PLACEHOLDER_PATTERNS = [
    re.compile(r"replace-with-project-name"),
    re.compile(r"@primary-maintainer"),
    re.compile(r"@secondary-maintainer"),
    re.compile(r"replace-with"),
]

PLACEHOLDER_SCAN_FILES = [
    "OWNERS.yaml",
    "CODEOWNERS",
    "docs/HANDOVER.md",
    "CONTRIBUTING.md",
]


def run_git(args: list[str]) -> str:
    proc = subprocess.run(["git", *args], text=True, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip())
    return proc.stdout.strip()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_semver(value: str) -> tuple[int, int, int] | None:
    if not SEMVER.match(value):
        return None
    major, minor, patch = value.split(".")
    return int(major), int(minor), int(patch)


def compare_semver(left: str, right: str) -> int:
    l = parse_semver(left)
    r = parse_semver(right)
    if l is None or r is None:
        raise ValueError("Invalid semver in comparison")
    if l < r:
        return -1
    if l > r:
        return 1
    return 0


def add_finding(findings: list[dict[str, str]], severity: str, code: str, message: str):
    findings.append({"severity": severity, "code": code, "message": message})


def check_required_files(root: Path, findings: list[dict[str, str]]):
    for rel in REQUIRED_FILES:
        if not (root / rel).exists():
            add_finding(findings, "blocker", "missing_required_file", f"Missing required file: {rel}")


def read_version(root: Path, findings: list[dict[str, str]]) -> str | None:
    path = root / "VERSION"
    if not path.exists():
        return None
    version = path.read_text(encoding="utf-8").strip()
    if not SEMVER.match(version):
        add_finding(findings, "blocker", "invalid_version", f"VERSION must match MAJOR.MINOR.PATCH, got: {version}")
        return None
    return version


def check_owners(root: Path, findings: list[dict[str, str]]):
    path = root / "OWNERS.yaml"
    if not path.exists():
        return
    text = path.read_text(encoding="utf-8")
    maintainers = re.findall(r"^\s*-\s*github:\s*@?[A-Za-z0-9-]+\s*$", text, flags=re.MULTILINE)
    if len(maintainers) < 2:
        add_finding(findings, "blocker", "insufficient_maintainers", "OWNERS.yaml must define at least two maintainers")


def check_placeholders(root: Path, findings: list[dict[str, str]], strict_placeholders: bool):
    severity = "blocker" if strict_placeholders else "warning"
    for rel in PLACEHOLDER_SCAN_FILES:
        path = root / rel
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for pattern in PLACEHOLDER_PATTERNS:
            if pattern.search(text):
                add_finding(
                    findings,
                    severity,
                    "placeholder_detected",
                    f"Placeholder text detected in {rel}: pattern '{pattern.pattern}'",
                )


def parse_manifest(manifest_path: Path) -> list[tuple[str, str]]:
    entries: list[tuple[str, str]] = []
    for idx, raw in enumerate(manifest_path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        match = MANIFEST_LINE.match(line)
        if not match:
            raise ValueError(f"Invalid manifest format at line {idx}: {raw}")
        entries.append((match.group(1), match.group(2)))
    return entries


def find_validator_path(root: Path) -> Path | None:
    candidates = [
        root / ".governance/validate-governance.py",
        root / "scripts/validate-governance.py",
    ]
    for path in candidates:
        if path.exists():
            return path
    return None


def check_skill_installation(
    root: Path,
    findings: list[dict[str, str]],
    required_skill_version: str,
) -> dict[str, Any]:
    status: dict[str, Any] = {
        "installed": False,
        "skill_name": None,
        "installed_version": None,
        "required_version": required_skill_version,
        "upgrade_required": None,
        "lock_valid": False,
        "validator_hash_ok": False,
        "template_hash_ok": False,
    }

    lock_path = root / ".governance/skill.lock.json"
    manifest_path = root / ".governance/manifest.sha256"

    if not lock_path.exists():
        add_finding(findings, "blocker", "missing_skill_lock", "Missing .governance/skill.lock.json (skill installation marker)")
        return status
    if not manifest_path.exists():
        add_finding(findings, "blocker", "missing_manifest", "Missing .governance/manifest.sha256 (skill integrity manifest)")
        return status

    try:
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        add_finding(findings, "blocker", "invalid_skill_lock", f"Invalid JSON in skill lock: {exc}")
        return status

    skill_name = str(lock.get("skill_name", ""))
    skill_version = str(lock.get("skill_version", ""))
    validator_sha = str(lock.get("validator_sha256", ""))
    template_sha = str(lock.get("template_sha256", ""))

    status["skill_name"] = skill_name or None
    status["installed_version"] = skill_version or None
    status["installed"] = bool(skill_name)

    if skill_name != SKILL_NAME:
        add_finding(findings, "blocker", "invalid_skill_name", f"skill.lock.json skill_name must be '{SKILL_NAME}', got '{skill_name}'")
    if parse_semver(skill_version) is None:
        add_finding(findings, "blocker", "invalid_skill_version", f"skill.lock.json skill_version must be MAJOR.MINOR.PATCH, got '{skill_version}'")

    if parse_semver(skill_version) and parse_semver(required_skill_version):
        if compare_semver(skill_version, required_skill_version) < 0:
            status["upgrade_required"] = True
            add_finding(
                findings,
                "blocker",
                "skill_version_outdated",
                (
                    f"Installed governance skill version {skill_version} is older than required {required_skill_version}. "
                    "Run governance upgrade and refresh .governance/skill.lock.json"
                ),
            )
        else:
            status["upgrade_required"] = False

    validator_path = find_validator_path(root)
    if validator_path is None:
        add_finding(findings, "blocker", "missing_validator", "No validator script found for hash verification")
    else:
        current_validator_sha = sha256_file(validator_path)
        if validator_sha != current_validator_sha:
            add_finding(
                findings,
                "blocker",
                "validator_hash_mismatch",
                f"validator_sha256 mismatch in skill lock for {validator_path.as_posix()}",
            )
        else:
            status["validator_hash_ok"] = True

    try:
        entries = parse_manifest(manifest_path)
    except ValueError as exc:
        add_finding(findings, "blocker", "invalid_manifest_format", str(exc))
        entries = []

    manifest_ok = True
    for expected_sha, rel in entries:
        path = root / rel
        if not path.exists():
            add_finding(findings, "blocker", "manifest_missing_file", f"Manifest file missing: {rel}")
            manifest_ok = False
            continue
        actual_sha = sha256_file(path)
        if actual_sha != expected_sha:
            add_finding(findings, "blocker", "template_hash_mismatch", f"Manifest hash mismatch for {rel}")
            manifest_ok = False

    manifest_self_sha = sha256_file(manifest_path)
    if template_sha != manifest_self_sha:
        add_finding(findings, "blocker", "manifest_lock_mismatch", "template_sha256 in lock does not match .governance/manifest.sha256")
        manifest_ok = False

    if not entries:
        add_finding(findings, "blocker", "empty_manifest", "Manifest has no entries")
        manifest_ok = False

    status["template_hash_ok"] = manifest_ok
    status["lock_valid"] = bool(
        skill_name == SKILL_NAME
        and parse_semver(skill_version) is not None
        and status["validator_hash_ok"]
        and status["template_hash_ok"]
    )

    return status


def changed_files(base_ref: str, head_ref: str) -> list[str]:
    out = run_git(["diff", "--name-only", f"{base_ref}...{head_ref}"])
    return [line for line in out.splitlines() if line.strip()]


def commits_in_range(base_ref: str, head_ref: str) -> list[str]:
    out = run_git(["rev-list", f"{base_ref}..{head_ref}"])
    return [line for line in out.splitlines() if line.strip()]


def commit_message(commit: str) -> str:
    return run_git(["show", "-s", "--format=%B", commit])


def validate_commit_trailers(
    base_ref: str,
    head_ref: str,
    expected_target: str | None,
    findings: list[dict[str, str]],
):
    commits = commits_in_range(base_ref, head_ref)
    if not commits:
        add_finding(findings, "info", "no_commits_in_range", f"No commits found between {base_ref}..{head_ref}")
        return

    target_found = False
    for commit in commits:
        msg = commit_message(commit)
        if not BASE_TRAILER.search(msg):
            add_finding(findings, "blocker", "missing_base_version_trailer", f"Commit {commit[:8]} missing Base-Version trailer")
        target_matches = TARGET_TRAILER.findall(msg)
        if target_matches:
            if expected_target and expected_target in target_matches:
                target_found = True
            for target in target_matches:
                if not TAGVER.match(target):
                    add_finding(
                        findings,
                        "blocker",
                        "invalid_target_version_trailer",
                        f"Commit {commit[:8]} has invalid Target-Version: {target}",
                    )

    if expected_target and not target_found:
        add_finding(
            findings,
            "blocker",
            "missing_expected_target_version",
            f"Expected Target-Version trailer not found in commits: {expected_target}",
        )


def validate_expected_tag(version: str | None, expected_tag: str, findings: list[dict[str, str]]):
    if not TAGVER.match(expected_tag):
        add_finding(findings, "blocker", "invalid_tag_format", f"Tag must match vMAJOR.MINOR.PATCH, got: {expected_tag}")
        return
    if version and expected_tag != f"v{version}":
        add_finding(findings, "blocker", "tag_version_mismatch", f"Tag {expected_tag} does not match VERSION v{version}")


def summarize(findings: list[dict[str, str]]) -> dict[str, int]:
    counts = {"blocker": 0, "warning": 0, "info": 0}
    for finding in findings:
        sev = finding["severity"]
        if sev in counts:
            counts[sev] += 1
    return counts


def render_text(repo_name: str, mode: str, findings: list[dict[str, str]], installation: dict[str, Any]) -> str:
    counts = summarize(findings)
    lines = [
        f"Repository: {repo_name}",
        f"Mode: {mode}",
        (
            "Installation: installed={installed}, version={version}, required={required}, "
            "upgrade_required={upgrade}, lock_valid={lock}, validator_hash_ok={vhash}, template_hash_ok={thash}"
        ).format(
            installed=installation.get("installed"),
            version=installation.get("installed_version"),
            required=installation.get("required_version"),
            upgrade=installation.get("upgrade_required"),
            lock=installation.get("lock_valid"),
            vhash=installation.get("validator_hash_ok"),
            thash=installation.get("template_hash_ok"),
        ),
        f"Summary: blockers={counts['blocker']}, warnings={counts['warning']}, info={counts['info']}",
    ]
    if not findings:
        lines.append("[OK] Governance validation passed")
        return "\n".join(lines)

    status = "[FAIL]" if counts["blocker"] else "[WARN]"
    lines.append(f"{status} Governance validation produced findings:")
    for finding in findings:
        lines.append(f"- [{finding['severity']}] ({finding['code']}) {finding['message']}")
    return "\n".join(lines)


def render_markdown(repo_name: str, mode: str, findings: list[dict[str, str]], installation: dict[str, Any]) -> str:
    counts = summarize(findings)
    lines = [
        f"# Governance Audit - {repo_name}",
        "",
        f"- Mode: `{mode}`",
        f"- Skill installed: `{installation.get('installed')}`",
        f"- Installed version: `{installation.get('installed_version')}`",
        f"- Required version: `{installation.get('required_version')}`",
        f"- Upgrade required: `{installation.get('upgrade_required')}`",
        f"- Lock valid: `{installation.get('lock_valid')}`",
        f"- Validator hash OK: `{installation.get('validator_hash_ok')}`",
        f"- Template hash OK: `{installation.get('template_hash_ok')}`",
        f"- Blockers: `{counts['blocker']}`",
        f"- Warnings: `{counts['warning']}`",
        f"- Info: `{counts['info']}`",
        "",
    ]

    if not findings:
        lines.append("No findings.")
        return "\n".join(lines)

    lines.extend([
        "| Severity | Code | Message |",
        "|---|---|---|",
    ])
    for finding in findings:
        msg = finding["message"].replace("|", "\\|")
        lines.append(f"| {finding['severity']} | {finding['code']} | {msg} |")
    return "\n".join(lines)


def render_json(repo_name: str, mode: str, findings: list[dict[str, str]], installation: dict[str, Any]) -> str:
    payload: dict[str, Any] = {
        "repo": repo_name,
        "mode": mode,
        "installation": installation,
        "summary": summarize(findings),
        "findings": findings,
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate repository governance rules")
    parser.add_argument("--mode", choices=["local", "ci", "audit"], default="local")
    parser.add_argument("--base-ref", default="")
    parser.add_argument("--head-ref", default="HEAD")
    parser.add_argument("--expected-tag", default="")
    parser.add_argument("--output", choices=["text", "json", "md"], default="text")
    parser.add_argument("--repo-name", default="")
    parser.add_argument("--strict-placeholders", choices=["true", "false"], default="")
    parser.add_argument("--required-skill-version", default=DEFAULT_REQUIRED_SKILL_VERSION)
    args = parser.parse_args()

    strict_placeholders = args.strict_placeholders == "true"
    if args.strict_placeholders == "":
        strict_placeholders = args.mode == "ci"

    root = Path.cwd()
    repo_name = args.repo_name or root.name
    findings: list[dict[str, str]] = []

    check_required_files(root, findings)
    version = read_version(root, findings)
    check_owners(root, findings)
    check_placeholders(root, findings, strict_placeholders)

    installation = check_skill_installation(root, findings, args.required_skill_version)

    if args.expected_tag:
        validate_expected_tag(version, args.expected_tag, findings)

    if args.base_ref:
        try:
            files = changed_files(args.base_ref, args.head_ref)
        except RuntimeError as exc:
            add_finding(findings, "blocker", "git_diff_failed", f"Unable to compute changed files: {exc}")
            files = []

        version_changed = "VERSION" in files
        changelog_changed = "CHANGELOG.md" in files
        expected_target = f"v{version}" if version_changed and version else None

        if version_changed and not changelog_changed:
            add_finding(findings, "blocker", "missing_changelog_update", "VERSION changed but CHANGELOG.md was not updated")

        try:
            validate_commit_trailers(args.base_ref, args.head_ref, expected_target, findings)
        except RuntimeError as exc:
            add_finding(findings, "blocker", "git_log_failed", f"Unable to validate commit trailers: {exc}")

    if args.output == "json":
        print(render_json(repo_name, args.mode, findings, installation))
    elif args.output == "md":
        print(render_markdown(repo_name, args.mode, findings, installation))
    else:
        print(render_text(repo_name, args.mode, findings, installation))

    if args.mode == "audit":
        return 0

    return 1 if summarize(findings)["blocker"] > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
