#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
trap 'echo "rust real-user smoke failed near line $LINENO" >&2' ERR
export CARGO_HOME="$tmp_dir/cargo-home"
mkdir -p "$CARGO_HOME"

assert_cargo_manifest_dependency() {
	local manifest_path="$1"
	local package_name="$2"
	local dependency_name="$3"
	local path_suffix="$4"
	local expected_features="${5:-}"
	python3 - "$manifest_path" "$package_name" "$dependency_name" "$path_suffix" "$expected_features" <<'PY'
import sys
import tomllib
from pathlib import Path

manifest_path, package_name, dependency_name, path_suffix, expected_features = sys.argv[1:]
manifest = tomllib.loads(Path(manifest_path).read_text())
package = manifest.get("package", {})
if package.get("name") != package_name:
    raise SystemExit(f"unexpected Cargo package name: {package.get('name')!r}")
edition = str(package.get("edition", ""))
if not edition:
    raise SystemExit("expected generated Cargo package to declare an edition")

dependencies = manifest.get("dependencies", {})
dependency = dependencies.get(dependency_name)
if not isinstance(dependency, dict):
    raise SystemExit(f"expected table dependency for {dependency_name}, found: {dependency!r}")
if dependency.get("version") not in (None, "0.1.0"):
    raise SystemExit(f"unexpected {dependency_name} version requirement: {dependency.get('version')!r}")
dependency_path = str(dependency.get("path", ""))
if not dependency_path.endswith(path_suffix):
    raise SystemExit(f"unexpected {dependency_name} path: {dependency_path!r}")
features = dependency.get("features", [])
expected = [] if not expected_features else expected_features.split(",")
if features != expected:
    raise SystemExit(f"unexpected {dependency_name} features: {features!r}")
PY
}

assert_cargo_manifest_without_dependency() {
	local manifest_path="$1"
	local package_name="$2"
	local dependency_name="$3"
	python3 - "$manifest_path" "$package_name" "$dependency_name" <<'PY'
import sys
import tomllib
from pathlib import Path

manifest_path, package_name, dependency_name = sys.argv[1:]
manifest = tomllib.loads(Path(manifest_path).read_text())
package = manifest.get("package", {})
if package.get("name") != package_name:
    raise SystemExit(f"unexpected Cargo package name: {package.get('name')!r}")
if not str(package.get("edition", "")):
    raise SystemExit("expected generated Cargo package to declare an edition")
if dependency_name in manifest.get("dependencies", {}):
    raise SystemExit(f"expected Cargo.toml to remove {dependency_name} dependency")
PY
}

assert_cargo_tree_package() {
	local tree_path="$1"
	local package_name="$2"
	local expected_version="$3"
	local expected_path_suffix="${4:-}"
	python3 - "$tree_path" "$package_name" "$expected_version" "$expected_path_suffix" <<'PY'
import sys
from pathlib import Path

tree_path, package_name, expected_version, expected_path_suffix = sys.argv[1:]
tree_text = Path(tree_path).read_text()
needle = f"{package_name} v{expected_version}"
matches = [line for line in tree_text.splitlines() if needle in line]
if not matches:
    raise SystemExit(f"expected cargo tree to contain {needle!r}\n{tree_text}")
if expected_path_suffix and not any(expected_path_suffix in line for line in matches):
    raise SystemExit(
        f"expected {needle!r} cargo tree line to include {expected_path_suffix!r}\n"
        + "\n".join(matches)
    )
PY
}

cargo package --allow-dirty --no-verify --manifest-path "$repo_root/rust/logbrew/Cargo.toml" --target-dir "$tmp_dir/cargo-package" >/dev/null
crate_path="$tmp_dir/cargo-package/package/logbrew-0.1.0.crate"
test -f "$crate_path"
tar -tf "$crate_path" > "$tmp_dir/crate-contents.txt"
grep -q '^logbrew-0.1.0/README.md$' "$tmp_dir/crate-contents.txt"
grep -q '^logbrew-0.1.0/Cargo.toml$' "$tmp_dir/crate-contents.txt"
grep -q '^logbrew-0.1.0/src/product_timeline.rs$' "$tmp_dir/crate-contents.txt"
grep -q '^logbrew-0.1.0/examples/readme_example.rs$' "$tmp_dir/crate-contents.txt"
grep -q '^logbrew-0.1.0/examples/real_user_smoke.rs$' "$tmp_dir/crate-contents.txt"
grep -q '^logbrew-0.1.0/examples/Makefile$' "$tmp_dir/crate-contents.txt"
crate_readme="$tmp_dir/crate-readme.md"
tar -xOf "$crate_path" logbrew-0.1.0/README.md > "$crate_readme"
grep -q 'cargo add logbrew' "$crate_readme"
grep -q 'cargo add logbrew --features http' "$crate_readme"
grep -q 'LOGBREW_API_KEY' "$crate_readme"
grep -q 'preview_json' "$crate_readme"
grep -q 'HttpTransport' "$crate_readme"
grep -q 'DEFAULT_HTTP_ENDPOINT' "$crate_readme"
grep -q 'MetricEvent' "$crate_readme"
grep -q 'client.metric' "$crate_readme"
grep -q 'low-cardinality' "$crate_readme"
grep -q 'ProductTimeline' "$crate_readme"
grep -q 'Product And Network Timelines' "$crate_readme"
grep -q 'do not patch HTTP clients' "$crate_readme"
grep -q 'copyable snippets' "$crate_readme"
grep -q 'optional HTTP transport' "$crate_readme"
crate_manifest="$tmp_dir/crate-Cargo.toml"
tar -xOf "$crate_path" logbrew-0.1.0/Cargo.toml > "$crate_manifest"
crate_examples_makefile="$tmp_dir/crate-examples-Makefile"
tar -xOf "$crate_path" logbrew-0.1.0/examples/Makefile > "$crate_examples_makefile"
grep -q '^\.PHONY: help run run-readme-example run-real-user-smoke$' "$crate_examples_makefile"
grep -q '^help:$' "$crate_examples_makefile"
grep -q '^run: run-real-user-smoke$' "$crate_examples_makefile"
grep -q '^run-readme-example:$' "$crate_examples_makefile"
grep -q '^	@cargo run --quiet --example readme_example --manifest-path \.\./Cargo.toml$' "$crate_examples_makefile"
grep -q '^run-real-user-smoke:$' "$crate_examples_makefile"
grep -q '^	@cargo run --quiet --example real_user_smoke --manifest-path \.\./Cargo.toml$' "$crate_examples_makefile"
grep -q 'run-readme-example -> make run-readme-example' "$crate_examples_makefile"
grep -q 'run (real-user-smoke) -> make run' "$crate_examples_makefile"
grep -q 'run-real-user-smoke -> make run-real-user-smoke' "$crate_examples_makefile"
python3 - "$crate_manifest" <<'PY'
from pathlib import Path
import tomllib

manifest = tomllib.loads(Path(__import__("sys").argv[1]).read_text())
package = manifest.get("package", {})
if package.get("name") != "logbrew":
    raise SystemExit(f"unexpected packaged crate name: {package.get('name')!r}")
if package.get("version") != "0.1.0":
    raise SystemExit(f"unexpected packaged crate version: {package.get('version')!r}")
