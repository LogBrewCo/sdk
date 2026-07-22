#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
output_path="$repo_root/dist/logbrew-maven-central-bundle.zip"
manifest_path=""
release_plan_path=""
selected_artifacts=()
sign_artifacts=false

# shellcheck source=scripts/java_logback_deps.sh
source "$repo_root/scripts/java_logback_deps.sh"
# shellcheck source=scripts/kotlin_okhttp_deps.sh
source "$repo_root/scripts/kotlin_okhttp_deps.sh"

usage() {
  cat <<'EOF'
Usage: build_maven_central_bundle.sh (--artifact ID ... | --plan PATH) [options]

Build a selected Maven Central Portal deployment bundle.
  --artifact ID   Select one supported artifact. May be repeated.
  --plan PATH     Use an existing exact release plan.
  --manifest PATH Write the exact bundle manifest to PATH.
  --output PATH   Write the Maven Central bundle to PATH.
  --sign          Sign staged artifacts before checksumming.
Use --sign only in trusted release automation with MAVEN_GPG_* environment values.
EOF
}

cleanup() {
  rm -rf "$tmp_dir"
}

trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --artifact)
      if [[ $# -lt 2 ]]; then
        printf '%s\n' "--artifact requires an id" >&2
        exit 2
      fi
      selected_artifacts+=("$2")
      shift 2
      ;;
    --plan)
      if [[ $# -lt 2 ]]; then
        printf '%s\n' "--plan requires a path" >&2
        exit 2
      fi
      release_plan_path="$2"
      shift 2
      ;;
    --manifest)
      if [[ $# -lt 2 ]]; then
        printf '%s\n' "--manifest requires a path" >&2
        exit 2
      fi
      manifest_path="$2"
      shift 2
      ;;
    --output)
      if [[ $# -lt 2 ]]; then
        printf '%s\n' "--output requires a path" >&2
        exit 2
      fi
      output_path="$2"
      shift 2
      ;;
    --sign)
      sign_artifacts=true
      shift
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -n "$release_plan_path" && ${#selected_artifacts[@]} -gt 0 ]]; then
  printf '%s\n' "--artifact and --plan cannot be combined" >&2
  exit 2
fi
if [[ -z "$release_plan_path" && ${#selected_artifacts[@]} -eq 0 ]]; then
  printf '%s\n' "select at least one Maven artifact with --artifact or --plan" >&2
  exit 2
fi
if [[ -z "$manifest_path" ]]; then
  manifest_path="$output_path.manifest.json"
fi

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '%s is required to build the Maven Central bundle\n' "$1" >&2
    exit 1
  fi
}

require_tool python3

if [[ -z "$release_plan_path" ]]; then
  release_plan_path="$tmp_dir/maven-release-plan.json"
  create_args=()
  for artifact in "${selected_artifacts[@]}"; do
    create_args+=(--artifact "$artifact")
  done
  python3 "$repo_root"/scripts/maven_release_plan.py create \
    --root "$repo_root" \
    "${create_args[@]}" \
    --output "$release_plan_path"
fi
python3 "$repo_root"/scripts/maven_release_plan.py validate \
  --root "$repo_root" \
  --plan "$release_plan_path"

artifact_selected() {
  python3 - "$release_plan_path" "$1" <<'PY'
import json
import sys
from pathlib import Path

plan = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
selected = {entry["artifactId"] for entry in plan["selected"]}
raise SystemExit(0 if sys.argv[2] in selected else 1)
PY
}

plan_version() {
  python3 - "$release_plan_path" "$1" <<'PY'
import json
import sys
from pathlib import Path

plan = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
versions = {entry["artifactId"]: entry["version"] for entry in plan["selected"]}
print(versions.get(sys.argv[2], ""))
PY
}

java_dir="$repo_root/java/logbrew-java"
kotlin_dir="$repo_root/kotlin/logbrew-kotlin"
okhttp_dir="$repo_root/kotlin/logbrew-kotlin-okhttp"
java_artifact="logbrew-sdk"
java_version="$(plan_version "$java_artifact")"
kotlin_artifact="logbrew-kotlin"
kotlin_version="$(plan_version "$kotlin_artifact")"
okhttp_artifact="logbrew-kotlin-okhttp"
okhttp_version="$(plan_version "$okhttp_artifact")"

require_tool jar
if artifact_selected "$java_artifact"; then
  require_tool javac
  require_tool javadoc
fi
if artifact_selected "$kotlin_artifact" || artifact_selected "$okhttp_artifact"; then
  require_tool kotlinc
fi
if [[ "$sign_artifacts" == true ]]; then
  require_tool gpg
fi

build_dir="$tmp_dir/build"
stage_dir="$tmp_dir/central-staging"
mkdir -p "$build_dir" "$stage_dir"

build_java_artifacts() {
  local package_dir="$java_dir"
  local artifact="$java_artifact"
  local version="$java_version"
  local main_sources="$build_dir/java-main-sources.txt"
  local classes_dir="$build_dir/java-classes"
  local javadoc_dir="$build_dir/java-javadoc"
  local jar_stage="$build_dir/java-jar-stage"
  local logback_classpath
  local opentelemetry_classpath
  local servlet_classpath
  local spring_boot_classpath
  local spring_kafka_classpath
  local spring_web_classpath
  local optional_classpath

  find "$package_dir/src/main/java" -name '*.java' | sort > "$main_sources"
  mkdir -p "$classes_dir" "$javadoc_dir" "$jar_stage/META-INF/maven/co.logbrew/$artifact"
  logback_classpath="$(fetch_java_logback_deps "$build_dir/java-logback-deps")"
  opentelemetry_classpath="$(fetch_java_opentelemetry_deps "$build_dir/java-opentelemetry-deps")"
  servlet_classpath="$(fetch_java_servlet_deps "$build_dir/java-servlet-deps")"
  spring_boot_classpath="$(fetch_java_spring_boot_deps "$build_dir/java-spring-boot-deps")"
  spring_kafka_classpath="$(fetch_java_spring_kafka_deps "$build_dir/java-spring-kafka-deps")"
  spring_web_classpath="$(fetch_java_spring_web_deps "$build_dir/java-spring-web-deps")"
  optional_classpath="$logback_classpath:$opentelemetry_classpath:$servlet_classpath"
  optional_classpath+=":$spring_boot_classpath:$spring_kafka_classpath:$spring_web_classpath"

  javac -Xlint:all -Werror --release 11 -cp "$optional_classpath" -d "$classes_dir" @"$main_sources"
  javadoc -quiet -Xdoclint:all,-missing -Werror --release 11 -classpath "$optional_classpath" -d "$javadoc_dir" @"$main_sources"

  jar --create --file "$build_dir/$artifact-$version-sources.jar" -C "$package_dir/src/main/java" .
  if [[ -d "$package_dir/src/main/resources" ]]; then
    jar --update --file "$build_dir/$artifact-$version-sources.jar" -C "$package_dir/src/main/resources" .
  fi
  jar --create --file "$build_dir/$artifact-$version-javadoc.jar" -C "$javadoc_dir" .
  cp "$package_dir/pom.xml" "$jar_stage/META-INF/maven/co.logbrew/$artifact/pom.xml"
  cp "$package_dir/README.md" "$jar_stage/README.md"
  cp -R "$classes_dir/co" "$jar_stage/co"
  if [[ -d "$package_dir/src/main/resources" ]]; then
    cp -R "$package_dir/src/main/resources/." "$jar_stage/"
  fi
  jar --create --file "$build_dir/$artifact-$version.jar" -C "$jar_stage" .
}

kotlin_classes_ready=false

compile_kotlin_core() {
  local package_dir="$kotlin_dir"
  local classes_dir="$build_dir/kotlin-classes"

  if [[ "$kotlin_classes_ready" == true ]]; then
    return
  fi
  mkdir -p "$classes_dir"
  kotlinc "$package_dir"/src/main/kotlin/co/logbrew/sdk/*.kt \
    -jvm-target 11 \
    -Xjdk-release=11 \
    -Werror \
    -d "$classes_dir"
  kotlin_classes_ready=true
}

build_kotlin_artifacts() {
  local package_dir="$kotlin_dir"
  local artifact="$kotlin_artifact"
  local version="$kotlin_version"
  local classes_dir="$build_dir/kotlin-classes"
  local jar_stage="$build_dir/kotlin-jar-stage"
  local javadoc_stage="$build_dir/kotlin-javadoc-stage"

  compile_kotlin_core
  mkdir -p "$javadoc_stage" "$jar_stage/META-INF/maven/co.logbrew/$artifact"

  jar --create --file "$build_dir/$artifact-$version-sources.jar" -C "$package_dir/src/main/kotlin" .
  cp "$package_dir/README.md" "$javadoc_stage/README.md"
  jar --create --file "$build_dir/$artifact-$version-javadoc.jar" -C "$javadoc_stage" README.md
  cp "$package_dir/pom.xml" "$jar_stage/META-INF/maven/co.logbrew/$artifact/pom.xml"
  cp "$package_dir/README.md" "$jar_stage/README.md"
  mkdir -p "$jar_stage/examples"
  cp -R "$package_dir/examples/readme_example" "$jar_stage/examples/readme_example"
  cp -R "$package_dir/examples/real_user_smoke" "$jar_stage/examples/real_user_smoke"
  cp "$package_dir/examples/Makefile" "$jar_stage/examples/Makefile"
  jar --create --file "$build_dir/$artifact-$version.jar" -C "$classes_dir" . -C "$jar_stage" .
}

build_kotlin_okhttp_artifacts() {
  local package_dir="$okhttp_dir"
  local artifact="$okhttp_artifact"
  local version="$okhttp_version"
  local classes_dir="$build_dir/kotlin-okhttp-classes"
  local jar_stage="$build_dir/kotlin-okhttp-jar-stage"
  local javadoc_stage="$build_dir/kotlin-okhttp-javadoc-stage"
  local core_classes_dir="$build_dir/kotlin-classes"
  local okhttp_classpath

  compile_kotlin_core
  mkdir -p "$classes_dir" "$javadoc_stage" "$jar_stage/META-INF/maven/co.logbrew/$artifact"
  okhttp_classpath="$core_classes_dir:$(fetch_kotlin_okhttp_deps "$build_dir/kotlin-okhttp-deps")"
  kotlinc "$package_dir"/src/main/kotlin/co/logbrew/sdk/okhttp/*.kt \
    -classpath "$okhttp_classpath" \
    -jvm-target 11 \
    -Xjdk-release=11 \
    -Werror \
    -d "$classes_dir"

  jar --create --file "$build_dir/$artifact-$version-sources.jar" -C "$package_dir/src/main/kotlin" .
  cp "$package_dir/README.md" "$javadoc_stage/README.md"
  jar --create --file "$build_dir/$artifact-$version-javadoc.jar" -C "$javadoc_stage" README.md
  cp "$package_dir/pom.xml" "$jar_stage/META-INF/maven/co.logbrew/$artifact/pom.xml"
  cp "$package_dir/README.md" "$jar_stage/README.md"
  mkdir -p "$jar_stage/examples"
  cp -R "$package_dir/examples/okhttp_request" "$jar_stage/examples/okhttp_request"
  jar --create --file "$build_dir/$artifact-$version.jar" -C "$classes_dir" . -C "$jar_stage" .
}

import_gpg_key_if_needed() {
  if [[ "$sign_artifacts" != true ]]; then
    return
  fi

  if [[ -n "${MAVEN_GPG_PRIVATE_KEY:-}" ]]; then
    export GNUPGHOME="$tmp_dir/gnupg"
    mkdir -p "$GNUPGHOME"
    chmod 700 "$GNUPGHOME"
    if [[ "$MAVEN_GPG_PRIVATE_KEY" == *"\\n"* && "$MAVEN_GPG_PRIVATE_KEY" != *$'\n'* ]]; then
      printf '%b' "$MAVEN_GPG_PRIVATE_KEY" | gpg --batch --import
    else
      printf '%s' "$MAVEN_GPG_PRIVATE_KEY" | gpg --batch --import
    fi
  fi
}

sign_file() {
  local file_path="$1"
  local gpg_args=(--batch --yes --armor --detach-sign)
  if [[ -n "${MAVEN_GPG_KEY_ID:-}" ]]; then
    gpg_args+=(--local-user "$MAVEN_GPG_KEY_ID")
  fi
  if [[ -n "${MAVEN_GPG_PASSPHRASE:-}" ]]; then
    gpg_args+=(--pinentry-mode loopback --passphrase "$MAVEN_GPG_PASSPHRASE")
  fi
  gpg "${gpg_args[@]}" "$file_path"
}

write_checksums() {
  python3 - "$1" <<'PY'
import hashlib
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = path.read_bytes()
for algorithm in ("md5", "sha1", "sha256", "sha512"):
    digest = hashlib.new(algorithm, data).hexdigest()
    path.with_name(f"{path.name}.{algorithm}").write_text(f"{digest}\n", encoding="utf-8")
PY
}

stage_artifact() {
  local artifact="$1"
  local version="$2"
  local artifact_dir="$stage_dir/co/logbrew/$artifact/$version"
  mkdir -p "$artifact_dir"
  cp "$build_dir/$artifact-$version.jar" "$artifact_dir/$artifact-$version.jar"
  cp "$build_dir/$artifact-$version-sources.jar" "$artifact_dir/$artifact-$version-sources.jar"
  cp "$build_dir/$artifact-$version-javadoc.jar" "$artifact_dir/$artifact-$version-javadoc.jar"
  cp "$repo_root/${3}/pom.xml" "$artifact_dir/$artifact-$version.pom"
}

finalize_artifacts() {
  local artifact_files=()
  while IFS= read -r -d '' file_path; do
    artifact_files+=("$file_path")
  done < <(find "$stage_dir" -type f ! -name '*.md5' ! -name '*.sha1' ! -name '*.sha256' ! -name '*.sha512' -print0 | sort -z)

  if [[ "$sign_artifacts" == true ]]; then
    import_gpg_key_if_needed
    for file_path in "${artifact_files[@]}"; do
      sign_file "$file_path"
    done
  fi

  while IFS= read -r -d '' file_path; do
    write_checksums "$file_path"
  done < <(find "$stage_dir" -type f ! -name '*.md5' ! -name '*.sha1' ! -name '*.sha256' ! -name '*.sha512' -print0 | sort -z)
}

validate_staging() {
  python3 - "$stage_dir" "$release_plan_path" "$sign_artifacts" <<'PY'
import json
import sys
from pathlib import Path

stage = Path(sys.argv[1])
plan = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
signed = sys.argv[3] == "true"
required_suffixes = (".jar", "-sources.jar", "-javadoc.jar", ".pom")
checksum_suffixes = (".md5", ".sha1", ".sha256", ".sha512")

missing = []
for entry in plan["selected"]:
    artifact = entry["artifactId"]
    version = entry["version"]
    artifact_dir = stage / "co" / "logbrew" / artifact / version
    for suffix in required_suffixes:
        path = artifact_dir / f"{artifact}-{version}{suffix}"
        if not path.is_file():
            missing.append(str(path.relative_to(stage)))
            continue
        if signed and not path.with_name(f"{path.name}.asc").is_file():
            missing.append(str(path.with_name(f"{path.name}.asc").relative_to(stage)))
        for checksum_suffix in checksum_suffixes:
            if not path.with_name(f"{path.name}{checksum_suffix}").is_file():
                missing.append(str(path.with_name(f"{path.name}{checksum_suffix}").relative_to(stage)))
if missing:
    raise SystemExit("missing Maven Central bundle files:\n" + "\n".join(missing))
PY
}

zip_bundle() {
  mkdir -p "$(dirname "$output_path")"
  rm -f "$output_path"
  python3 - "$stage_dir" "$output_path" <<'PY'
import sys
import zipfile
from pathlib import Path

stage = Path(sys.argv[1])
output = Path(sys.argv[2])
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(stage.rglob("*")):
        if path.is_file():
            archive.write(path, path.relative_to(stage).as_posix())
PY
}

if artifact_selected "$java_artifact"; then
  build_java_artifacts
  stage_artifact "$java_artifact" "$java_version" "java/logbrew-java"
fi
if artifact_selected "$kotlin_artifact"; then
  build_kotlin_artifacts
  stage_artifact "$kotlin_artifact" "$kotlin_version" "kotlin/logbrew-kotlin"
fi
if artifact_selected "$okhttp_artifact"; then
  build_kotlin_okhttp_artifacts
  stage_artifact "$okhttp_artifact" "$okhttp_version" "kotlin/logbrew-kotlin-okhttp"
fi
finalize_artifacts
validate_staging
zip_bundle
source_commit="$(git -C "$repo_root" rev-parse HEAD)"
python3 "$repo_root"/scripts/maven_release_plan.py manifest \
  --plan "$release_plan_path" \
  --stage "$stage_dir" \
  --bundle "$output_path" \
  --source-commit "$source_commit" \
  --output "$manifest_path"

printf 'maven central bundle built: %s\n' "$output_path"
printf 'maven central manifest built: %s\n' "$manifest_path"
