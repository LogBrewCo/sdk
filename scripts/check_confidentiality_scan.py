from __future__ import annotations

import os
import re
import sys
from pathlib import Path


SENSITIVE_RE = re.compile(
    r"(secret|token|credential|password|private repo|customer|roadmap|strategy|runbook|"
    r"launch state|cleanup|hostnames?|internal path|ssh|terraform|dns|backup|restore)",
    re.IGNORECASE,
)
PUBLIC_README_FORBIDDEN_RE = re.compile(
    r"(real[-_ ]user|smoke|\bproof\b|\bprove\b|\bverif(?:y|ied|ier|ication)\b|"
    r"\btests?\b|\btesting\b|temporary app|temp app|disposable app|fresh app|fresh temporary app|"
    r"package checks?|repository checks?|artifact inspection|ci run|registry mechanics|"
    r"automation agents?|for automation agents|agent-facing)",
    re.IGNORECASE,
)

SKIPPED_DIRS = {
    ".agents",
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "target",
    "vendor",
}

SKIPPED_FILES = {
    "LICENSE",
}

SELF_PATH = Path("scripts/check_confidentiality_scan.py")


def iter_scanned_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for current_root, dirnames, filenames in os.walk(root):
        dirnames[:] = [dirname for dirname in dirnames if dirname not in SKIPPED_DIRS]
        current_path = Path(current_root)
        for filename in filenames:
            path = current_path / filename
            relative = path.relative_to(root)
            if relative == SELF_PATH:
                continue
            if filename in SKIPPED_FILES:
                continue
            files.append(path)
    return sorted(files)


def validate(root: Path) -> list[str]:
    failures: list[str] = []
    for path in iter_scanned_files(root):
        relative = path.relative_to(root)
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            content = path.read_text(encoding="utf-8", errors="ignore")

        for line_number, line in enumerate(content.splitlines(), start=1):
            if not SENSITIVE_RE.search(line):
                continue
            if is_allowed_match(relative, line):
                continue
            failures.append(f"./{relative.as_posix()}:{line_number}:{line}")
    failures.extend(validate_public_readme_language(root))
    return failures


def validate_public_readme_language(root: Path) -> list[str]:
    failures: list[str] = []
    for path in sorted(root.rglob("README.md")):
        relative = path.relative_to(root)
        if any(part in SKIPPED_DIRS for part in relative.parts):
            continue
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if not PUBLIC_README_FORBIDDEN_RE.search(line):
                continue
            failures.append(
                f"./{relative.as_posix()}:{line_number}:"
                "public README should describe LogBrew service integration, not SDK verification: "
                f"{line}"
            )
    return failures


def is_allowed_match(relative: Path, line: str) -> bool:
    relative_text = relative.as_posix()
    lower_line = line.lower()
    terms = {match.group(0).lower() for match in SENSITIVE_RE.finditer(line)}

    if relative_text == "docs/github-actions.md" and "long-lived registry tokens" in lower_line:
        return True

    if is_public_publishing_guidance(relative_text, line):
        return True

    if is_github_actions_oidc_or_secret_placeholder(relative_text, line):
        return True

    if is_angular_injection_token_reference(relative_text, line):
        return True

    if is_fake_query_secret_fixture(relative_text, line):
        return True

    if relative_text.endswith(".cs") and is_dotnet_cancellation_token_reference(line):
        return True

    if relative_text.startswith("scripts/") and terms == {"cleanup"}:
        return True

    return False


def is_public_publishing_guidance(relative_text: str, line: str) -> bool:
    if relative_text != ".github/publishing/trusted-publishers.md":
        return False

    allowed_fragments = (
        "after adding packagist secrets",
        "rubygems/configure-rubygems-credentials",
        "nuget_user",
        "release environment secret",
        "packagist_username",
        "packagist_api_token",
        "central_portal_password",
        "environment secrets",
        "maven central signing",
        "central portal credentials",
        "signing keys",
        "trusted publishing",
        "trusted publisher",
    )
    lower_line = line.lower()
    return any(fragment in lower_line for fragment in allowed_fragments)


def is_github_actions_oidc_or_secret_placeholder(relative_text: str, line: str) -> bool:
    if not relative_text.startswith(".github/workflows/"):
        return False

    lower_line = line.lower()
    allowed_fragments = (
        "id-token: write",
        "persist-credentials: false",
        "cargo_registry_token",
        "configure rubygems trusted publishing credentials",
        "rubygems/configure-rubygems-credentials",
        "secrets.nuget_user",
        "packagist_username: ${{ secrets.packagist_username }}",
        "packagist_api_token: ${{ secrets.packagist_api_token }}",
        "packagist_username:?set packagist_username",
        "packagist_api_token:?set packagist_api_token",
        "packagist_api_token:-",
        "apitoken=${packagist_api_token}",
        "central portal credentials",
        "maven_gpg_private_key: ${{ secrets.maven_gpg_private_key }}",
        "maven_gpg_passphrase: ${{ secrets.maven_gpg_passphrase }}",
        "maven_gpg_key_id: ${{ secrets.maven_gpg_key_id }}",
        "central_portal_username: ${{ secrets.central_portal_username }}",
        "central_portal_password: ${{ secrets.central_portal_password }}",
        "central_portal_username:?set central_portal_username",
        "central_portal_password:?set central_portal_password",
        "os.environ['central_portal_password']",
        "signing keys",
        "gh_token: ${{ github.token }}",
    )
    return any(fragment in lower_line for fragment in allowed_fragments)


def is_angular_injection_token_reference(relative_text: str, line: str) -> bool:
    if "angular" not in relative_text and relative_text != "docs/sdk-readiness-checklist.md":
        return False
    return (
        "InjectionToken" in line
        or "LOG_BREW_ANGULAR_CONTEXT" in line
        or "injection token" in line
        or "injection-token" in line
    )


def is_fake_query_secret_fixture(relative_text: str, line: str) -> bool:
    if "?token=secret" not in line:
        return False
    return (
        relative_text.startswith("scripts/real_user_")
        or (
            relative_text.startswith("js/logbrew-")
            and relative_text.endswith("/examples/real-user-smoke.mjs")
        )
    )


def is_dotnet_cancellation_token_reference(line: str) -> bool:
    return "CancellationToken" in line or ".Token" in line


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    failures = validate(root)
    if failures:
        print("\n".join(failures))
        print("confidentiality scan found unexpected matches", file=sys.stderr)
        return 1
    print("confidentiality scan ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