if package.get("license") != "MIT":
    raise SystemExit(f"unexpected packaged crate license: {package.get('license')!r}")
if package.get("repository") != "https://github.com/LogBrewCo/sdk":
    raise SystemExit(f"unexpected packaged crate repository: {package.get('repository')!r}")
if package.get("readme") != "README.md":
    raise SystemExit(f"unexpected packaged crate readme path: {package.get('readme')!r}")
if package.get("keywords") != ["logbrew", "observability", "logs", "traces", "events"]:
    raise SystemExit(f"unexpected packaged crate keywords: {package.get('keywords')!r}")
if package.get("categories") != ["api-bindings", "development-tools"]:
    raise SystemExit(f"unexpected packaged crate categories: {package.get('categories')!r}")
features = manifest.get("features", {})
if features.get("default") != []:
    raise SystemExit(f"unexpected packaged default features: {features.get('default')!r}")
if features.get("http") != ["dep:ureq"]:
    raise SystemExit(f"unexpected packaged http feature: {features.get('http')!r}")
dependencies = manifest.get("dependencies", {})
ureq = dependencies.get("ureq")
if not isinstance(ureq, dict):
    raise SystemExit(f"expected packaged optional ureq dependency, found: {ureq!r}")
if ureq.get("version") != "3.3":
    raise SystemExit(f"unexpected packaged ureq version requirement: {ureq.get('version')!r}")
if ureq.get("optional") is not True:
    raise SystemExit("expected packaged ureq dependency to stay optional")
PY
crate_src_root="$tmp_dir/extracted-crate"
mkdir -p "$crate_src_root"
tar -xf "$crate_path" -C "$crate_src_root"
crate_dir="$crate_src_root/logbrew-0.1.0"
test -f "$crate_dir/Cargo.toml"
test -f "$crate_dir/src/product_timeline.rs"
test -f "$crate_dir/examples/readme_example.rs"
test -f "$crate_dir/examples/real_user_smoke.rs"
test -f "$crate_dir/examples/Makefile"

cargo run --quiet --manifest-path "$crate_dir/Cargo.toml" --example readme_example > "$tmp_dir/packaged-readme-example.stdout.json" 2> "$tmp_dir/packaged-readme-example.stderr.json"
grep -q '"type": "release"' "$tmp_dir/packaged-readme-example.stdout.json"
grep -q '"type": "environment"' "$tmp_dir/packaged-readme-example.stdout.json"
grep -q '"type": "issue"' "$tmp_dir/packaged-readme-example.stdout.json"
grep -q '"type": "log"' "$tmp_dir/packaged-readme-example.stdout.json"
grep -q '"type": "span"' "$tmp_dir/packaged-readme-example.stdout.json"
grep -q '"type": "action"' "$tmp_dir/packaged-readme-example.stdout.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/packaged-readme-example.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/packaged-readme-example.stdout.json" >/dev/null
grep -q '"events":6' "$tmp_dir/packaged-readme-example.stderr.json"
grep -q '"ok":true' "$tmp_dir/packaged-readme-example.stderr.json"

cargo run --quiet --manifest-path "$crate_dir/Cargo.toml" --example real_user_smoke > "$tmp_dir/packaged-example.stdout.json" 2> "$tmp_dir/packaged-example.stderr.json"
grep -q '"type": "release"' "$tmp_dir/packaged-example.stdout.json"
grep -q '"type": "environment"' "$tmp_dir/packaged-example.stdout.json"
grep -q '"type": "issue"' "$tmp_dir/packaged-example.stdout.json"
grep -q '"type": "log"' "$tmp_dir/packaged-example.stdout.json"
grep -q '"type": "span"' "$tmp_dir/packaged-example.stdout.json"
grep -q '"type": "action"' "$tmp_dir/packaged-example.stdout.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/packaged-example.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/packaged-example.stdout.json" >/dev/null
grep -q '"events":6' "$tmp_dir/packaged-example.stderr.json"
grep -q '"ok":true' "$tmp_dir/packaged-example.stderr.json"
(cd "$crate_dir/examples" && make) > "$tmp_dir/packaged-example-make-help.txt"
grep -qx 'run-readme-example -> make run-readme-example' <(sed -n '1p' "$tmp_dir/packaged-example-make-help.txt")
grep -qx 'run (real-user-smoke) -> make run' <(sed -n '2p' "$tmp_dir/packaged-example-make-help.txt")
grep -qx 'run-real-user-smoke -> make run-real-user-smoke' <(sed -n '3p' "$tmp_dir/packaged-example-make-help.txt")
test "$(wc -l < "$tmp_dir/packaged-example-make-help.txt" | tr -d ' ')" = "3"
(cd "$crate_dir/examples" && make run-readme-example) > "$tmp_dir/packaged-readme-example-make.stdout.json" 2> "$tmp_dir/packaged-readme-example-make.stderr.json"
grep -q '"type": "release"' "$tmp_dir/packaged-readme-example-make.stdout.json"
grep -q '"type": "environment"' "$tmp_dir/packaged-readme-example-make.stdout.json"
grep -q '"type": "issue"' "$tmp_dir/packaged-readme-example-make.stdout.json"
grep -q '"type": "log"' "$tmp_dir/packaged-readme-example-make.stdout.json"
grep -q '"type": "span"' "$tmp_dir/packaged-readme-example-make.stdout.json"
grep -q '"type": "action"' "$tmp_dir/packaged-readme-example-make.stdout.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/packaged-readme-example-make.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/packaged-readme-example-make.stdout.json" >/dev/null
grep -q '"events":6' "$tmp_dir/packaged-readme-example-make.stderr.json"
grep -q '"ok":true' "$tmp_dir/packaged-readme-example-make.stderr.json"
(cd "$crate_dir/examples" && make run-real-user-smoke) > "$tmp_dir/packaged-example-make.stdout.json" 2> "$tmp_dir/packaged-example-make.stderr.json"
grep -q '"type": "release"' "$tmp_dir/packaged-example-make.stdout.json"
grep -q '"type": "environment"' "$tmp_dir/packaged-example-make.stdout.json"
grep -q '"type": "issue"' "$tmp_dir/packaged-example-make.stdout.json"
grep -q '"type": "log"' "$tmp_dir/packaged-example-make.stdout.json"
grep -q '"type": "span"' "$tmp_dir/packaged-example-make.stdout.json"
grep -q '"type": "action"' "$tmp_dir/packaged-example-make.stdout.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/packaged-example-make.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/packaged-example-make.stdout.json" >/dev/null
grep -q '"events":6' "$tmp_dir/packaged-example-make.stderr.json"
grep -q '"ok":true' "$tmp_dir/packaged-example-make.stderr.json"
(cd "$crate_dir/examples" && make run) > "$tmp_dir/packaged-example-make-run.stdout.json" 2> "$tmp_dir/packaged-example-make-run.stderr.json"
grep -q '"type": "release"' "$tmp_dir/packaged-example-make-run.stdout.json"
grep -q '"type": "environment"' "$tmp_dir/packaged-example-make-run.stdout.json"
grep -q '"type": "issue"' "$tmp_dir/packaged-example-make-run.stdout.json"
grep -q '"type": "log"' "$tmp_dir/packaged-example-make-run.stdout.json"
grep -q '"type": "span"' "$tmp_dir/packaged-example-make-run.stdout.json"
grep -q '"type": "action"' "$tmp_dir/packaged-example-make-run.stdout.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/packaged-example-make-run.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/packaged-example-make-run.stdout.json" >/dev/null
grep -q '"events":6' "$tmp_dir/packaged-example-make-run.stderr.json"
grep -q '"ok":true' "$tmp_dir/packaged-example-make-run.stderr.json"

