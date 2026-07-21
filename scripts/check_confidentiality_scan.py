from __future__ import annotations

import os
import re
import subprocess
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
SKIPPED_EXTENSIONS = {
    ".gif",
    ".ico",
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
}

SELF_PATH = Path("scripts/check_confidentiality_scan.py")
FORBIDDEN_PUBLIC_PLANNING_PATHS = (
    Path(".agents"),
    Path("AGENTS.md"),
    Path("CLAUDE.md"),
    Path("docs/superpowers"),
    Path("plans"),
    Path("skills-lock.json"),
)


def iter_scanned_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for current_root, dirnames, filenames in os.walk(root):
        current_path = Path(current_root)
        current_relative = current_path.relative_to(root)
        if current_relative != Path(".") and is_git_ignored(root, current_relative):
            dirnames[:] = []
            continue
        dirnames[:] = [
            dirname
            for dirname in dirnames
            if dirname not in SKIPPED_DIRS and not dirname.endswith(".egg-info")
        ]
        for filename in filenames:
            path = current_path / filename
            relative = path.relative_to(root)
            if is_git_ignored(root, relative):
                continue
            if relative == SELF_PATH:
                continue
            if filename in SKIPPED_FILES:
                continue
            if path.suffix.lower() in SKIPPED_EXTENSIONS:
                continue
            files.append(path)
    return sorted(files)


