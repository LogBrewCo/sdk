#!/usr/bin/env python3
"""Validate publish-facing metadata across every public SDK package."""

from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
from release_metadata_dotnet import validate_dotnet_packages


PUBLIC_VERSION = "0.1.0"
RUST_VERSION = "0.1.1"
RUBYGEMS_VERSION = "0.1.1"
PACKAGIST_VERSION = "0.1.1"
DOTNET_VERSION = "0.1.4"
DOTNET_OTEL_VERSION = "0.1.1"
UNITY_VERSION = "0.1.1"
MAVEN_VERSION = "0.1.1"
PUBLIC_LICENSE = "MIT"
REPO_URL = "https://github.com/LogBrewCo/sdk"
NPM_REPO_URL = "git+https://github.com/LogBrewCo/sdk.git"
MIT_LICENSE_URL = "https://opensource.org/license/mit"
PUBLIC_SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")
BRAND_LOGO_URL = "https://raw.githubusercontent.com/LogBrewCo/sdk/main/assets/brand/logbrew-logo-espresso-bg-512.png"

JS_PACKAGES = {
    "js/logbrew-angular": "@logbrew/angular",
    "js/logbrew-amqplib": "@logbrew/amqplib",
    "js/logbrew-aws-sqs": "@logbrew/aws-sqs",
    "js/logbrew-browser": "@logbrew/browser",
    "js/logbrew-bullmq": "@logbrew/bullmq",
    "js/logbrew-express": "@logbrew/express",
    "js/logbrew-fastify": "@logbrew/fastify",
    "js/logbrew-js": "@logbrew/sdk",
    "js/logbrew-kafkajs": "@logbrew/kafkajs",
    "js/logbrew-nestjs": "@logbrew/nestjs",
    "js/logbrew-next": "@logbrew/next",
    "js/logbrew-node": "@logbrew/node",
    "js/logbrew-prisma": "@logbrew/prisma",
    "js/logbrew-react": "@logbrew/react",
    "js/logbrew-react-native": "@logbrew/react-native",
    "js/logbrew-svelte": "@logbrew/svelte",
    "js/logbrew-vue": "@logbrew/vue",
}
NUGET_PACKAGES = {
    "LogBrew",
    "LogBrew.AspNetCore",
    "LogBrew.EntityFrameworkCore",
    "LogBrew.StackExchangeRedis",
    "LogBrew.OpenTelemetry",
}

OPENUPM_UNITY_METADATA = ".github/publishing/openupm-co.logbrew.unity.yml"
PUBLISH_RELEASE_WORKFLOW = ".github/workflows/publish-release.yml"
PUBLISH_PACKAGES_WORKFLOW = ".github/workflows/publish-packages.yml"
RELEASE_SAFETY_DOCS = (
    "docs/github-actions.md",
    ".github/publishing/trusted-publishers.md",
)

PYTHON_PACKAGES = {
    "python/logbrew_django": {
        "name": "logbrew-django",
        "description": "Django integration",
        "dependencies": {"Django>=5.2", "logbrew-sdk>=0.1.1,<0.2.0"},
        "package": "logbrew_django",
        "version": "0.1.2",
    },
    "python/logbrew_fastapi": {
        "name": "logbrew-fastapi",
        "description": "FastAPI integration",
        "dependencies": {"fastapi>=0.115", "httpx2>=2.3", "logbrew-sdk>=0.1.1,<0.2.0"},
        "package": "logbrew_fastapi",
        "version": "0.1.2",
    },
    "python/logbrew_flask": {
        "name": "logbrew-flask",
        "description": "Flask integration",
        "dependencies": {"Flask>=3.1", "logbrew-sdk>=0.1.1,<0.2.0"},
        "package": "logbrew_flask",
        "version": "0.1.0",
    },
    "python/logbrew_py": {
        "name": "logbrew-sdk",
        "description": "Public LogBrew Python SDK",
        "dependencies": set(),
        "package": "logbrew_sdk",
        "version": "0.1.3",
    },
}


def require(condition: bool, failures: list[str], message: str) -> None:
    if not condition:
        failures.append(message)


def require_path(root: Path, relative: str, failures: list[str]) -> Path:
    path = root / relative
    require(path.exists(), failures, f"missing required path: {relative}")
    return path


def require_equal(failures: list[str], location: str, field: str, actual: Any, expected: Any) -> None:
    require(
        actual == expected,
        failures,
        f"{location}: expected {field} {expected!r}, got {actual!r}",
    )


def require_contains(failures: list[str], location: str, field: str, actual: str | None, needle: str) -> None:
    require(
        actual is not None and needle in actual,
        failures,
        f"{location}: expected {field} to include {needle!r}, got {actual!r}",
    )


def read_json(path: Path, failures: list[str]) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        failures.append(f"{path}: invalid JSON: {exc}")
        return {}
    require(isinstance(payload, dict), failures, f"{path}: expected a JSON object")
    return payload if isinstance(payload, dict) else {}


def read_toml(path: Path, failures: list[str]) -> dict[str, Any]:
    try:
        payload = tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        failures.append(f"{path}: invalid TOML: {exc}")
        return {}
    return payload


def read_simple_yaml(path: Path, failures: list[str]) -> dict[str, Any]:
    """Parse the simple string/list/null shape used by release metadata YAML."""

    payload: dict[str, Any] = {}
    active_list: list[str] | None = None
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        failures.append(f"{path}: failed to read YAML: {exc}")
        return payload

    for line_number, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if active_list is not None and line.startswith("  - "):
            active_list.append(unquote_yaml_value(line[4:].strip()))
            continue
        active_list = None
        if ":" not in line or line.startswith(" "):
            failures.append(f"{path}:{line_number}: unsupported YAML shape")
            continue
        key, value = line.split(":", 1)
        active_key = key.strip()
        value = value.strip()
        if value == "":
            active_list = []
            payload[active_key] = active_list
        else:
            payload[active_key] = parse_simple_yaml_value(value)
    return payload