cd "$tmp_dir"
cargo new --quiet lifecycle-app
cd lifecycle-app

cargo add logbrew --path "$crate_dir" >/dev/null
assert_cargo_manifest_dependency Cargo.toml lifecycle-app logbrew "/extracted-crate/logbrew-0.1.0"
grep -q '^name = "logbrew"$' Cargo.lock
grep -q '^version = "0.1.0"$' Cargo.lock
cargo metadata --locked --format-version 1 > lifecycle-cargo-metadata.json
python3 - <<'PY'
import json
from pathlib import Path

payload = json.loads(Path("lifecycle-cargo-metadata.json").read_text())
packages = payload.get("packages", [])
workspace_root = str(Path.cwd())
root_package = next((pkg for pkg in packages if pkg.get("name") == "lifecycle-app"), None)
if root_package is None:
    raise SystemExit("expected resolved lifecycle-app package")
if str(root_package.get("manifest_path", "")) != f"{workspace_root}/Cargo.toml":
    raise SystemExit(f"unexpected lifecycle-app manifest path: {root_package.get('manifest_path')}")
root_dependencies = root_package.get("dependencies", [])
logbrew_dependency = next((dep for dep in root_dependencies if dep.get("name") == "logbrew"), None)
if logbrew_dependency is None:
    raise SystemExit("expected lifecycle-app dependency on logbrew before removal")
if logbrew_dependency.get("req") not in ("^0.1.0", "*"):
    raise SystemExit(f"unexpected lifecycle-app dependency requirement: {logbrew_dependency.get('req')}")
dependency_path = str(logbrew_dependency.get("path", ""))
if not dependency_path.endswith("/extracted-crate/logbrew-0.1.0"):
    raise SystemExit(f"unexpected lifecycle-app dependency path: {dependency_path}")
PY
cargo tree --locked --depth 1 --charset ascii > lifecycle-cargo-tree.txt
grep -q '^lifecycle-app v0.1.0 (' lifecycle-cargo-tree.txt
assert_cargo_tree_package lifecycle-cargo-tree.txt logbrew 0.1.0 "/extracted-crate/logbrew-0.1.0"

cargo remove logbrew >/dev/null
assert_cargo_manifest_without_dependency Cargo.toml lifecycle-app logbrew
if grep -q '^name = "logbrew"$' Cargo.lock; then
	echo "expected Cargo.lock to remove logbrew package after cargo remove" >&2
	exit 1
fi
cargo metadata --locked --format-version 1 > lifecycle-cargo-metadata-removed.json
python3 - <<'PY'
import json
from pathlib import Path

payload = json.loads(Path("lifecycle-cargo-metadata-removed.json").read_text())
packages = payload.get("packages", [])
if len(packages) != 1:
    raise SystemExit(f"expected one package after cargo remove, found {len(packages)}")
root_package = packages[0]
if root_package.get("name") != "lifecycle-app":
    raise SystemExit(f"unexpected remaining package after cargo remove: {root_package.get('name')}")
if root_package.get("dependencies"):
    raise SystemExit("expected lifecycle-app metadata dependencies to be empty after cargo remove")
resolve = payload.get("resolve", {})
root_id = resolve.get("root")
if root_id != root_package.get("id"):
    raise SystemExit(f"unexpected lifecycle metadata root package id after cargo remove: {root_id}")
root_node = next((node for node in resolve.get("nodes", []) if node.get("id") == root_id), None)
if root_node is None:
    raise SystemExit("missing lifecycle metadata root node after cargo remove")
if root_node.get("dependencies"):
    raise SystemExit("expected lifecycle resolve dependencies to be empty after cargo remove")
PY
cargo tree --locked --depth 1 --charset ascii > lifecycle-cargo-tree-removed.txt
grep -q '^lifecycle-app v0.1.0 (' lifecycle-cargo-tree-removed.txt
if grep -q 'logbrew v0.1.0' lifecycle-cargo-tree-removed.txt; then
	echo "expected cargo tree to omit logbrew after cargo remove" >&2
	exit 1
fi

cargo add logbrew --path "$crate_dir" >/dev/null
assert_cargo_manifest_dependency Cargo.toml lifecycle-app logbrew "/extracted-crate/logbrew-0.1.0"
grep -q '^name = "logbrew"$' Cargo.lock
grep -q '^version = "0.1.0"$' Cargo.lock
cargo tree --locked --depth 1 --charset ascii > lifecycle-cargo-tree-readded.txt
assert_cargo_tree_package lifecycle-cargo-tree-readded.txt logbrew 0.1.0 "/extracted-crate/logbrew-0.1.0"

cd "$tmp_dir"
cargo new --quiet smoke-app
cd smoke-app

cargo add logbrew --path "$crate_dir" >/dev/null
assert_cargo_manifest_dependency Cargo.toml smoke-app logbrew "/extracted-crate/logbrew-0.1.0"

mkdir -p .cargo
cat > .cargo/config.toml <<'EOF'
[alias]
smoke-check = "check --quiet --locked"
smoke-build = "build --quiet --locked"
smoke-test = "test --quiet --locked"
smoke-doc = "doc --quiet --locked --no-deps --package logbrew"
smoke-run = "run --quiet --locked --bin smoke-app"
smoke-readme = "run --quiet --locked --bin readme_example"
smoke-timeline = "run --quiet --locked --bin timeline"
EOF
grep -q '^smoke-check = "check --quiet --locked"$' .cargo/config.toml
grep -q '^smoke-build = "build --quiet --locked"$' .cargo/config.toml
grep -q '^smoke-test = "test --quiet --locked"$' .cargo/config.toml
grep -q '^smoke-doc = "doc --quiet --locked --no-deps --package logbrew"$' .cargo/config.toml
grep -q '^smoke-run = "run --quiet --locked --bin smoke-app"$' .cargo/config.toml
grep -q '^smoke-readme = "run --quiet --locked --bin readme_example"$' .cargo/config.toml
grep -q '^smoke-timeline = "run --quiet --locked --bin timeline"$' .cargo/config.toml