def is_git_ignored(root: Path, relative: Path) -> bool:
    result = subprocess.run(
        ["git", "-C", str(root), "check-ignore", "--quiet", "--", relative.as_posix()],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return result.returncode == 0


def validate(root: Path) -> list[str]:
    failures: list[str] = []
    failures.extend(validate_forbidden_public_planning_paths(root))
    for path in iter_scanned_files(root):
        relative = path.relative_to(root)
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            content = path.read_text(encoding="utf-8", errors="ignore")

        for line_number, line in enumerate(content.splitlines(), start=1):
            if not SENSITIVE_RE.search(line):
                continue
            if is_brand_svg_asset(relative):
                continue
            if is_allowed_match(relative, line):
                continue
            failures.append(f"./{relative.as_posix()}:{line_number}:{line}")
    failures.extend(validate_public_readme_language(root))
    return failures


def validate_forbidden_public_planning_paths(root: Path) -> list[str]:
    failures: list[str] = []
    for relative in FORBIDDEN_PUBLIC_PLANNING_PATHS:
        path = root / relative
        if not path.exists():
            continue
        if is_git_ignored(root, relative):
            continue
        failures.append(
            f"./{relative.as_posix()}: forbidden public planning file; keep agent guidance and "
            "private plans in private coordination, not public SDK repos"
        )
    return failures


def validate_public_readme_language(root: Path) -> list[str]:
    failures: list[str] = []
    for path in sorted(root.rglob("README.md")):
        relative = path.relative_to(root)
        if any(part in SKIPPED_DIRS for part in relative.parts):
            continue
        if is_git_ignored(root, relative):
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

    if is_npm_first_publish_placeholder(relative_text, line):
        return True

    if is_maven_central_preflight_secret_name_reference(relative_text, line):
        return True

    if is_github_actions_oidc_or_secret_placeholder(relative_text, line):
        return True

    if is_angular_injection_token_reference(relative_text, line):
        return True

    if is_fake_query_secret_fixture(relative_text, line):
        return True

    if is_sdk_metadata_denylist_literal(relative_text, line):
        return True

    if is_java_jdbc_metadata_denylist_literal(relative_text, line):
        return True

    if is_js_opentelemetry_privacy_denylist_literal(relative_text, line):
        return True

    if is_python_opentelemetry_privacy_denylist_literal(relative_text, line):
        return True

    if is_release_artifact_upload_verifier_reference(relative_text, line):
        return True

    if is_support_ticket_diagnostics_reference(relative_text, line):
        return True

    if is_kotlin_okhttp_phase_timing_reference(relative_text, line, terms):
        return True

    if is_go_http_phase_timing_reference(relative_text, line, terms):
        return True

    if is_kotlin_coroutine_context_reference(relative_text, line, terms):
        return True

    if is_dotnet_httpclient_host_reference(relative_text, terms):
        return True

    if relative_text.endswith(".cs") and is_dotnet_cancellation_token_reference(line):
        return True

    if relative_text.startswith("scripts/real_user_") and is_dotnet_cancellation_token_reference(line):
        return True

    if relative_text.endswith(".cs") and is_dotnet_analyzer_pragma_reference(line, terms):
        return True

    if is_dotnet_durable_delivery_reference(relative_text, line, terms):
        return True

    if relative_text.startswith("scripts/") and terms == {"cleanup"}:
        return True

    if is_sdk_instrumentation_restore_reference(relative_text, terms):
        return True

    if relative_text.endswith((".c", ".h", ".cpp", ".hpp")) and "curl_easy_cleanup" in line:
        return True

    return False


def is_brand_svg_asset(relative: Path) -> bool:
    return relative.parent.as_posix() == "assets/brand" and relative.suffix == ".svg"


def is_sdk_instrumentation_restore_reference(relative_text: str, terms: set[str]) -> bool:
    if terms != {"restore"}:
        return False
    if relative_text.startswith("js/") and relative_text.endswith((".js", ".cjs", ".mjs", ".ts", ".cts")):
        return True
    return relative_text.startswith("scripts/real_user_") and relative_text.endswith(".sh")


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


def is_npm_first_publish_placeholder(relative_text: str, line: str) -> bool:
    lower_line = line.lower()
    if relative_text == ".github/publishing/trusted-publishers.md":
        return "npm_token" in lower_line
    if relative_text == ".github/workflows/publish-packages.yml":
        allowed_fragments = (
            "npm_token: ${{ secrets.npm_token }}",
            "unset node_auth_token",
            "${npm_token:-}",
            "secret npm_token",
            "_authtoken=%s",
            "central portal user-token credentials",
            "generated central portal publishing credentials",
            "central portal publishing credentials",
            "generated central portal publishing values",
        )
        return any(fragment in lower_line for fragment in allowed_fragments)
    if relative_text == "scripts/check_release_metadata.py":
        return (
            '"npm first-publish token seam": "npm_token"' in lower_line
            or '"maven central user-token credential hint": "central portal user-token credentials"' in lower_line
            or '"maven central generated credential hint": "generated central portal publishing credentials"' in lower_line
        )
    if relative_text == "tests/test_release_metadata.py":
        return (
            "npm_token: ${{ secrets.npm_token }}" in lower_line
            or "maven central user-token credential hint" in lower_line
            or "maven central generated credential hint" in lower_line
            or "central portal user-token credentials" in lower_line
            or "generated central portal publishing credentials" in lower_line
            or "central portal publishing credentials" in lower_line
            or "central portal credentials" in lower_line
        )
    return False


def is_maven_central_preflight_secret_name_reference(relative_text: str, line: str) -> bool:
    lower_line = line.lower()
    if relative_text == "scripts/check_maven_central_auth_preflight.sh":
        allowed_fragments = (
            "central_portal_username",
            "central_portal_password",
            "generated central portal publishing values",
        )
        return any(fragment in lower_line for fragment in allowed_fragments)
    if relative_text == "tests/test_maven_central_auth_preflight.py":
        allowed_fragments = (
            "central_portal_username",
            "central_portal_password",
            "secret_values",
            "generated_token_hint",
            "requires_secret_env_names",
            "user-token",
            "secret-token",
        )
        return any(fragment in lower_line for fragment in allowed_fragments)
    if relative_text in {
        "tests/test_confidentiality_scan.py",
        "tests/test_release_metadata.py",
    }:
        allowed_fragments = (
            "central_portal_username",
            "central_portal_password",
            "user-token",
            "secret-token",
            "secret names only",
            "secret_names_only",
        )
        return any(fragment in lower_line for fragment in allowed_fragments)
    return False


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


def is_sdk_metadata_denylist_literal(relative_text: str, line: str) -> bool:
    if not relative_text.startswith("python/logbrew_py/src/logbrew_sdk/"):
        return False
    if Path(relative_text).name not in {
        "_cache_client.py",
        "_celery_client.py",
        "_db_client.py",
        "_dbapi_client.py",
        "_instrumentation.py",
        "_queue_client.py",
        "_redis_client.py",
        "_rq_client.py",
        "_sqlalchemy_client.py",
    }:
        return False
    return line.strip().strip(",").strip("\"'") in {
        "arg",
        "bind",
        "connection",
        "cookie",
        "credential",
        "dsn",
        "header",
        "host",
        "key",
        "param",
        "password",
        "port",
        "payload",
        "query",
        "secret",
        "statement",
        "token",
        "url",
        "user",
        "value",
    }


def is_java_jdbc_metadata_denylist_literal(relative_text: str, line: str) -> bool:
    if relative_text != "java/logbrew-java/src/main/java/co/logbrew/sdk/LogBrewJdbcTracing.java":
        return False
    return line.strip().strip(",").strip("\"'") in {
        "auth",
        "authorization",
        "connectionstring",
        "cookie",
        "cookies",
        "header",
        "headers",
        "host",
        "hostname",
        "key",
        "param",
        "params",
        "password",
        "query",
        "secret",
        "sql",
        "statement",
        "token",
        "url",
        "username",
        "value",
    }


def is_js_opentelemetry_privacy_denylist_literal(relative_text: str, line: str) -> bool:
    if relative_text != "js/logbrew-js/opentelemetry.cjs":
        return False
    return "SENSITIVE_OTEL_ATTRIBUTE_PATTERN" in line


def is_python_opentelemetry_privacy_denylist_literal(relative_text: str, line: str) -> bool:
    if relative_text != "python/logbrew_py/src/logbrew_sdk/_opentelemetry_processor.py":
        return False
    return (
        "SENSITIVE_OTEL_ATTRIBUTE_PATTERN" in line
        or 'r"(^|[._-])(' in line
        or 'r"private[-_]?key|' in line
    )


def is_release_artifact_upload_verifier_reference(relative_text: str, line: str) -> bool:
    if relative_text == "js/logbrew-js/release-artifacts.js" and "upload-js" in line and "--token-env" in line:
        return True
    if relative_text == "js/logbrew-js/README.md" and "--token-env LOGBREW_RELEASE_ARTIFACT_AUTH" in line:
        return True
    if relative_text in {
        "js/logbrew-js/release-artifacts-upload.js",
        "js/logbrew-react-native/release-artifacts.cjs",
        "js/logbrew-react-native/release-artifacts.d.cts",
        "js/logbrew-react-native/release-artifacts.d.ts",
        "scripts/release_artifact_upload_common.py",
        "scripts/upload_js_release_artifacts.py",
        "scripts/upload_native_release_artifacts.py",
    }:
        allowed_fragments = (
            "DEFAULT_UPLOAD_TOKEN_ENV",
            "DEFAULT_TOKEN_ENV",
            "parsed.hostname",
            "parsed.username",
            "parsed.password",
            "const hostname =",
            "hostname =",
            "hostname ===",
            "net.isIP(hostname)",
            "requireLoopbackUploadEndpoint",
            "isLoopbackUploadEndpoint",
            "if not hostname:",
            "must include a hostname",
            "hostname.lower()",
            "token: str",
            "Bearer ${token}",
            "Bearer {token}",
            '"token-env": "string"',
            "--token-env",
            "release-artifact token",
            "const tokenEnv",
            "tokenEnv?: string",
            "if (tokenEnv",
            "const token =",
            "token = os.environ.get",
            "if (!token)",
            "if not token:",
            "auth: { tokenEnv }",
            "token=token",
            "endpoint, token, body",
            "token,",
            "Authorization:",
            "Authorization",
            "postMultipart",
            "post_multipart",
        )
        return any(fragment in line for fragment in allowed_fragments)
    if relative_text == "js/logbrew-react-native/README.md" and "tokenEnv" in line:
        return True
    if relative_text in {
        "scripts/real_user_js_release_artifact_upload_smoke.sh",
        "scripts/real_user_native_release_artifact_upload_smoke.sh",
        "scripts/real_user_next_release_artifact_smoke.sh",
        "scripts/real_user_react_native_release_artifact_smoke.sh",
        "scripts/real_user_vite_release_artifact_smoke.sh",
    }:
        allowed_fragments = (
            "expected_token",
            "LOGBREW_RELEASE_ARTIFACT_TOKEN",
            "containsToken",
            "wrong-token",
            "--token-env LOGBREW_RELEASE_ARTIFACT_TOKEN_BAD",
        )
        return any(fragment in line for fragment in allowed_fragments)
    if relative_text in {
        "tests/test_js_release_artifact_upload.py",
        "tests/test_native_release_artifact_upload.py",
    } and "?token=ignored" in line:
        return True
    if relative_text in {
        "js/logbrew-js/test/release-artifacts-cli.test.js",
        "scripts/real_user_js_release_artifact_cli_smoke.sh",
    } and "token=placeholder" in line:
        return True
    if relative_text in {
        "docs/backend-contracts/release-artifact-symbolication-2026-06-13.md",
        "docs/competitor-research/source-maps-debug-symbols-2026-06-13.md",
        "js/logbrew-js/README.md",
    }:
        lower_line = line.lower()
        return "upload" in lower_line and "artifact" in lower_line
    return False


def is_support_ticket_diagnostics_reference(relative_text: str, line: str) -> bool:
    lower_line = line.lower()
    if relative_text == "scripts/real_user_go_support_ticket_smoke.sh":
        return line.strip() in {
            'token := strings.Join([]string{"lbw", "ingest", "hidden"}, "_")',
            '"apiKey":      token,',
        }

    support_docs = {
        "docs/competitor-research/js-support-ticket-diagnostics-2026-06-20.md",
        "docs/competitor-research/go-support-ticket-diagnostics-2026-06-20.md",
        "docs/competitor-research/java-support-ticket-diagnostics-2026-06-20.md",
        "docs/competitor-research/python-support-ticket-diagnostics-2026-06-20.md",
        "docs/competitor-research/ruby-support-ticket-diagnostics-2026-06-20.md",
        "docs/competitor-research/php-support-ticket-diagnostics-2026-06-20.md",
        "go/logbrew/README.md",
        "java/logbrew-java/README.md",
        "js/logbrew-js/README.md",
        "js/logbrew-js/index.d.cts",
        "js/logbrew-js/index.d.ts",
        "memory.md",
        "dotnet/logbrew-dotnet/README.md",
        "docs/competitor-research/dotnet-support-ticket-diagnostics-2026-06-20.md",
        "php/logbrew-php/README.md",
        "python/logbrew_py/README.md",
        "ruby/logbrew-ruby/README.md",
        "scripts/real_user_go_support_ticket_smoke.sh",
        "scripts/real_user_js_smoke.sh",
        "scripts/real_user_python_smoke.sh",
    }
    if relative_text in support_docs:
        return (
            "support-ticket" in lower_line
            or "support ticket" in lower_line
            or "support routes" in lower_line
            or "account/session api credentials" in lower_line
            or "diagnostic" in lower_line
            or "redact" in lower_line
            or "token-free" in lower_line
            or (
                relative_text == "docs/competitor-research/ruby-support-ticket-diagnostics-2026-06-20.md"
                and "url password removal" in lower_line
            )
            or (
                relative_text == "ruby/logbrew-ruby/README.md"
                and 'runtimeerror.new("hidden token")' in lower_line
            )
            or (
                relative_text == "docs/competitor-research/php-support-ticket-diagnostics-2026-06-20.md"
                and "masktokensinurl" in lower_line
            )
        )

    if relative_text == "php/logbrew-php/src/SupportTicketDraft.php":
        return line.strip() in {
            "'authtoken',",
            "'clientsecret',",
            "'credential',",
            "'credentials',",
            "'password',",
            "'refreshtoken',",
            "'secret',",
            "'token',",
            "return preg_match('/(?:authorization|api[_-]?key|token|secret|password|passwd|cookie)\\s*[:=]/i', $value) === 1",
            "|| preg_match('/\\blbw_(?:ingest|client|api)_[A-Za-z0-9._-]+/i', $value) === 1;",
        }

    if relative_text == "php/logbrew-php/tests/support_ticket.php":
        return line.strip() in {
            "'authorization' => 'Bearer lbw_ingest_secret_value',",
            "'endpoint' => 'https://api.example.com/v1/events?token=secret#fragment',",
            "'debugNote' => 'failed at https://api.example.com/v1/events?token=secret from /Users/example/project/.env',",
            "'cookie' => 'session=secret',",
            "'tokenText' => 'token=secret',",
            "'lbw_ingest_secret_value',",
            "'token=secret',",
            "assertTrue(($supportNested['tokenText'] ?? null) === '[redacted]', 'expected support draft nested token text redaction');",
        }

    if relative_text == "php/logbrew-php/examples/real_user_smoke.php":
        return line.strip() in {
            "'authorization' => 'Bearer lbw_ingest_secret_value',",
            "'endpoint' => 'https://api.example.com/v1/events?token=secret#fragment',",
        }

    if relative_text == "scripts/real_user_php_smoke.sh":
        return line.strip() in {
            "'authorization' => 'Bearer lbw_ingest_secret_value',",
            "'endpoint' => 'https://api.example.com/v1/events?token=secret#fragment',",
            "'debugNote' => 'failed at https://api.example.com/v1/events?token=secret from /Users/example/project/.env',",
            "'lbw_ingest_secret_value',",
            "'token=secret',",
        } or (
            "support ticket" in lower_line
            or "supportdraft" in lower_line
            or "token-free" in lower_line
            or "account/session api credentials" in lower_line
        )

    if relative_text == "ruby/logbrew-ruby/lib/logbrew/support_ticket.rb":
        return line.strip() in {
            "authtoken",
            "clientsecret",
            "credential",
            "password",
            "refreshtoken",
            "secret",
            "token",
            "value.match?(/(?:authorization|api[_-]?key|token|secret|password|passwd|cookie)\\s*[:=]/i) ||",
        }

    if relative_text == "ruby/logbrew-ruby/examples/real_user_smoke.rb":
        return line.strip() in {
            'error: RuntimeError.new("contains hidden token")',
        }

    if relative_text == "ruby/logbrew-ruby/tests/run.rb":
        return line.strip() in {
            'exception_message: "password leaked in snake case message",',
            'error: RuntimeError.new("contains hidden token"),',
            '{ token: "hidden" }',
            'assert(events[1].fetch("token") == "[redacted]", "expected support nested token redaction")',
        }

    if relative_text == "scripts/real_user_ruby_smoke.sh":
        return line.strip() in {
            'error: RuntimeError.new("hidden token"),',
        }

    if relative_text == "js/logbrew-js/support-ticket.cjs":
        return line.strip() in {
            "\"authtoken\",",
            "\"clientsecret\",",
            "\"credential\",",
            "\"password\",",
            "\"refreshtoken\",",
            "\"secret\",",
            "\"token\"",
            "return /(?:authorization|api[_-]?key|token|secret|password|passwd|cookie)\\s*[:=]/iu.test(value)",
        }

    if relative_text == "go/logbrew/support_ticket.go":
        return line.strip() in {
            '"authtoken":        {},',
            '"clientsecret":     {},',
            '"credential":       {},',
            '"credentials":      {},',
            '"password":         {},',
            '"refreshtoken":     {},',
            '"secret":           {},',
            '"token":            {},',
            '"credential",',
            '"password",',
            '"secret",',
            '"token",',
            "supportSensitiveAssignmentPattern = regexp.MustCompile(`(?i)(?:authorization|api[_-]?key|token|secret|password|passwd|cookie)\\s*[:=]`)",
            "supportTokenPattern               = regexp.MustCompile(`(?i)(?:\\bBearer\\s+[A-Za-z0-9._~+/=-]+|\\blbw_ingest_[A-Za-z0-9._-]+|\\b(?:sk|pk|xox[abprs]?)-[A-Za-z0-9_-]{10,}|\\bAKIA[0-9A-Z]{16}\\b)`)",
            "// CreateSupportTicketDraft builds a local-only, token-free support-ticket",
            "if supportSensitiveAssignmentPattern.MatchString(value) || supportTokenPattern.MatchString(value) {",
        }

    if relative_text == "java/logbrew-java/src/main/java/co/logbrew/sdk/SupportTicketDraft.java":
        return line.strip() in {
            "* credentials.</p>",
            "\"authtoken\",",
            "\"clientsecret\",",
            "\"credential\",",
            "\"credentials\",",
            "\"password\",",
            "\"refreshtoken\",",
            "\"secret\",",
            "\"token\"",
            "\"credential\",",
            "\"password\",",
            "\"secret\",",
            "\"token\"",
            "\"(?i)(?:authorization|api[_-]?key|token|secret|password|passwd|cookie)\\\\s*[:=]\"",
            "private static final Pattern TOKEN_PATTERN = Pattern.compile(",
            "if (SENSITIVE_ASSIGNMENT_PATTERN.matcher(value).find() || TOKEN_PATTERN.matcher(value).find()) {",
        }

    if relative_text == "dotnet/logbrew-dotnet/src/LogBrew/SupportTicketDraft.cs":
        return line.strip() in {
            "/// account/session API credentials.",
        }

    if relative_text == "dotnet/logbrew-dotnet/src/LogBrew/SupportDiagnosticsSanitizer.cs":
        return line.strip() in {
            "\"authtoken\",",
            "\"clientsecret\",",
            "\"credential\",",
            "\"credentials\",",
            "\"password\",",
            "\"refreshtoken\",",
            "\"secret\",",
            "\"token\",",
            "\"credential\",",
            "\"password\",",
            "\"secret\",",
            "\"token\",",
            "\"(?:authorization|api[_-]?key|token|secret|password|passwd|cookie)\\\\s*[:=]\",",
            "private static readonly Regex TokenPattern = new Regex(",
            "if (SensitiveAssignmentPattern.IsMatch(value) || TokenPattern.IsMatch(value))",
        }

    if relative_text == "python/logbrew_py/src/logbrew_sdk/_support_ticket.py":
        return line.strip() in {
            "\"authtoken\",",
            "\"clientsecret\",",
            "\"credential\",",
            "\"credentials\",",
            "\"password\",",
            "\"refreshtoken\",",
            "\"secret\",",
            "_SENSITIVE_KEY_MARKERS = (",
            "\"token\",",
            "_TOKEN_PATTERN = re.compile(",
            "\"Build a local-only, token-free support-ticket create payload draft without calling backend routes.\"",
            "r\"(?:authorization|api[_-]?key|token|secret|password|passwd|cookie)\\s*[:=]\",",
            "if _SENSITIVE_ASSIGNMENT_PATTERN.search(value) or _TOKEN_PATTERN.search(value):",
            "return normalized in _SENSITIVE_KEYS or any(marker in normalized for marker in _SENSITIVE_KEY_MARKERS)",
        }

    if relative_text == "js/logbrew-js/test/sdk.test.js":
        return line.strip() in {
            "{ token: \"hidden\" }",
            "{ token: \"[redacted]\" }",
        }

    if relative_text == "go/logbrew/support_ticket_test.go":
        return line.strip() in {
            'map[string]any{"token": "hidden"},',
            'if len(events) != 2 || events[1].(map[string]any)["token"] != "[redacted]" {',
        }

    if relative_text == "java/logbrew-java/src/test/java/co/logbrew/sdk/SupportTicketDraftTest.java":
        return line.strip() in {
            "secondEvent.put(\"token\", \"hidden\");",
            "assertEquals(\"[redacted]\", safeSecondEvent.get(\"token\"), \"event token\");",
        }

    if relative_text == "dotnet/logbrew-dotnet/tests/LogBrew.Tests/SupportTicketDraftTests.cs":
        return line.strip() in {
            "new Dictionary<string, object?> { [\"token\"] = \"hidden\" }",
            "Require((string)secondEvent[\"token\"]! == \"[redacted]\", \"expected nested token redaction\");",
        }

    if relative_text == "python/logbrew_py/tests/test_support_ticket.py":
        return line.strip() in {
            '"access_token": "hidden",',
            '"access_token": "[redacted]",',
            '"api_key": "hidden",',
            '"api_key": "[redacted]",',
            '"cookie_header": "cookie=hidden",',
            '"cookie_header": "[redacted]",',
            '"events": [{"token": "hidden"}, {"ok": True}],',
            '"events": [{"token": "[redacted]"}, {"ok": True}],',
        }

    return False


def is_kotlin_okhttp_phase_timing_reference(
    relative_text: str,
    line: str,
    terms: set[str],
) -> bool:
    if "dns" not in terms:
        return False

    lower_line = line.lower()
    ok_http_phase_paths = {
        "docs/competitor-research/kotlin-android-trace-correlation-2026-06-16.md",
        "kotlin/logbrew-kotlin-okhttp/README.md",
        "memory.md",
    }
    if relative_text in ok_http_phase_paths:
        allowed_fragments = (
            "dnsstart",
            "dnsend",
            "dns/connect",
            "dns, connect",
            "dns names",
            "dns host",
            "okhttp.phase.dnsms",
        )
        return any(
            fragment in lower_line
            for fragment in allowed_fragments
        )

    if relative_text == (
        "kotlin/logbrew-kotlin-okhttp/src/main/kotlin/co/logbrew/sdk/okhttp/"
        "LogBrewOkHttpPhaseTimings.kt"
    ):
        return "dns" in lower_line

    if relative_text == "kotlin/logbrew-kotlin-okhttp/tests/LogBrewOkHttpInterceptorTests.kt":
        return "dns" in lower_line or "okhttp.phase.dnsms" in lower_line

    return False


def is_go_http_phase_timing_reference(
    relative_text: str,
    line: str,
    terms: set[str],
) -> bool:
    if "dns" not in terms:
        return False

    lower_line = line.lower()
    go_phase_paths = {
        "docs/competitor-research/go-outbound-http-tracing-2026-06-19.md",
        "go/logbrew/README.md",
        "memory.md",
    }
    if relative_text in go_phase_paths:
        allowed_fragments = (
            "dnsstart",
            "dnsdone",
            "dns/connect",
            "dns, connect",
            "dnsms",
        )
        return any(fragment in lower_line for fragment in allowed_fragments)

    if relative_text in {
        "go/logbrew/http_client_trace.go",
        "go/logbrew/trace_correlation_test.go",
    }:
        return "dns" in lower_line

    return False


def is_kotlin_coroutine_context_reference(
    relative_text: str,
    line: str,
    terms: set[str],
) -> bool:
    if terms != {"restore"}:
        return False

    lower_line = line.lower()
    if relative_text == "kotlin/logbrew-kotlin/src/main/kotlin/co/logbrew/sdk/LogBrewCoroutines.kt":
        return "restoreThreadContext" in line

    return (
        "coroutine" in lower_line
        and "restore" in lower_line
        and relative_text
        in {
            "docs/competitor-research/kotlin-android-trace-correlation-2026-06-16.md",
            "kotlin/logbrew-kotlin/README.md",
            "memory.md",
        }
    )


def is_dotnet_httpclient_host_reference(
    relative_text: str,
    terms: set[str],
) -> bool:
    source_path = (
        "dotnet/logbrew-dotnet/src/LogBrew.HttpClient/"
        "LogBrewHttpClientFactoryCorrelation.cs"
    )
    if relative_text == source_path:
        return terms in ({"dns"}, {"dns", "hostname"})

    return terms == {"dns"} and relative_text in {
        "dotnet/logbrew-dotnet/src/LogBrew.HttpClient/README.md",
        "dotnet/logbrew-dotnet/src/LogBrew.HttpClient/examples/HttpClientFactoryCorrelation.cs",
        "dotnet/logbrew-dotnet/tests/LogBrew.HttpClient.Tests/Program.cs",
    }


def is_dotnet_cancellation_token_reference(line: str) -> bool:
    return "CancellationToken" in line or "cancellationToken" in line or ".Token" in line


def is_dotnet_analyzer_pragma_reference(line: str, terms: set[str]) -> bool:
    return terms == {"restore"} and line.strip() == "#pragma warning restore CA1031"


def is_dotnet_durable_delivery_reference(
    relative_text: str,
    line: str,
    terms: set[str],
) -> bool:
    if (
        relative_text == ".github/workflows/ci.yml"
        and terms == {"strategy"}
        and line.strip() == "strategy:"
    ):
        return True

    if relative_text == "dotnet/logbrew-dotnet/README.md" and terms == {"secret"}:
        return line == (
            "Only one process may own a store. Recovery fails closed for missing or wrong keys, "
            "corruption, unknown files, unsafe ownership, links, or replacement. Supply one primary "
            "key and a bounded list of previous keys to rotate records during recovery; new records "
            "always use the primary key. Key IDs identify keys but are not secret and must contain "
            "only stable letters, numbers, `.`, `_`, or `-`."
        )

    if relative_text == "dotnet/logbrew-dotnet/src/LogBrew/DurableEventStore.cs":
        return terms == {"cleanup"} and "CleanupAcknowledged" in line

    if relative_text == "dotnet/logbrew-dotnet/src/LogBrew/DurableStoreFileSystem.cs":
        allowed_lines = {
            "private const uint WindowsShareRead = 1;",
            "private const uint WindowsShareWrite = 2;",
            "private const uint WindowsShareDelete = 4;",
            "private const uint WindowsBackupSemantics = 0x02000000;",
            "WindowsShareRead | WindowsShareDelete,",
            "WindowsShareRead | (allowDelete ? WindowsShareDelete : 0),",
            "WindowsShareRead | WindowsShareWrite,",
            "return WindowsShareRead",
            "| (allowDelete ? WindowsShareDelete : 0)",
            "| (allowWrite ? WindowsShareWrite : 0);",
            "WindowsBackupSemantics | WindowsOpenReparsePoint,",
        }
        return line.strip() in allowed_lines

    if relative_text == "dotnet/logbrew-dotnet/tests/LogBrew.Tests/DurableDeliveryContractTests.cs":
        fixed_test_text = (
            "AcknowledgedPrefixCleanupResumesAfterExit",
            "acknowledgement marker was not durable before cleanup",
            "acknowledged prefix reappeared after cleanup restart",
            "acknowledgement cleanup restart shutdown failed",
        )
        return terms == {"cleanup"} and any(text in line for text in fixed_test_text)

    return False


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