def parse_simple_yaml_value(value: str) -> Any:
    if value == "null":
        return None
    if value == "[]":
        return []
    if re.fullmatch(r"\d+", value):
        return int(value)
    return unquote_yaml_value(value)


def unquote_yaml_value(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def child(element: ET.Element, name: str) -> ET.Element | None:
    for candidate in element:
        if local_name(candidate.tag) == name:
            return candidate
    return None


def child_text(element: ET.Element, name: str) -> str | None:
    node = child(element, name)
    if node is None or node.text is None:
        return None
    return node.text.strip()


def path_text(element: ET.Element, *names: str) -> str | None:
    node: ET.Element | None = element
    for name in names:
        if node is None:
            return None
        node = child(node, name)
    if node is None or node.text is None:
        return None
    return node.text.strip()


def direct_children(element: ET.Element, name: str) -> list[ET.Element]:
    return [candidate for candidate in element if local_name(candidate.tag) == name]


def parse_xml(path: Path, failures: list[str]) -> ET.Element | None:
    try:
        return ET.parse(path).getroot()
    except ET.ParseError as exc:
        failures.append(f"{path}: invalid XML: {exc}")
        return None


def validate_js_package(
    root: Path,
    relative_dir: str,
    expected_name: str,
    failures: list[str],
    expected_version: str | None = None,
) -> None:
    location = f"{relative_dir}/package.json"
    package_dir = require_path(root, relative_dir, failures)
    manifest_path = package_dir / "package.json"
    require(manifest_path.exists(), failures, f"missing required path: {location}")
    if not manifest_path.exists():
        return

    manifest = read_json(manifest_path, failures)
    require_path(root, f"{relative_dir}/README.md", failures)
    require_equal(failures, location, "name", manifest.get("name"), expected_name)
    actual_version = manifest.get("version")
    if expected_version is None:
        require(
            isinstance(actual_version, str) and PUBLIC_SEMVER_RE.match(actual_version) is not None,
            failures,
            f"{location}: expected version to be a public semver, got {actual_version!r}",
        )
    else:
        require_equal(failures, location, "version", actual_version, expected_version)
    require_equal(failures, location, "license", manifest.get("license"), PUBLIC_LICENSE)
    require(manifest.get("private") is not True, failures, f"{location}: public SDK package must not be private")
    require_contains(failures, location, "description", manifest.get("description"), "LogBrew")
    require_equal(failures, location, "repository.type", manifest.get("repository", {}).get("type"), "git")
    require_equal(failures, location, "repository.url", manifest.get("repository", {}).get("url"), NPM_REPO_URL)
    require_equal(failures, location, "engines.node", manifest.get("engines", {}).get("node"), ">=18")
    require_equal(failures, location, "sideEffects", manifest.get("sideEffects"), False)
    require_equal(failures, location, "type", manifest.get("type"), "module")
    require_equal(failures, location, "main", manifest.get("main"), "./index.cjs")
    if manifest.get("module") is not None:
        require_equal(failures, location, "module", manifest.get("module"), "./index.js")
    require_equal(failures, location, "types", manifest.get("types"), "./index.d.ts")

    files = set(manifest.get("files", []))
    for expected_file in ("README.md", "examples", "index.js", "index.cjs", "index.d.ts", "index.d.cts"):
        require(expected_file in files, failures, f"{location}: files must include {expected_file!r}")
    if expected_name == "@logbrew/sdk":
        for expected_file in (
            "release-artifacts-common.js",
            "release-artifacts.js",
            "release-artifacts-upload.js",
            "release-artifacts-symbolication.js",
            "vite-release-artifacts.cjs",
            "vite-release-artifacts.js",
            "vite-release-artifacts.d.ts",
            "vite-release-artifacts.d.cts",
        ):
            require(expected_file in files, failures, f"{location}: files must include {expected_file!r}")
        require_equal(
            failures,
            location,
            "bin.logbrew-release-artifacts",
            manifest.get("bin", {}).get("logbrew-release-artifacts"),
            "./release-artifacts.js",
        )
        require_js_export_entry(
            failures,
            location,
            manifest,
            "./vite-release-artifacts",
            import_types="./vite-release-artifacts.d.ts",
            import_default="./vite-release-artifacts.js",
            require_types="./vite-release-artifacts.d.cts",
            require_default="./vite-release-artifacts.cjs",
        )
    if expected_name == "@logbrew/next":
        for expected_file in (
            "release-artifacts.cjs",
            "release-artifacts.js",
            "release-artifacts.d.ts",
            "release-artifacts.d.cts",
        ):
            require(expected_file in files, failures, f"{location}: files must include {expected_file!r}")
        require_js_export_entry(
            failures,
            location,
            manifest,
            "./release-artifacts",
            import_types="./release-artifacts.d.ts",
            import_default="./release-artifacts.js",
            require_types="./release-artifacts.d.cts",
            require_default="./release-artifacts.cjs",
        )
    if expected_name == "@logbrew/react-native":
        require("index.native.js" in files, failures, f"{location}: files must include 'index.native.js'")
        for expected_file in (
            "release-artifacts.cjs",
            "release-artifacts.js",
            "release-artifacts.d.ts",
            "release-artifacts.d.cts",
        ):
            require(expected_file in files, failures, f"{location}: files must include {expected_file!r}")
        require_js_export_entry(
            failures,
            location,
            manifest,
            "./release-artifacts",
            import_types="./release-artifacts.d.ts",
            import_default="./release-artifacts.js",
            require_types="./release-artifacts.d.cts",
            require_default="./release-artifacts.cjs",
        )

    if expected_name == "@logbrew/amqplib":
        amqplib_peer = path_text_from_dict(manifest, "peerDependencies", "amqplib")
        require_equal(failures, location, "peerDependencies.amqplib", amqplib_peer, ">=0.10")
    require_js_export_entry(
        failures,
        location,
        manifest,
        ".",
        import_types="./index.d.ts",
        import_default="./index.js",
        require_types="./index.d.cts",
        require_default="./index.cjs",
    )


def path_text_from_dict(payload: dict[str, Any], *keys: str) -> Any:
    value: Any = payload
    for key in keys:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def require_js_export_entry(
    failures: list[str],
    location: str,
    manifest: dict[str, Any],
    export_name: str,
    *,
    import_types: str,
    import_default: str,
    require_types: str,
    require_default: str,
) -> None:
    exports = manifest.get("exports", {}).get(export_name)
    require(isinstance(exports, dict), failures, f"{location}: exports[{export_name!r}] must be an object")
    if not isinstance(exports, dict):
        return

    expected_paths = {
        "import.types": import_types,
        "import.default": import_default,
        "require.types": require_types,
        "require.default": require_default,
    }
    for field, expected in expected_paths.items():
        require_equal(failures, location, f"exports[{export_name!r}].{field}", path_text_from_dict(exports, *field.split(".")), expected)


def validate_js_packages(root: Path, failures: list[str], npm_versions: dict[str, str] | None = None) -> None:
    npm_versions = npm_versions or {}
    actual_public_packages = {
        str(path.parent.relative_to(root))
        for path in root.glob("js/logbrew-*/package.json")
        if "examples" not in path.parts
    }
    require_equal(
        failures,
        "js",
        "public package directories",
        actual_public_packages,
        set(JS_PACKAGES),
    )
    for relative_dir, expected_name in JS_PACKAGES.items():
        validate_js_package(root, relative_dir, expected_name, failures, npm_versions.get(expected_name))


def validate_rust(root: Path, failures: list[str]) -> None:
    manifest_path = require_path(root, "rust/logbrew/Cargo.toml", failures)
    readme_path = require_path(root, "rust/logbrew/README.md", failures)
    if not manifest_path.exists():
        return
    package = read_toml(manifest_path, failures).get("package", {})
    location = "rust/logbrew/Cargo.toml"
    require_equal(failures, location, "package.name", package.get("name"), "logbrew")
    require_equal(failures, location, "package.version", package.get("version"), RUST_VERSION)
    require_equal(failures, location, "package.license", package.get("license"), PUBLIC_LICENSE)
    require_equal(failures, location, "package.repository", package.get("repository"), REPO_URL)
    require_equal(failures, location, "package.readme", package.get("readme"), "README.md")
    require_contains(failures, location, "package.description", package.get("description"), "LogBrew")
    require("logbrew" in package.get("keywords", []), failures, f"{location}: keywords must include 'logbrew'")
    readme = readme_path.read_text(encoding="utf-8") if readme_path.exists() else ""
    for needle in (
        "Metrics",
        "MetricEvent",
        "client.metric",
        "low-cardinality",
        "OpenTelemetry Span Exporter",
        "opentelemetry-exporter",
    ):
        require(needle in readme, failures, f"rust/logbrew/README.md: missing guidance {needle}")


def validate_python_package(root: Path, relative_dir: str, expected: dict[str, Any], failures: list[str]) -> None:
    manifest_path = require_path(root, f"{relative_dir}/pyproject.toml", failures)
    require_path(root, f"{relative_dir}/README.md", failures)
    if not manifest_path.exists():
        return
    project = read_toml(manifest_path, failures).get("project", {})
    package_name = expected["package"]
    location = f"{relative_dir}/pyproject.toml"
    require_equal(failures, location, "project.name", project.get("name"), expected["name"])
    require_equal(failures, location, "project.version", project.get("version"), expected.get("version", PUBLIC_VERSION))
    require_equal(failures, location, "project.license", project.get("license"), PUBLIC_LICENSE)
    require_equal(failures, location, "project.readme", project.get("readme"), "README.md")
    require_equal(failures, location, "project.requires-python", project.get("requires-python"), ">=3.11")
    require_contains(failures, location, "project.description", project.get("description"), expected["description"])
    authors = project.get("authors", [])
    require({"name": "LogBrew"} in authors, failures, f"{location}: authors must include LogBrew")
    require("logbrew" in project.get("keywords", []), failures, f"{location}: keywords must include 'logbrew'")
    require_equal(failures, location, "project.dependencies", set(project.get("dependencies", [])), expected["dependencies"])
    urls = project.get("urls", {})
    if urls:
        require_equal(failures, location, "project.urls.Repository", urls.get("Repository"), REPO_URL)
    require_path(root, f"{relative_dir}/src/{package_name}/py.typed", failures)
    require_path(root, f"{relative_dir}/src/{package_name}/examples/__main__.py", failures)


def validate_python(root: Path, failures: list[str]) -> None:
    actual_public_packages = {
        str(path.parent.relative_to(root))
        for path in root.glob("python/logbrew_*/pyproject.toml")
    }
    require_equal(
        failures,
        "python",
        "public package directories",
        actual_public_packages,
        set(PYTHON_PACKAGES),
    )
    for relative_dir, expected in PYTHON_PACKAGES.items():
        validate_python_package(root, relative_dir, expected, failures)


def validate_go(root: Path, failures: list[str]) -> None:
    go_mod_path = require_path(root, "go/logbrew/go.mod", failures)
    require_path(root, "go/logbrew/README.md", failures)
    otel_mod_path = require_path(root, "go/logbrew/otel/go.mod", failures)
    require_path(root, "go/logbrew/otel/README.md", failures)
    if not go_mod_path.exists():
        return
    content = go_mod_path.read_text(encoding="utf-8")
    require(
        re.search(r"^module github\.com/LogBrewCo/sdk/go/logbrew$", content, re.MULTILINE) is not None,
        failures,
        "go/logbrew/go.mod: unexpected module path",
    )
    require(
        re.search(r"^go 1\.24\.0$", content, re.MULTILINE) is not None,
        failures,
        "go/logbrew/go.mod: expected go 1.24.0",
    )
    if not otel_mod_path.exists():
        return
    otel_content = otel_mod_path.read_text(encoding="utf-8")
    require(
        re.search(r"^module github\.com/LogBrewCo/sdk/go/logbrew/otel$", otel_content, re.MULTILINE) is not None,
        failures,
        "go/logbrew/otel/go.mod: unexpected module path",
    )
    require(
        re.search(r"^go 1\.24\.0$", otel_content, re.MULTILINE) is not None,
        failures,
        "go/logbrew/otel/go.mod: expected go 1.24.0",
    )
    require(
        "github.com/LogBrewCo/sdk/go/logbrew v0.1.0" in otel_content,
        failures,
        "go/logbrew/otel/go.mod: expected parent LogBrew module requirement",
    )
    require(
        "go.opentelemetry.io/otel/sdk v1.41.0" in otel_content,
        failures,
        "go/logbrew/otel/go.mod: expected OpenTelemetry SDK requirement",
    )


def validate_c(root: Path, failures: list[str]) -> None:
    require_path(root, "c/logbrew-c/README.md", failures)
    header_path = require_path(root, "c/logbrew-c/include/logbrew.h", failures)
    source_path = require_path(root, "c/logbrew-c/src/logbrew.c", failures)
    require_path(root, "c/logbrew-c/src/logbrew_metric.c", failures)
    require_path(root, "c/logbrew-c/Makefile", failures)
    require_path(root, "c/logbrew-c/examples/Makefile", failures)
    require_path(root, "c/logbrew-c/examples/readme_example.c", failures)
    require_path(root, "c/logbrew-c/examples/real_user_smoke.c", failures)
    require_path(root, "c/logbrew-c/tests/test_logbrew.c", failures)
    if not header_path.exists() or not source_path.exists():
        return
    header = header_path.read_text(encoding="utf-8")
    readme = (root / "c/logbrew-c/README.md").read_text(encoding="utf-8")
    location = "c/logbrew-c/include/logbrew.h"
    for needle in (
        '#define LOGBREW_C_VERSION "0.1.0"',
        "typedef struct LogBrewClient LogBrewClient;",
        "logbrew_client_flush",
        "LogBrewRecordingTransport",
        "LogBrewMetricAttributes",
        "logbrew_client_metric",
        "LogBrewProductTimelineContext",
        "logbrew_client_product_action",
        "logbrew_client_network_milestone",
        "LogBrewHttpTransport",
        "logbrew_http_transport_init",
    ):
        require(needle in header, failures, f"{location}: missing public C SDK symbol {needle}")
    for needle in (
        "Public C99 SDK",
        "LOGBREW_API_KEY",
        "logbrew_client_flush",
        "LogBrewMetricAttributes",
        "logbrew_client_metric",
        "logbrew_client_product_action",
        "logbrew_client_network_milestone",
        "logbrew_http_transport_init",
        "copy into your own native application",
    ):
        require(needle in readme, failures, f"c/logbrew-c/README.md: missing guidance {needle}")


def validate_cpp(root: Path, failures: list[str]) -> None:
    require_path(root, "cpp/logbrew-cpp/README.md", failures)
    header_path = require_path(root, "cpp/logbrew-cpp/include/logbrew.hpp", failures)
    source_path = require_path(root, "cpp/logbrew-cpp/src/logbrew.cpp", failures)
    require_path(root, "cpp/logbrew-cpp/src/logbrew_http_transport.cpp", failures)
    require_path(root, "cpp/logbrew-cpp/Makefile", failures)
    require_path(root, "cpp/logbrew-cpp/examples/Makefile", failures)
    require_path(root, "cpp/logbrew-cpp/examples/readme_example.cpp", failures)
    require_path(root, "cpp/logbrew-cpp/examples/real_user_smoke.cpp", failures)
    require_path(root, "cpp/logbrew-cpp/tests/test_logbrew.cpp", failures)
    if not header_path.exists() or not source_path.exists():
        return
    header = header_path.read_text(encoding="utf-8")
    readme = (root / "cpp/logbrew-cpp/README.md").read_text(encoding="utf-8")
    location = "cpp/logbrew-cpp/include/logbrew.hpp"
    for needle in (
        'inline constexpr const char *version = "0.1.0"',
        "class LogBrewClient",
        "MetricAttributes",
        "metric(",
        "class HttpTransport",
        "class RecordingTransport",
        "http_transport_default_endpoint",
        "class SdkException",
    ):
        require(needle in header, failures, f"{location}: missing public C++ SDK symbol {needle}")
    for needle in (
        "Public C++17 SDK",
        "LOGBREW_API_KEY",
        "Metrics",
        "MetricAttributes",
        "client.metric",
        "low-cardinality",
        "Sending To LogBrew",
        "HttpTransport",
        "client.flush",
        "copy into your own native application",
    ):
        require(needle in readme, failures, f"cpp/logbrew-cpp/README.md: missing guidance {needle}")


def validate_objc(root: Path, failures: list[str]) -> None:
    require_path(root, "objc/logbrew-objc/README.md", failures)
    header_path = require_path(root, "objc/logbrew-objc/include/LogBrew.h", failures)
    source_path = require_path(root, "objc/logbrew-objc/src/LogBrew.m", failures)
    require_path(root, "objc/logbrew-objc/src/LBWDeliveryEngine.h", failures)
    require_path(root, "objc/logbrew-objc/src/LBWDeliveryEngine.m", failures)
    require_path(root, "objc/logbrew-objc/src/LBWHTTPTransport.m", failures)
    require_path(root, "objc/logbrew-objc/Makefile", failures)
    require_path(root, "objc/logbrew-objc/examples/Makefile", failures)
    require_path(root, "objc/logbrew-objc/examples/readme_example.m", failures)
    require_path(root, "objc/logbrew-objc/examples/real_user_smoke.m", failures)
    require_path(root, "objc/logbrew-objc/tests/test_logbrew.m", failures)
    if not header_path.exists() or not source_path.exists():
        return
    header = header_path.read_text(encoding="utf-8")
    readme = (root / "objc/logbrew-objc/README.md").read_text(encoding="utf-8")
    location = "objc/logbrew-objc/include/LogBrew.h"
    for needle in (
        "LogBrewObjectiveCVersion",
        "LBWHTTPTransportDefaultEndpoint",
        "LBWClient",
        "LBWHTTPTransport",
        "LBWRecordingTransport",
        "LBWErrorStableCodeKey",
        "metricWithID",
        "captureProductActionWithID",
        "captureNetworkMilestoneWithID",
        "LBWAutomaticDeliveryOptions",
        "LBWDeliveryHealth",
        "startAutomaticDeliveryWithTransport",
        "recoverAutomaticDeliveryWithError",
        "shutdownOwnedTransportWithError",
    ):
        require(needle in header, failures, f"{location}: missing public Objective-C SDK symbol {needle}")
    for needle in (
        "Public Objective-C SDK",
        "LOGBREW_API_KEY",
        "Metrics",
        "metricWithID",
        "low-cardinality",
        "Sending To LogBrew",
        "LBWHTTPTransport",
        "flushWithTransport",
        "copyable source",
        "startAutomaticDeliveryWithTransport",
        "deliveryHealth",
    ):
        require(needle in readme, failures, f"objc/logbrew-objc/README.md: missing guidance {needle}")


def validate_maven_pom(
    root: Path,
    relative_path: str,
    expected_artifact: str,
    expected_name: str,
    failures: list[str],
    require_compiler_release: bool = False,
) -> None:
    pom_path = require_path(root, relative_path, failures)
    require_path(root, str(Path(relative_path).parent / "README.md"), failures)
    if not pom_path.exists():
        return
    project = parse_xml(pom_path, failures)
    if project is None:
        return

    require_equal(failures, relative_path, "groupId", child_text(project, "groupId"), "co.logbrew")
    require_equal(failures, relative_path, "artifactId", child_text(project, "artifactId"), expected_artifact)
    require_equal(failures, relative_path, "version", child_text(project, "version"), MAVEN_VERSION)
    require_equal(failures, relative_path, "packaging", child_text(project, "packaging"), "jar")
    require_equal(failures, relative_path, "name", child_text(project, "name"), expected_name)
    require_equal(failures, relative_path, "url", child_text(project, "url"), REPO_URL)
    require_contains(failures, relative_path, "description", child_text(project, "description"), "LogBrew")
    require_equal(failures, relative_path, "licenses.license.name", path_text(project, "licenses", "license", "name"), PUBLIC_LICENSE)
    require_equal(failures, relative_path, "licenses.license.url", path_text(project, "licenses", "license", "url"), MIT_LICENSE_URL)
    require_equal(failures, relative_path, "developers.developer.name", path_text(project, "developers", "developer", "name"), "LogBrew")
    require_equal(failures, relative_path, "scm.url", path_text(project, "scm", "url"), REPO_URL)
    if require_compiler_release:
        require_equal(failures, relative_path, "properties.maven.compiler.release", path_text(project, "properties", "maven.compiler.release"), "11")
    if expected_artifact == "logbrew-kotlin":
        dependencies_node = child(project, "dependencies")
        dependency_nodes = [] if dependencies_node is None else list(dependencies_node)
        dependencies = {
            (
                path_text(dependency, "groupId"),
                path_text(dependency, "artifactId"),
            )
            for dependency in dependency_nodes
            if local_name(dependency.tag) == "dependency"
        }
        require(
            ("org.jetbrains.kotlin", "kotlin-stdlib") in dependencies,
            failures,
            f"{relative_path}: dependencies must include org.jetbrains.kotlin:kotlin-stdlib",
        )


def validate_unity(root: Path, failures: list[str]) -> None:
    manifest_path = require_path(root, "unity/logbrew-unity/package.json", failures)
    require_path(root, "unity/logbrew-unity/README.md", failures)
    openupm_path = require_path(root, OPENUPM_UNITY_METADATA, failures)
    if not manifest_path.exists():
        return
    manifest = read_json(manifest_path, failures)
    location = "unity/logbrew-unity/package.json"
    expected = {
        "name": "co.logbrew.unity",
        "version": UNITY_VERSION,
        "displayName": "LogBrew Unity SDK",
        "unity": "2021.3",
        "license": PUBLIC_LICENSE,
    }
    for field, value in expected.items():
        require_equal(failures, location, field, manifest.get(field), value)
    require_contains(failures, location, "description", manifest.get("description"), "LogBrew")
    require_equal(failures, location, "author.name", manifest.get("author", {}).get("name"), "LogBrew")
    require_equal(failures, location, "repository.type", manifest.get("repository", {}).get("type"), "git")
    require_equal(failures, location, "repository.url", manifest.get("repository", {}).get("url"), NPM_REPO_URL)
    require("logbrew" in manifest.get("keywords", []), failures, f"{location}: keywords must include 'logbrew'")
    samples = {sample.get("path") for sample in manifest.get("samples", []) if isinstance(sample, dict)}
    require_equal(
        failures,
        location,
        "samples paths",
        samples,
        {"Samples~/ReadmeExample", "Samples~/RealUserSmoke"},
    )
    validate_unity_openupm(manifest, openupm_path, failures)


def validate_unity_openupm(manifest: dict[str, Any], openupm_path: Path, failures: list[str]) -> None:
    if not openupm_path.exists():
        return
    metadata = read_simple_yaml(openupm_path, failures)
    location = OPENUPM_UNITY_METADATA
    expected = {
        "name": manifest.get("name"),
        "displayName": manifest.get("displayName"),
        "description": manifest.get("description"),
        "repoUrl": REPO_URL,
        "trackingMode": "git",
        "parentRepoUrl": None,
        "licenseSpdxId": manifest.get("license"),
        "licenseName": "MIT License",
        "hunter": "furkanerday",
        "gitTagPrefix": "co.logbrew.unity/",
        "gitTagIgnore": "",
        "minVersion": manifest.get("version"),
        "image": BRAND_LOGO_URL,
        "readme": "main:unity/logbrew-unity/README.md",
        "readme_zhCN": "",
        "displayName_zhCN": "",
        "description_zhCN": "",
    }
    for field, value in expected.items():
        require_equal(failures, location, field, metadata.get(field), value)
    created_at = metadata.get("createdAt")
    require(
        isinstance(created_at, int) and created_at > 0,
        failures,
        f"{location}: createdAt must be a positive Unix timestamp in milliseconds",
    )
    require_equal(failures, location, "aliases", metadata.get("aliases"), [])
    require_equal(
        failures,
        location,
        "topics",
        metadata.get("topics"),
        ["debugging-and-logging", "integration", "services", "testing", "utilities"],
    )


def validate_ruby(root: Path, failures: list[str]) -> None:
    gemspec_path = require_path(root, "ruby/logbrew-ruby/logbrew-sdk.gemspec", failures)
    require_path(root, "ruby/logbrew-ruby/README.md", failures)
    if not gemspec_path.exists():
        return
    text = gemspec_path.read_text(encoding="utf-8")
    location = "ruby/logbrew-ruby/logbrew-sdk.gemspec"
    required_patterns = {
        "name": r'spec\.name\s*=\s*"logbrew-sdk"',
        "version": rf'spec\.version\s*=\s*"{re.escape(RUBYGEMS_VERSION)}"',
        "license": rf'spec\.license\s*=\s*"{PUBLIC_LICENSE}"',
        "author": r'spec\.authors\s*=\s*\["LogBrew"\]',
        "homepage": rf'spec\.homepage\s*=\s*"{re.escape(REPO_URL)}"',
        "source_code_uri": rf'"source_code_uri"\s*=>\s*"{re.escape(REPO_URL)}"',
        "required_ruby_version": r'spec\.required_ruby_version\s*=\s*">= 2\.6"',
    }
    for field, pattern in required_patterns.items():
        require(re.search(pattern, text) is not None, failures, f"{location}: missing {field} metadata")
    require("README.md" in text, failures, f"{location}: files must include README.md")
    require("examples/Makefile" in text, failures, f"{location}: files must include examples/Makefile")


def validate_php_manifest(
    root: Path,
    relative_path: str,
    readme_path: str,
    autoload_path: str,
    failures: list[str],
) -> dict[str, Any]:
    composer_path = require_path(root, relative_path, failures)
    require_path(root, readme_path, failures)
    if not composer_path.exists():
        return {}
    manifest = read_json(composer_path, failures)
    location = relative_path
    require_equal(failures, location, "name", manifest.get("name"), "logbrew/sdk")
    require_equal(failures, location, "type", manifest.get("type"), "library")
    require_equal(failures, location, "license", manifest.get("license"), PUBLIC_LICENSE)
    require_equal(failures, location, "require.php", manifest.get("require", {}).get("php"), "^8.2")
    require_equal(failures, location, "require.psr/log", manifest.get("require", {}).get("psr/log"), "^3.0")
    require_equal(
        failures,
        location,
        "autoload.psr-4.LogBrew\\",
        manifest.get("autoload", {}).get("psr-4", {}).get("LogBrew\\"),
        autoload_path,
    )
    require_contains(failures, location, "description", manifest.get("description"), "LogBrew")
    return manifest


def validate_php(root: Path, failures: list[str]) -> None:
    validate_php_manifest(
        root,
        "php/logbrew-php/composer.json",
        "php/logbrew-php/README.md",
        "src/",
        failures,
    )
    root_manifest = validate_php_manifest(
        root,
        "composer.json",
        "php/logbrew-php/README.md",
        "php/logbrew-php/src/",
        failures,
    )
    location = "composer.json"
    require_equal(failures, location, "readme", root_manifest.get("readme"), "php/logbrew-php/README.md")
    require_equal(failures, location, "homepage", root_manifest.get("homepage"), f"{REPO_URL}/tree/main/php/logbrew-php")
    require_equal(failures, location, "support.issues", root_manifest.get("support", {}).get("issues"), f"{REPO_URL}/issues")
    require_equal(failures, location, "support.source", root_manifest.get("support", {}).get("source"), f"{REPO_URL}/tree/main/php/logbrew-php")
    require("logbrew" in root_manifest.get("keywords", []), failures, f"{location}: keywords must include 'logbrew'")


def validate_swift(root: Path, failures: list[str]) -> None:
    readme_path = require_path(root, "swift/logbrew-swift/README.md", failures)
    require_path(root, "swift/logbrew-swift/Sources/LogBrew/DeliveryEngine.swift", failures)
    require_path(root, "swift/logbrew-swift/Sources/LogBrew/DeliveryEngineAutomatic.swift", failures)
    require_path(root, "swift/logbrew-swift/Sources/LogBrew/DeliveryEngineQueue.swift", failures)
    require_path(root, "swift/logbrew-swift/Sources/LogBrew/DeliveryLifecycle.swift", failures)
    require_path(root, "swift/logbrew-swift/Tests/LogBrewTests/AutomaticDeliveryTests.swift", failures)
    require_path(root, "swift/logbrew-swift/Tests/LogBrewTests/AutomaticDeliveryLifecycleTests.swift", failures)
    require_path(root, "swift/logbrew-swift/Tests/LogBrewTests/AutomaticDeliveryTestSupport.swift", failures)
    if readme_path.exists():
        readme = readme_path.read_text(encoding="utf-8")
        for needle in ("startAutomaticDelivery", "AutomaticDeliveryOptions", "deliveryHealth"):
            require(needle in readme, failures, f"swift/logbrew-swift/README.md: missing guidance {needle}")
    manifest_expectations = {
        "swift/logbrew-swift/Package.swift": (
            'name: "logbrew-swift"',
            '.macOS(.v13)',
            '.iOS(.v15)',
            '.library(name: "LogBrew", targets: ["LogBrew"])',
            '.executable(name: "ReadmeExample", targets: ["ReadmeExample"])',
            '.executable(name: "RealUserSmoke", targets: ["RealUserSmoke"])',
            '.target(name: "LogBrew")',
            '.testTarget(name: "LogBrewTests", dependencies: ["LogBrew"])',
        ),
        "Package.swift": (
            'name: "logbrew-swift"',
            '.macOS(.v13)',
            '.iOS(.v15)',
            '.library(name: "LogBrew", targets: ["LogBrew"])',
            'path: "swift/logbrew-swift/Sources/LogBrew"',
            'path: "swift/logbrew-swift/Tests/LogBrewTests"',
        ),
    }
    for relative_path, required_entries in manifest_expectations.items():
        manifest_path = require_path(root, relative_path, failures)
        if manifest_path.exists():
            text = manifest_path.read_text(encoding="utf-8")
            for needle in required_entries:
                require(needle in text, failures, f"{relative_path}: missing manifest entry {needle}")


def validate_root(root: Path, failures: list[str]) -> None:
    require_path(root, "README.md", failures)
    require_path(root, "LICENSE", failures)
    license_text = (root / "LICENSE").read_text(encoding="utf-8") if (root / "LICENSE").exists() else ""
    require("MIT License" in license_text, failures, "LICENSE: expected MIT License text")


def validate_release_workflows(root: Path, failures: list[str]) -> None:
    workflow_path = require_path(root, PUBLISH_RELEASE_WORKFLOW, failures)
    if workflow_path.exists():
        text = workflow_path.read_text(encoding="utf-8")
        required_needles = {
            "release ref checkout": "Check out release ref",
            "scoped GitHub Release skip guard": 'if [[ "$RELEASE_TAG" == */* ]]; then',
            "scoped GitHub Release publish disable": 'publish_packages="false"',
            "repo-wide SemVer release gate": (
                'elif [[ "$RELEASE_TAG" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+'
                '(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?$ ]]; then'
            ),
            "repo-wide version guard": "python3 scripts/check_repo_wide_release_versions.py \"$REF\"",
            "publish dispatch output guard": "if: ${{ steps.release.outputs.publish_packages == 'true' }}",
            "scoped GitHub Release summary": "Skipped package publishing for scoped GitHub Release",
        }
        for description, needle in required_needles.items():
            require(needle in text, failures, f"{PUBLISH_RELEASE_WORKFLOW}: missing {description}")
    publish_packages_path = require_path(root, PUBLISH_PACKAGES_WORKFLOW, failures)
    if publish_packages_path.exists():
        publish_packages_text = publish_packages_path.read_text(encoding="utf-8")
        required_publish_needles = {
            "NuGet package version output": "id: nuget-version",
            "NuGet StackExchange.Redis pack": "dotnet pack dotnet/logbrew-dotnet/src/LogBrew.StackExchangeRedis/LogBrew.StackExchangeRedis.csproj",
            "NuGet OpenTelemetry pack": "dotnet pack dotnet/logbrew-dotnet/src/LogBrew.OpenTelemetry/LogBrew.OpenTelemetry.csproj",
            "NuGet duplicate-safe publish": "--skip-duplicate",
            "NuGet public install smoke": "bash scripts/real_user_dotnet_public_nuget_smoke.sh",
            "verify target exact version input": "verify_version:",
            "verify target exact version argument": 'verify_args+=(--version "$VERIFY_VERSION")',
            "verify target npm version override": 'append_values --npm-version "$VERIFY_NPM_VERSIONS"',
            "verify target PyPI version override": 'append_values --pypi-version "$VERIFY_PYPI_VERSIONS"',
            "verify target NuGet version override": (
                'append_values --nuget-version "$VERIFY_NUGET_VERSIONS"'
            ),
            "verify target Maven artifact filter input": "verify_maven_artifacts:",
            "verify target Maven version input": "verify_maven_versions:",
            "verify target Maven artifact filter": 'append_values --maven-artifact "$VERIFY_MAVEN_ARTIFACTS"',
            "verify target Maven version override": (
                'append_values --maven-version "$VERIFY_MAVEN_VERSIONS"'
            ),
            "verify target Maven override include": (
                '-n "$VERIFY_MAVEN_ARTIFACTS" || -n "$VERIFY_MAVEN_VERSIONS"'
            ),
            "npm initial publish opt-in": "allow_initial_npm_publish:",
            "npm first-publish guard": "missing_npm_packages",
            "npm first-publish token seam": "NPM_TOKEN",
            "npm first-publish initial value failure": (
                "allow_initial_npm_publish=true requires the release environment npm publish value"
            ),
            "npm first-publish trusted publishing warning": (
                "npm trusted publishing requires existing package pages"
            ),
            "crates.io package version output": "id: crate-version",
            "crates.io manifest version reader": "python3 scripts/read_rust_crate_version.py rust/logbrew/Cargo.toml",
            "crates.io exact public version verification": (
                '--target crates --version "${{ steps.crate-version.outputs.version }}"'
            ),
            "Maven Central public install smoke": "bash scripts/real_user_maven_central_public_smoke.sh",
            "Maven Central generated publishing-values hint": "generated Central Portal publishing values",
            "Maven Central auth preflight": "bash scripts/check_maven_central_auth_preflight.sh",
        }
        nuget_output_versions = (
            ("exact", "LogBrew", "core_version"),
            ("ASP.NET Core", "LogBrew.AspNetCore", "aspnetcore_version"),
            ("Entity Framework Core", "LogBrew.EntityFrameworkCore", "efcore_version"),
            ("StackExchange.Redis", "LogBrew.StackExchangeRedis", "redis_version"),
            ("OpenTelemetry", "LogBrew.OpenTelemetry", "otel_version"),
        )
        for label, package, output_name in nuget_output_versions:
            needle = f'--nuget-version "{package}=${{{{ steps.nuget-version.outputs.{output_name} }}}}"'
            required_publish_needles[f"NuGet {label} version output"] = f"{output_name}="
            required_publish_needles[f"NuGet {label} metadata version validation"] = needle
            required_publish_needles[f"NuGet {label} public version verification"] = needle
        for description, needle in required_publish_needles.items():
            require(needle in publish_packages_text, failures, f"{PUBLISH_PACKAGES_WORKFLOW}: missing {description}")
        for relative_dir in JS_PACKAGES:
            require(
                relative_dir in publish_packages_text,
                failures,
                f"{PUBLISH_PACKAGES_WORKFLOW}: missing npm package dir {relative_dir}",
            )
        for relative_dir in PYTHON_PACKAGES:
            require(
                relative_dir in publish_packages_text,
                failures,
                f"{PUBLISH_PACKAGES_WORKFLOW}: missing PyPI package dir {relative_dir}",
            )
    for relative_path in RELEASE_SAFETY_DOCS:
        docs_path = require_path(root, relative_path, failures)
        if not docs_path.exists():
            continue
        docs = docs_path.read_text(encoding="utf-8")
        require(
            "release tag's commit" in docs
            and "historical tags" in docs
            and "check_repo_wide_release_versions.py" in docs,
            failures,
            f"{relative_path}: missing release workflow safety warning",
        )
        if relative_path == ".github/publishing/trusted-publishers.md":
            for package_name in JS_PACKAGES.values():
                require(
                    package_name in docs,
                    failures,
                    f"{relative_path}: missing trusted publisher npm package {package_name}",
                )
            for package in PYTHON_PACKAGES.values():
                package_name = package["name"]
                require(
                    package_name in docs,
                    failures,
                    f"{relative_path}: missing trusted publisher PyPI package {package_name}",
                )


def validate(
    root: Path,
    npm_versions: dict[str, str] | None = None,
    nuget_versions: dict[str, str] | None = None,
) -> list[str]:
    failures: list[str] = []
    nuget_versions = nuget_versions or {}
    validate_root(root, failures)
    validate_release_workflows(root, failures)
    validate_js_packages(root, failures, npm_versions)
    validate_rust(root, failures)
    validate_python(root, failures)
    validate_go(root, failures)
    validate_c(root, failures)
    validate_cpp(root, failures)
    validate_objc(root, failures)
    validate_maven_pom(
        root,
        "java/logbrew-java/pom.xml",
        "logbrew-sdk",
        "LogBrew Java SDK",
        failures,
        require_compiler_release=True,
    )
    validate_dotnet_packages(
        root,
        failures,
        nuget_versions.get("LogBrew", DOTNET_VERSION),
        nuget_versions.get("LogBrew.AspNetCore", PUBLIC_VERSION),
        nuget_versions.get("LogBrew.EntityFrameworkCore", PUBLIC_VERSION),
        nuget_versions.get("LogBrew.StackExchangeRedis", PUBLIC_VERSION),
        nuget_versions.get("LogBrew.OpenTelemetry", DOTNET_OTEL_VERSION),
        PUBLIC_LICENSE,
        REPO_URL,
    )
    validate_unity(root, failures)
    validate_maven_pom(root, "kotlin/logbrew-kotlin/pom.xml", "logbrew-kotlin", "LogBrew Kotlin SDK", failures)
    validate_maven_pom(
        root,
        "kotlin/logbrew-kotlin-okhttp/pom.xml",
        "logbrew-kotlin-okhttp",
        "LogBrew Kotlin OkHttp Integration",
        failures,
    )
    validate_ruby(root, failures)
    validate_php(root, failures)
    validate_swift(root, failures)
    return failures


def parse_package_versions(raw_versions: list[str], allowed_packages: set[str] | None = None) -> dict[str, str]:
    versions: dict[str, str] = {}
    if allowed_packages is None:
        allowed_packages = set(JS_PACKAGES.values())
    for raw_version in raw_versions:
        package_name, separator, version = raw_version.partition("=")
        package_name = package_name.strip()
        version = version.strip()
        if not separator or not package_name or not version:
            raise argparse.ArgumentTypeError(
                f"expected package version in name=version form, got {raw_version!r}"
            )
        if package_name not in allowed_packages:
            raise argparse.ArgumentTypeError(f"unknown package: {package_name}")
        versions[package_name] = version
    return versions


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate release metadata across public SDK packages.")
    parser.add_argument("--root", default=Path(__file__).resolve().parents[1], type=Path)
    parser.add_argument(
        "--npm-version",
        action="append",
        default=[],
        metavar="PACKAGE=VERSION",
        help="Expected version for one npm package. May be passed more than once.",
    )
    parser.add_argument(
        "--nuget-version",
        action="append",
        default=[],
        metavar="PACKAGE=VERSION",
        help="Expected version for one NuGet package. May be passed more than once.",
    )
    args = parser.parse_args()

    try:
        npm_versions = parse_package_versions(args.npm_version)
        nuget_versions = parse_package_versions(args.nuget_version, NUGET_PACKAGES)
    except argparse.ArgumentTypeError as exc:
        parser.error(str(exc))

    failures = validate(args.root.resolve(), npm_versions, nuget_versions)
    if failures:
        for failure in failures:
            print(failure, file=sys.stderr)
        return 1
    print("release metadata ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