cat > src/main.rs <<'EOF'
use logbrew::{
    ActionEvent, EnvironmentEvent, IssueEvent, LogBrewClient, LogEvent, RecordingTransport,
    ReleaseEvent, SpanEvent,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut client = LogBrewClient::builder("smoke-app", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()?;

    client.release(
        "evt_release_001",
        "2026-06-02T10:00:00Z",
        ReleaseEvent::new("1.2.3")
            .with_commit("abc123def456")
            .with_notes("Public release marker"),
    )?;
    client.environment(
        "evt_environment_001",
        "2026-06-02T10:00:01Z",
        EnvironmentEvent::new("production").with_region("global"),
    )?;
    client.issue(
        "evt_issue_001",
        "2026-06-02T10:00:02Z",
        IssueEvent::new("Checkout timeout", "error")
            .with_message("Request timed out after retry budget"),
    )?;
    client.log(
        "evt_log_001",
        "2026-06-02T10:00:03Z",
        LogEvent::new("worker started", "info").with_logger("job-runner"),
    )?;
    client.span(
        "evt_span_001",
        "2026-06-02T10:00:04Z",
        SpanEvent::new("GET /health", "trace_001", "span_001", "ok").with_duration_ms(12.5),
    )?;
    client.action(
        "evt_action_001",
        "2026-06-02T10:00:05Z",
        ActionEvent::new("deploy", "success"),
    )?;

    println!("{}", client.preview_json()?);

    let mut transport = RecordingTransport::always_accept();
    let response = client.shutdown(&mut transport)?;
    eprintln!(
        "{{\"ok\":true,\"status\":{},\"attempts\":{},\"events\":6}}",
        response.status_code, response.attempts
    );
    Ok(())
}
EOF

mkdir -p src/bin

cat > src/bin/readme_example.rs <<'EOF'
use logbrew::{
    ActionEvent, EnvironmentEvent, IssueEvent, LogBrewClient, LogEvent, RecordingTransport,
    ReleaseEvent, SpanEvent,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut client = LogBrewClient::builder("logbrew-rust", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()?;

    client.release(
        "evt_release_001",
        "2026-06-02T10:00:00Z",
        ReleaseEvent::new("1.2.3")
            .with_commit("abc123def456")
            .with_notes("Public release marker"),
    )?;
    client.environment(
        "evt_environment_001",
        "2026-06-02T10:00:01Z",
        EnvironmentEvent::new("production").with_region("global"),
    )?;
    client.issue(
        "evt_issue_001",
        "2026-06-02T10:00:02Z",
        IssueEvent::new("Checkout timeout", "error")
            .with_message("Request timed out after retry budget"),
    )?;
    client.log(
        "evt_log_001",
        "2026-06-02T10:00:03Z",
        LogEvent::new("worker started", "info").with_logger("job-runner"),
    )?;
    client.span(
        "evt_span_001",
        "2026-06-02T10:00:04Z",
        SpanEvent::new("GET /health", "trace_001", "span_001", "ok").with_duration_ms(12.5),
    )?;

    client.action(
        "evt_action_001",
        "2026-06-02T10:00:05Z",
        ActionEvent::new("deploy", "success"),
    )?;

    println!("{}", client.preview_json()?);

    let mut transport = RecordingTransport::always_accept();
    let response = client.shutdown(&mut transport)?;
    eprintln!(
        "{{\"ok\":true,\"status\":{},\"attempts\":{},\"events\":6}}",
        response.status_code, response.attempts
    );
    Ok(())
}
EOF

cat > src/bin/timeline.rs <<'EOF'
use logbrew::{ActionEvent, LogBrewClient, ProductTimeline, SdkError};

fn expect_validation(message_fragment: &str, result: Result<ActionEvent, SdkError>) {
    let error = result.expect_err("expected validation error");
    assert_eq!(error.code, "validation_error");
    assert!(
        error.message.contains(message_fragment),
        "unexpected message: {}",
        error.message
    );
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut client = LogBrewClient::builder("smoke-app", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()?;

    client.action(
        "evt_product_timeline",
        "2026-06-02T10:00:07Z",
        ProductTimeline::product_action("checkout.submit")
            .with_status("running")
            .with_route_template("/checkout?cart=123#pay")
            .with_session_id("session_123")
            .with_trace_id("trace_123")
            .with_screen("Checkout")
            .with_funnel("purchase")
            .with_step("submit")
            .build()?,
    )?;
    client.action(
        "evt_network_timeline",
        "2026-06-02T10:00:08Z",
        ProductTimeline::network_milestone("HTTPS://api.example.test/v1/checkout?cart=123#debug")
            .with_method("post")
            .with_status_code(503)
            .with_duration_ms(42.5)
            .with_session_id("session_123")
            .with_trace_id("trace_123")
            .build()?,
    )?;

    let preview = client.preview_json()?;
    assert!(preview.contains("\"source\": \"product_timeline\""));
    assert!(preview.contains("\"source\": \"network_timeline\""));
    assert!(preview.contains("\"routeTemplate\": \"/checkout\""));
    assert!(preview.contains("\"routeTemplate\": \"/v1/checkout\""));
    assert!(preview.contains("\"method\": \"POST\""));
    assert!(preview.contains("\"statusCode\": 503"));
    assert!(preview.contains("\"durationMs\": 42.5"));
    assert!(preview.contains("\"status\": \"failure\""));

    expect_validation(
        "valid HTTP method",
        ProductTimeline::network_milestone("/checkout")
            .with_method("bad method")
            .build(),
    );
    expect_validation(
        "non-negative",
        ProductTimeline::network_milestone("/checkout")
            .with_duration_ms(-1.0)
            .build(),
    );
    println!("{{\"ok\":true,\"timelineEvents\":2}}");
    Ok(())
}
EOF

mkdir -p tests
cat > tests/installed_user.rs <<'EOF'
use logbrew::{LogBrewClient, MetricEvent, ReleaseEvent};

#[test]
fn installed_client_preview_contains_release() {
    let mut client = LogBrewClient::builder("smoke-app-test", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()
        .expect("client should build");

    client
        .release(
            "evt_release_test",
            "2026-06-02T10:00:00Z",
            ReleaseEvent::new("1.2.3"),
        )
        .expect("release should queue");

    let payload = client.preview_json().expect("preview should succeed");
    assert!(
        payload.contains("\"type\": \"release\""),
        "preview did not contain release event: {payload}"
    );
}

#[test]
fn installed_metric_helper_previews_and_validates_measurements() {
    let mut client = LogBrewClient::builder("smoke-app-test", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()
        .expect("client should build");

    client
        .metric(
            "evt_metric_test",
            "2026-06-02T10:00:06Z",
            MetricEvent::new("checkout.request.duration", "histogram", 42.5, "ms", "delta"),
        )
        .expect("metric should queue");

    let payload = client.preview_json().expect("preview should succeed");
    assert!(
        payload.contains("\"type\": \"metric\""),
        "preview did not contain metric event: {payload}"
    );
    assert!(payload.contains("\"checkout.request.duration\""));

    assert!(
        client
            .metric(
                "evt_metric_invalid",
                "2026-06-02T10:00:06Z",
                MetricEvent::new("jobs.completed", "counter", -1.0, "1", "delta"),
            )
            .is_err()
    );
}
EOF

cargo metadata --locked --format-version 1 > cargo-metadata.json
test -f Cargo.lock
grep -q '^version = 4$' Cargo.lock
grep -q '^name = "logbrew"$' Cargo.lock
grep -q '^version = "0.1.0"$' Cargo.lock
grep -q '^ "serde",$' Cargo.lock
grep -q '^ "serde_json",$' Cargo.lock
python3 - <<'PY'
import json
from pathlib import Path

payload = json.loads(Path("cargo-metadata.json").read_text())
packages = payload.get("packages", [])
workspace_root = str(Path.cwd())
root_package = next((pkg for pkg in packages if pkg.get("name") == "smoke-app"), None)
if root_package is None:
    raise SystemExit("expected resolved smoke-app package")
root_manifest_path = str(root_package.get("manifest_path", ""))
if root_manifest_path != f"{workspace_root}/Cargo.toml":
    raise SystemExit(f"unexpected smoke-app manifest path: {root_manifest_path}")
root_dependencies = root_package.get("dependencies", [])
logbrew_dependency = next((dep for dep in root_dependencies if dep.get("name") == "logbrew"), None)
if logbrew_dependency is None:
    raise SystemExit("expected smoke-app metadata dependency on logbrew")
if logbrew_dependency.get("req") not in ("^0.1.0", "*"):
    raise SystemExit(f"unexpected logbrew dependency requirement: {logbrew_dependency.get('req')}")
dependency_path = str(logbrew_dependency.get("path", ""))
if not dependency_path.endswith("/extracted-crate/logbrew-0.1.0"):
    raise SystemExit(f"unexpected logbrew dependency path: {dependency_path}")
matches = [pkg for pkg in packages if pkg.get("name") == "logbrew"]
if len(matches) != 1:
    raise SystemExit("expected one resolved logbrew package")
package = matches[0]
if package.get("version") != "0.1.0":
    raise SystemExit(f"unexpected logbrew version: {package.get('version')}")
manifest_path = str(package.get("manifest_path", ""))
if not manifest_path.endswith("/extracted-crate/logbrew-0.1.0/Cargo.toml"):
    raise SystemExit(f"unexpected logbrew manifest path: {manifest_path}")
resolve = payload.get("resolve", {})
root_id = resolve.get("root")
if root_id != root_package.get("id"):
    raise SystemExit(f"unexpected cargo metadata root package id: {root_id}")
root_node = next((node for node in resolve.get("nodes", []) if node.get("id") == root_id), None)
if root_node is None:
    raise SystemExit("missing cargo metadata root node")
resolved_dependencies = root_node.get("dependencies", [])
if package.get("id") not in resolved_dependencies:
    raise SystemExit("missing smoke-app -> logbrew resolve edge")
PY
cargo pkgid logbrew > cargo-pkgid.txt
grep -q '^path+file://.*/extracted-crate/logbrew-0.1.0#logbrew@0.1.0$' cargo-pkgid.txt
cargo fetch --locked >/dev/null
cargo smoke-check
cargo smoke-build
cargo smoke-test
cargo tree --locked --depth 1 --charset ascii > cargo-tree.txt
grep -q '^smoke-app v0.1.0 (' cargo-tree.txt
assert_cargo_tree_package cargo-tree.txt logbrew 0.1.0 "/extracted-crate/logbrew-0.1.0"
cargo smoke-doc
test -f target/doc/logbrew/index.html
grep -q 'Public Rust client for building, validating, previewing, and flushing LogBrew event batches\.' target/doc/logbrew/index.html
test -f target/doc/logbrew/struct.LogBrewClient.html
grep -q 'Buffered public client for validating, previewing, and flushing LogBrew events\.' target/doc/logbrew/struct.LogBrewClient.html
grep -q 'Create a builder from public SDK identity values like name and version\.' target/doc/logbrew/struct.LogBrewClient.html
grep -q 'Return the queued event count currently buffered in memory\.' target/doc/logbrew/struct.LogBrewClient.html
grep -q 'Return the queued event batch as stable, pretty-printed JSON\.' target/doc/logbrew/struct.LogBrewClient.html
grep -q 'Flush queued events through a transport while preserving retry semantics\.' target/doc/logbrew/struct.LogBrewClient.html
grep -q 'Flush queued events, then mark the client closed so later writes fail\.' target/doc/logbrew/struct.LogBrewClient.html
grep -q 'Queue an explicit app-owned metric event with validated low-cardinality fields\.' target/doc/logbrew/struct.LogBrewClient.html
test -f target/doc/logbrew/struct.ClientBuilder.html
grep -q 'Builder for constructing a public LogBrew client from SDK identity and API key settings\.' target/doc/logbrew/struct.ClientBuilder.html
grep -q 'Build a buffered LogBrew client from the configured public settings\.' target/doc/logbrew/struct.ClientBuilder.html
test -f target/doc/logbrew/struct.RecordingTransport.html
grep -q 'Scripted in-memory transport for previewing, accepting, or failing flushes\.' target/doc/logbrew/struct.RecordingTransport.html
grep -q 'Create a transport that accepts queued flushes with a <code>202</code> response\.' target/doc/logbrew/struct.RecordingTransport.html
grep -q 'Create a transport from public status codes or transport failures\.' target/doc/logbrew/struct.RecordingTransport.html
grep -q 'Return every request body sent through this transport instance\.' target/doc/logbrew/struct.RecordingTransport.html
grep -q 'Return the most recent request body sent through this transport\.' target/doc/logbrew/struct.RecordingTransport.html
test -f target/doc/logbrew/trait.Transport.html
grep -q 'Public transport interface used by <code>flush</code> and <code>shutdown</code>\.' target/doc/logbrew/trait.Transport.html
grep -q 'tymethod.send' target/doc/logbrew/trait.Transport.html
grep -q 'Required Methods' target/doc/logbrew/trait.Transport.html
test -f target/doc/logbrew/struct.TransportResponse.html
grep -q 'Response returned after a transport accepts or skips a queued flush\.' target/doc/logbrew/struct.TransportResponse.html
grep -q 'Final HTTP-like status returned by the transport\.' target/doc/logbrew/struct.TransportResponse.html
grep -q 'Number of transport attempts used for the flush\.' target/doc/logbrew/struct.TransportResponse.html
test -f target/doc/logbrew/struct.SdkError.html
grep -q 'Stable public SDK error with parseable code and message fields\.' target/doc/logbrew/struct.SdkError.html
test -f target/doc/logbrew/struct.TransportError.html
grep -q 'Transport-layer failure with a stable public code and retry hint\.' target/doc/logbrew/struct.TransportError.html
grep -q 'Create a retryable network failure that preserves queued events\.' target/doc/logbrew/struct.TransportError.html
test -f target/doc/logbrew/struct.ReleaseEvent.html
grep -q 'Public release-event builder for stable LogBrew release payload fields\.' target/doc/logbrew/struct.ReleaseEvent.html
grep -q 'Create a release event with its required version field\.' target/doc/logbrew/struct.ReleaseEvent.html
grep -q 'Add an optional commit identifier to the release payload\.' target/doc/logbrew/struct.ReleaseEvent.html
test -f target/doc/logbrew/struct.EnvironmentEvent.html
grep -q 'Public environment-event builder for stable LogBrew environment payload fields\.' target/doc/logbrew/struct.EnvironmentEvent.html
grep -q 'Create an environment event with its required name field\.' target/doc/logbrew/struct.EnvironmentEvent.html
grep -q 'Add an optional region to the environment payload\.' target/doc/logbrew/struct.EnvironmentEvent.html
test -f target/doc/logbrew/struct.IssueEvent.html
grep -q 'Public issue-event builder for stable LogBrew issue payload fields\.' target/doc/logbrew/struct.IssueEvent.html
grep -q 'Create an issue event with its required title and level fields\.' target/doc/logbrew/struct.IssueEvent.html
grep -q 'Add an optional message to the issue payload\.' target/doc/logbrew/struct.IssueEvent.html
test -f target/doc/logbrew/struct.LogEvent.html
grep -q 'Public log-event builder for stable LogBrew log payload fields\.' target/doc/logbrew/struct.LogEvent.html
grep -q 'Create a log event with its required message and level fields\.' target/doc/logbrew/struct.LogEvent.html
grep -q 'Add an optional logger name to the log payload\.' target/doc/logbrew/struct.LogEvent.html
test -f target/doc/logbrew/struct.SpanEvent.html
grep -q 'Public span-event builder for stable LogBrew span payload fields\.' target/doc/logbrew/struct.SpanEvent.html
grep -q 'Create a span event with its required name, trace, span, and status fields\.' target/doc/logbrew/struct.SpanEvent.html
grep -q 'Add an optional non-negative duration to the span payload\.' target/doc/logbrew/struct.SpanEvent.html
test -f target/doc/logbrew/struct.ActionEvent.html
grep -q 'Public action-event builder for stable LogBrew action payload fields\.' target/doc/logbrew/struct.ActionEvent.html
grep -q 'Create an action event with its required name and status fields\.' target/doc/logbrew/struct.ActionEvent.html
test -f target/doc/logbrew/struct.MetricEvent.html
grep -q 'Public metric-event builder for explicit low-cardinality metric measurements\.' target/doc/logbrew/struct.MetricEvent.html
grep -q 'Create a metric event with name, kind, value, unit, and temporality fields\.' target/doc/logbrew/struct.MetricEvent.html
grep -q 'Attach primitive, low-cardinality metadata to the metric payload\.' target/doc/logbrew/struct.MetricEvent.html
test -f target/doc/logbrew/struct.ProductTimeline.html
grep -q 'App-owned timeline builders for product actions and network milestones\.' target/doc/logbrew/struct.ProductTimeline.html
grep -q 'Start a product action timeline builder for an app-known product step\.' target/doc/logbrew/struct.ProductTimeline.html
grep -q 'Start a network milestone timeline builder for an app-owned API milestone\.' target/doc/logbrew/struct.ProductTimeline.html
test -f target/doc/logbrew/struct.ProductActionTimeline.html
grep -q 'Builder for product-step timeline action events\.' target/doc/logbrew/struct.ProductActionTimeline.html
grep -q 'Attach a route template; query strings and hash fragments are stripped\.' target/doc/logbrew/struct.ProductActionTimeline.html
grep -q 'Build a normal LogBrew action event for queueing with <code>client.action</code>\.' target/doc/logbrew/struct.ProductActionTimeline.html
test -f target/doc/logbrew/struct.NetworkMilestoneTimeline.html
grep -q 'Builder for app-owned API or network milestone timeline action events\.' target/doc/logbrew/struct.NetworkMilestoneTimeline.html
grep -q 'Attach the HTTP method; it is normalized to uppercase\.' target/doc/logbrew/struct.NetworkMilestoneTimeline.html
grep -q 'Attach an HTTP status code, which also drives the default action status\.' target/doc/logbrew/struct.NetworkMilestoneTimeline.html
test -f target/doc/logbrew/struct.SdkInfo.html
grep -q 'Public SDK identity emitted with every LogBrew event batch\.' target/doc/logbrew/struct.SdkInfo.html
grep -q 'SDK or application name attached to emitted batches\.' target/doc/logbrew/struct.SdkInfo.html
grep -q 'SDK or application version attached to emitted batches\.' target/doc/logbrew/struct.SdkInfo.html
test -f target/doc/logbrew/struct.EventBatch.html
grep -q 'Public event batch preview shape returned by <code>preview_json</code>\.' target/doc/logbrew/struct.EventBatch.html
grep -q 'SDK identity metadata attached to the batch\.' target/doc/logbrew/struct.EventBatch.html
grep -q 'Validated events currently queued in the batch\.' target/doc/logbrew/struct.EventBatch.html
test -f target/doc/logbrew/struct.Event.html
grep -q 'Public event shape buffered, previewed, and flushed by the client\.' target/doc/logbrew/struct.Event.html
grep -q 'Stable LogBrew event type such as <code>release</code> or <code>span</code>\.' target/doc/logbrew/struct.Event.html
grep -q 'Caller-supplied stable identifier for the event\.' target/doc/logbrew/struct.Event.html
grep -q 'Event payload fields for the given event type\.' target/doc/logbrew/struct.Event.html

cargo smoke-run > smoke.stdout.json 2> smoke.stderr.json
grep -q '"type": "release"' smoke.stdout.json
grep -q '"type": "environment"' smoke.stdout.json
grep -q '"type": "issue"' smoke.stdout.json
grep -q '"type": "log"' smoke.stdout.json
grep -q '"type": "span"' smoke.stdout.json
grep -q '"type": "action"' smoke.stdout.json
python3 "$repo_root/scripts/validate_fixtures.py" smoke.stdout.json >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" smoke.stdout.json >/dev/null
grep -q '"events":6' smoke.stderr.json
grep -q '"ok":true' smoke.stderr.json

cargo smoke-readme > readme-example.stdout.json 2> readme-example.stderr.json
grep -q '"type": "release"' readme-example.stdout.json
grep -q '"type": "environment"' readme-example.stdout.json
grep -q '"type": "issue"' readme-example.stdout.json
grep -q '"type": "log"' readme-example.stdout.json
grep -q '"type": "span"' readme-example.stdout.json
grep -q '"type": "action"' readme-example.stdout.json
python3 "$repo_root/scripts/validate_fixtures.py" readme-example.stdout.json >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" readme-example.stdout.json >/dev/null
grep -q '"events":6' readme-example.stderr.json
grep -q '"ok":true' readme-example.stderr.json

cargo smoke-timeline > timeline.stdout.json
grep -q '"ok":true' timeline.stdout.json
grep -q '"timelineEvents":2' timeline.stdout.json

cat > src/bin/unauth.rs <<'EOF'
use logbrew::{LogBrewClient, RecordingTransport, ReleaseEvent, SdkError};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut client = LogBrewClient::builder("smoke-app", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()?;

    client.release(
        "evt_release_unauth",
        "2026-06-02T10:00:00Z",
        ReleaseEvent::new("1.2.3"),
    )?;

    let mut transport = RecordingTransport::scripted(vec![Ok(401)]);
    match client.flush(&mut transport) {
        Ok(_) => Err("expected unauthenticated error".into()),
        Err(SdkError { code, message }) => {
            println!(
                "{{\"ok\":true,\"code\":\"{}\",\"message\":\"{}\",\"pending\":{}}}",
                code,
                message,
                client.pending_events()
            );
            Ok(())
        }
    }
}
EOF

cargo run --quiet --locked --bin unauth > unauth.stdout.json
grep -q '"ok":true' unauth.stdout.json
grep -q '"code":"unauthenticated"' unauth.stdout.json
grep -q '"message":"transport rejected the API key"' unauth.stdout.json
grep -q '"pending":1' unauth.stdout.json

cat > src/bin/retry.rs <<'EOF'
use logbrew::{LogBrewClient, RecordingTransport, ReleaseEvent, TransportError};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut client = LogBrewClient::builder("smoke-app", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()?;

    client.release(
        "evt_release_retry",
        "2026-06-02T10:00:00Z",
        ReleaseEvent::new("1.2.3"),
    )?;

    let mut transport = RecordingTransport::scripted(vec![
        Err(TransportError::network("temporary outage")),
        Ok(202),
    ]);
    let response = client.flush(&mut transport)?;
    println!(
        "{{\"ok\":true,\"status\":{},\"attempts\":{},\"pending\":{}}}",
        response.status_code,
        response.attempts,
        client.pending_events()
    );
    Ok(())
}
EOF

cargo run --quiet --locked --bin retry > retry.stdout.json
grep -q '"ok":true' retry.stdout.json
grep -q '"status":202' retry.stdout.json
grep -q '"attempts":2' retry.stdout.json
grep -q '"pending":0' retry.stdout.json

cat > src/bin/shutdown.rs <<'EOF'
use logbrew::{LogBrewClient, LogEvent, RecordingTransport, ReleaseEvent, SdkError};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut client = LogBrewClient::builder("smoke-app", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()?;

    client.release(
        "evt_release_shutdown",
        "2026-06-02T10:00:00Z",
        ReleaseEvent::new("1.2.3"),
    )?;

    let mut transport = RecordingTransport::always_accept();
    client.shutdown(&mut transport)?;
    match client.log(
        "evt_log_shutdown",
        "2026-06-02T10:00:01Z",
        LogEvent::new("should fail", "info"),
    ) {
        Ok(_) => Err("expected shutdown error".into()),
        Err(SdkError { code, message }) => {
            println!(
                "{{\"ok\":true,\"code\":\"{}\",\"message\":\"{}\",\"pending\":{}}}",
                code,
                message,
                client.pending_events()
            );
            Ok(())
        }
    }
}
EOF

cargo run --quiet --locked --bin shutdown > shutdown.stdout.json
grep -q '"ok":true' shutdown.stdout.json
grep -q '"code":"shutdown_error"' shutdown.stdout.json
grep -q '"message":"client is already shut down"' shutdown.stdout.json
grep -q '"pending":0' shutdown.stdout.json

cat > src/bin/empty_flush.rs <<'EOF'
use logbrew::{LogBrewClient, RecordingTransport};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut client = LogBrewClient::builder("smoke-app", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()?;

    let mut transport = RecordingTransport::always_accept();
    let response = client.flush(&mut transport)?;
    println!(
        "{{\"ok\":true,\"status\":{},\"attempts\":{},\"pending\":{}}}",
        response.status_code,
        response.attempts,
        client.pending_events()
    );
    Ok(())
}
EOF

cargo run --quiet --locked --bin empty_flush > empty_flush.stdout.json
grep -q '"ok":true' empty_flush.stdout.json
grep -q '"status":204' empty_flush.stdout.json
grep -q '"attempts":0' empty_flush.stdout.json
grep -q '"pending":0' empty_flush.stdout.json

cat > src/bin/validation.rs <<'EOF'
use logbrew::{LogBrewClient, LogEvent, SdkError};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut client = LogBrewClient::builder("smoke-app", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()?;

    match client.log(
        "evt_log_invalid",
        "2026-06-02T10:00:03",
        LogEvent::new("should fail", "info"),
    ) {
        Ok(_) => Err("expected validation error".into()),
        Err(SdkError { code, message }) => {
            println!(
                "{{\"ok\":true,\"code\":\"{}\",\"message\":\"{}\",\"pending\":{}}}",
                code,
                message,
                client.pending_events()
            );
            Ok(())
        }
    }
}
EOF

cargo run --quiet --locked --bin validation > validation.stdout.json
grep -q '"ok":true' validation.stdout.json
grep -q '"code":"validation_error"' validation.stdout.json
grep -q '"message":"timestamp must include a timezone offset: 2026-06-02T10:00:03"' validation.stdout.json
grep -q '"pending":0' validation.stdout.json

cat > src/bin/retry_budget.rs <<'EOF'
use logbrew::{LogBrewClient, RecordingTransport, ReleaseEvent, SdkError, TransportError};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut client = LogBrewClient::builder("smoke-app", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()?;

    client.release(
        "evt_release_retry_budget",
        "2026-06-02T10:00:00Z",
        ReleaseEvent::new("1.2.3"),
    )?;

    let mut transport = RecordingTransport::scripted(vec![
        Err(TransportError::network("temporary outage")),
        Err(TransportError::network("temporary outage")),
        Err(TransportError::network("temporary outage")),
    ]);
    match client.flush(&mut transport) {
        Ok(_) => Err("expected network failure".into()),
        Err(SdkError { code, message }) => {
            println!(
                "{{\"ok\":true,\"code\":\"{}\",\"message\":\"{}\",\"pending\":{}}}",
                code,
                message,
                client.pending_events()
            );
            Ok(())
        }
    }
}
EOF

cargo run --quiet --locked --bin retry_budget > retry_budget.stdout.json
grep -q '"ok":true' retry_budget.stdout.json
grep -q '"code":"network_failure"' retry_budget.stdout.json
grep -q '"message":"temporary outage"' retry_budget.stdout.json
grep -q '"pending":1' retry_budget.stdout.json

cat > src/bin/transport_status.rs <<'EOF'
use logbrew::{LogBrewClient, RecordingTransport, ReleaseEvent, SdkError};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut client = LogBrewClient::builder("smoke-app", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .build()?;

    client.release(
        "evt_release_transport_status",
        "2026-06-02T10:00:00Z",
        ReleaseEvent::new("1.2.3"),
    )?;

    let mut transport = RecordingTransport::scripted(vec![Ok(400)]);
    match client.flush(&mut transport) {
        Ok(_) => Err("expected transport error".into()),
        Err(SdkError { code, message }) => {
            println!(
                "{{\"ok\":true,\"code\":\"{}\",\"message\":\"{}\",\"pending\":{}}}",
                code,
                message,
                client.pending_events()
            );
            Ok(())
        }
    }
}
EOF

cargo run --quiet --locked --bin transport_status > transport-status.stdout.json
grep -q '"ok":true' transport-status.stdout.json
grep -q '"code":"transport_error"' transport-status.stdout.json
grep -q '"message":"unexpected transport status 400"' transport-status.stdout.json
grep -q '"pending":1' transport-status.stdout.json

cd "$tmp_dir"
cargo new --quiet http-app
cd http-app

cargo add logbrew --path "$crate_dir" --features http >/dev/null
assert_cargo_manifest_dependency Cargo.toml http-app logbrew "/extracted-crate/logbrew-0.1.0" http

grep -q '^name = "logbrew"$' Cargo.lock
grep -q '^name = "ureq"$' Cargo.lock
cargo metadata --locked --format-version 1 > http-cargo-metadata.json
python3 - <<'PY'
import json
from pathlib import Path

payload = json.loads(Path("http-cargo-metadata.json").read_text())
root = next((pkg for pkg in payload.get("packages", []) if pkg.get("name") == "http-app"), None)
if root is None:
    raise SystemExit("expected resolved http-app package")
dependency = next((dep for dep in root.get("dependencies", []) if dep.get("name") == "logbrew"), None)
if dependency is None:
    raise SystemExit("expected http-app dependency on logbrew")
if dependency.get("features") != ["http"]:
    raise SystemExit(f"unexpected http-app logbrew features: {dependency.get('features')!r}")
if dependency.get("req") not in ("^0.1.0", "*"):
    raise SystemExit(f"unexpected http-app logbrew requirement: {dependency.get('req')}")
dependency_path = str(dependency.get("path", ""))
if not dependency_path.endswith("/extracted-crate/logbrew-0.1.0"):
    raise SystemExit(f"unexpected http-app dependency path: {dependency_path}")
PY
cargo tree --locked --charset ascii > http-cargo-tree.txt
grep -q '^http-app v0.1.0 (' http-cargo-tree.txt
assert_cargo_tree_package http-cargo-tree.txt logbrew 0.1.0 "/extracted-crate/logbrew-0.1.0"
assert_cargo_tree_package http-cargo-tree.txt ureq 3.3.0

cat > src/main.rs <<'EOF'
use logbrew::{HttpTransport, HttpTransportConfig, LogBrewClient, ReleaseEvent};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;
use std::time::Duration;

#[derive(Debug)]
struct RecordedHttpRequest {
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl RecordedHttpRequest {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(header_name, _)| header_name == name)
            .map(|(_, value)| value.as_str())
    }
}

struct LocalHttpIntake {
    endpoint: String,
    handle: thread::JoinHandle<Vec<RecordedHttpRequest>>,
}

impl LocalHttpIntake {
    fn start(statuses: Vec<u16>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("local intake should bind");
        let endpoint = format!(
            "http://{}/v1/events",
            listener.local_addr().expect("local intake address")
        );
        let handle = thread::spawn(move || {
            let mut requests = Vec::new();
            for status in statuses {
                let (mut stream, _) = listener.accept().expect("local intake should accept");
                let mut bytes = Vec::new();
                let mut chunk = [0; 1024];
                while header_end_index(&bytes).is_none() {
                    let read = stream.read(&mut chunk).expect("local intake should read");
                    if read == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&chunk[..read]);
                }

                let header_end = header_end_index(&bytes).expect("request headers should finish");
                let head = String::from_utf8_lossy(&bytes[..header_end]);
                let mut lines = head.split("\r\n");
                let path = lines
                    .next()
                    .and_then(|request_line| request_line.split_whitespace().nth(1))
                    .unwrap_or("")
                    .to_string();
                let mut headers = Vec::new();
                let mut content_length = 0usize;
                for line in lines {
                    if line.is_empty() {
                        continue;
                    }
                    if let Some((name, value)) = line.split_once(':') {
                        let name = name.trim().to_ascii_lowercase();
                        let value = value.trim().to_string();
                        if name == "content-length" {
                            content_length =
                                value.parse().expect("content-length should be numeric");
                        }
                        headers.push((name, value));
                    }
                }

                let mut body = bytes[header_end..].to_vec();
                while body.len() < content_length {
                    let read = stream.read(&mut chunk).expect("local intake body read");
                    if read == 0 {
                        break;
                    }
                    body.extend_from_slice(&chunk[..read]);
                }
                body.truncate(content_length);
                requests.push(RecordedHttpRequest {
                    path,
                    headers,
                    body,
                });

                let reason = if status == 503 {
                    "Service Unavailable"
                } else {
                    "Accepted"
                };
                let response =
                    format!("HTTP/1.1 {status} {reason}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
                stream
                    .write_all(response.as_bytes())
                    .expect("local intake should respond");
            }
            requests
        });
        Self { endpoint, handle }
    }

    fn requests(self) -> Vec<RecordedHttpRequest> {
        self.handle.join().expect("local intake should finish")
    }
}

fn header_end_index(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let intake = LocalHttpIntake::start(vec![503, 202]);
    let mut client = LogBrewClient::builder("http-app", "0.1.0")
        .api_key("LOGBREW_API_KEY")
        .max_retries(1)
        .build()?;
    client.release(
        "evt_release_http_installed",
        "2026-06-02T10:00:00Z",
        ReleaseEvent::new("1.2.3"),
    )?;

    let mut transport = HttpTransport::new(HttpTransportConfig {
        endpoint: intake.endpoint.clone(),
        headers: vec![("x-logbrew-test".to_string(), "rust".to_string())],
        timeout: Some(Duration::from_secs(2)),
        ..Default::default()
    })?;
    let response = client.flush(&mut transport)?;
    let requests = intake.requests();

    assert_eq!(response.status_code, 202);
    assert_eq!(response.attempts, 2);
    assert_eq!(client.pending_events(), 0);
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].path, "/v1/events");
    assert_eq!(requests[1].path, "/v1/events");
    assert_eq!(requests[0].header("authorization"), Some("Bearer LOGBREW_API_KEY"));
    assert_eq!(requests[1].header("authorization"), Some("Bearer LOGBREW_API_KEY"));
    assert_eq!(requests[0].header("content-type"), Some("application/json"));
    assert_eq!(requests[0].header("x-logbrew-test"), Some("rust"));
    assert_eq!(requests[0].body, requests[1].body);
    let body = String::from_utf8_lossy(&requests[1].body);
    assert!(body.contains("\"evt_release_http_installed\""));

    println!(
        "{{\"ok\":true,\"status\":{},\"attempts\":{},\"pending\":{},\"requests\":{}}}",
        response.status_code,
        response.attempts,
        client.pending_events(),
        requests.len()
    );
    Ok(())
}
EOF

cargo check --locked >/dev/null
cargo test --locked >/dev/null
cargo doc --quiet --locked --package logbrew --no-deps
test -f target/doc/logbrew/constant.DEFAULT_HTTP_ENDPOINT.html
grep -q 'Default LogBrew HTTP intake endpoint used by <code>HttpTransportConfig</code>\.' target/doc/logbrew/constant.DEFAULT_HTTP_ENDPOINT.html
test -f target/doc/logbrew/struct.HttpTransportConfig.html
grep -q 'Configuration for the feature-gated blocking HTTP transport\.' target/doc/logbrew/struct.HttpTransportConfig.html
grep -q 'Absolute HTTP or HTTPS endpoint that accepts LogBrew event batches\.' target/doc/logbrew/struct.HttpTransportConfig.html
grep -q 'Additional request headers sent with every batch\.' target/doc/logbrew/struct.HttpTransportConfig.html
grep -q 'End-to-end timeout for each HTTP delivery attempt\.' target/doc/logbrew/struct.HttpTransportConfig.html
test -f target/doc/logbrew/struct.HttpTransport.html
grep -q 'Blocking HTTP transport that sends queued batches to a LogBrew intake endpoint\.' target/doc/logbrew/struct.HttpTransport.html
grep -q 'Build a blocking HTTP transport from public configuration\.' target/doc/logbrew/struct.HttpTransport.html
grep -q 'Return the configured endpoint used for future send attempts\.' target/doc/logbrew/struct.HttpTransport.html
grep -q 'Return the additional request headers configured for this transport\.' target/doc/logbrew/struct.HttpTransport.html
cargo run --quiet --locked > http.stdout.json
grep -q '"ok":true' http.stdout.json
grep -q '"status":202' http.stdout.json
grep -q '"attempts":2' http.stdout.json
grep -q '"pending":0' http.stdout.json
grep -q '"requests":2' http.stdout.json
