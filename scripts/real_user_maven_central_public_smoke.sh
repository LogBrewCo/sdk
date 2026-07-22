#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/logbrew-maven-central-public.XXXXXX")"
central_url="https://repo.maven.apache.org/maven2"
receipt_mode="${LOGBREW_RELEASE_RECEIPT_MODE:-0}"
release_plan_path=""
bundle_path=""
legacy_args=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --plan)
            [[ $# -ge 2 ]] || { printf '%s\n' "--plan requires a path" >&2; exit 2; }
            release_plan_path="$2"
            shift 2
            ;;
        --bundle)
            [[ $# -ge 2 ]] || { printf '%s\n' "--bundle requires a path" >&2; exit 2; }
            bundle_path="$2"
            shift 2
            ;;
        *)
            legacy_args+=("$1")
            shift
            ;;
    esac
done

if [[ -n "$bundle_path" && -z "$release_plan_path" ]]; then
    printf '%s\n' "--bundle requires --plan" >&2
    exit 2
fi
if [[ -n "$release_plan_path" && ${#legacy_args[@]} -gt 0 ]]; then
    printf '%s\n' "version arguments cannot be combined with --plan" >&2
    exit 2
fi
if [[ "$receipt_mode" == "1" ]]; then
    [[ -z "$release_plan_path" && ${#legacy_args[@]} -eq 1 ]] || exit 1
elif [[ -n "$release_plan_path" ]]; then
    python3 "$repo_root"/scripts/maven_release_plan.py validate \
        --root "$repo_root" \
        --plan "$release_plan_path"
fi

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

artifact_selected() {
    if [[ -z "$release_plan_path" ]]; then
        return 0
    fi
    [[ -n "$(plan_version "$1")" ]]
}

if [[ "$receipt_mode" == "1" ]]; then
    java_version="${legacy_args[0]}"
    kotlin_version=""
    okhttp_version=""
elif [[ -n "$release_plan_path" ]]; then
    java_version="$(plan_version "logbrew-sdk")"
    kotlin_version="$(plan_version "logbrew-kotlin")"
    okhttp_version="$(plan_version "logbrew-kotlin-okhttp")"
else
    java_version="${legacy_args[0]:-${LOGBREW_MAVEN_JAVA_VERSION:-0.1.2}}"
    kotlin_version="${legacy_args[1]:-${LOGBREW_MAVEN_KOTLIN_VERSION:-0.1.1}}"
    okhttp_version="${legacy_args[2]:-${LOGBREW_MAVEN_KOTLIN_OKHTTP_VERSION:-$kotlin_version}}"
fi
kotlin_stdlib_version="${LOGBREW_MAVEN_KOTLIN_STDLIB_VERSION:-2.4.0}"
selected_modules=()
for artifact in logbrew-sdk logbrew-kotlin logbrew-kotlin-okhttp; do
    if artifact_selected "$artifact"; then
        selected_modules+=("$artifact")
    fi
done
selected_modules_csv="$(IFS=,; printf '%s' "${selected_modules[*]}")"

run_receipt_smoke() {
    local bound="$tmp_dir/receipt-artifacts"
    local metadata="$tmp_dir/receipt-metadata.json"
    python3 "$repo_root/scripts/release_artifact_receipt.py" bind \
        --family "maven" --output-dir "$bound" --metadata "$metadata" \
        >"$tmp_dir/receipt-bind.out" 2>"$tmp_dir/receipt-bind.err"
    unzip -p "$bound/0.jar" META-INF/maven/co.logbrew/logbrew-sdk/pom.properties \
        >"$tmp_dir/receipt-pom.properties"
    grep -qx "version=$java_version" "$tmp_dir/receipt-pom.properties"
    mkdir -p "$tmp_dir/receipt-app/classes"
    cat > "$tmp_dir/receipt-app/Receipt.java" <<'JAVA'
import co.logbrew.sdk.LogAttributes;
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.RecordingTransport;
import co.logbrew.sdk.TransportResponse;

public final class Receipt {
    public static void main(String[] args) {
        LogBrewClient client = LogBrewClient.create("key", "receipt", "0.1.0");
        client.log("event", "2026-01-01T00:00:00Z", LogAttributes.create("ok", "info"));
        TransportResponse response = client.shutdown(RecordingTransport.alwaysAccept());
        if (response.statusCode() != 202) {
            throw new IllegalStateException("receipt execution failed");
        }
    }
}
JAVA
    javac -cp "$bound/0.jar" -d "$tmp_dir/receipt-app/classes" \
        "$tmp_dir/receipt-app/Receipt.java" \
        >"$tmp_dir/receipt-javac.out" 2>"$tmp_dir/receipt-javac.err"
    java -cp "$bound/0.jar:$tmp_dir/receipt-app/classes" Receipt \
        >"$tmp_dir/receipt-run.out" 2>"$tmp_dir/receipt-run.err"
    python3 "$repo_root/scripts/release_artifact_receipt.py" attest \
        --family "maven" --metadata "$metadata"
}

if [[ "$receipt_mode" == "1" ]]; then
    [[ -n "$java_version" && -z "$kotlin_version" && -z "$okhttp_version" ]] || exit 1
    run_receipt_smoke
    exit 0
fi

on_error() {
    local status=$?
    if [[ "$receipt_mode" == "1" ]]; then
        echo "Maven release receipt failed" >&2
        exit "$status"
    fi
    echo "real_user_maven_central_public_smoke failed at line ${BASH_LINENO[0]} while running: ${BASH_COMMAND}" >&2
    for diagnostic in \
        "$tmp_dir/logbrew-sdk-metadata.xml" \
        "$tmp_dir/logbrew-kotlin-metadata.xml" \
        "$tmp_dir/logbrew-kotlin-okhttp-metadata.xml" \
        "$tmp_dir/java-dependency-insight.txt" \
        "$tmp_dir/kotlin-dependency-insight.txt" \
        "$tmp_dir/okhttp-dependency-insight.txt" \
        "$tmp_dir/java-run.out" \
        "$tmp_dir/kotlin-run.out" \
        "$tmp_dir/okhttp-run.out"; do
        if [[ -f "$diagnostic" ]]; then
            echo "--- ${diagnostic#"$tmp_dir"/} ---" >&2
            sed -n '1,120p' "$diagnostic" >&2
        fi
    done
    exit "$status"
}

trap 'rm -rf "$tmp_dir"' EXIT
trap on_error ERR

cd "$repo_root"

repository_url="$central_url"
if [[ -n "$bundle_path" ]]; then
    bundle_repository="$tmp_dir/bundle-repository"
    python3 - "$bundle_path" "$bundle_repository" <<'PY'
import sys
import zipfile
from pathlib import Path, PurePosixPath

bundle = Path(sys.argv[1])
repository = Path(sys.argv[2])
with zipfile.ZipFile(bundle) as archive:
    for name in archive.namelist():
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts:
            raise SystemExit("invalid Maven bundle entry")
    archive.extractall(repository)
PY
    repository_url="$(python3 - "$bundle_repository" <<'PY'
import sys
from pathlib import Path

print(Path(sys.argv[1]).resolve().as_uri())
PY
)"
fi

export LOGBREW_MAVEN_JAVA_VERSION_UNDER_TEST="$java_version"
export LOGBREW_MAVEN_KOTLIN_VERSION_UNDER_TEST="$kotlin_version"
export LOGBREW_MAVEN_KOTLIN_OKHTTP_VERSION_UNDER_TEST="$okhttp_version"
export LOGBREW_MAVEN_KOTLIN_STDLIB_VERSION_UNDER_TEST="$kotlin_stdlib_version"
export LOGBREW_MAVEN_REPOSITORY_UNDER_TEST="$repository_url"
export LOGBREW_MAVEN_SELECTED_MODULES="$selected_modules_csv"

if [[ -z "$bundle_path" ]] && artifact_selected "logbrew-sdk"; then
    curl -fsSL "$central_url/co/logbrew/logbrew-sdk/maven-metadata.xml" > "$tmp_dir/logbrew-sdk-metadata.xml"
    grep -q "<version>$java_version</version>" "$tmp_dir/logbrew-sdk-metadata.xml"
fi
if [[ -z "$bundle_path" ]] && artifact_selected "logbrew-kotlin"; then
    curl -fsSL "$central_url/co/logbrew/logbrew-kotlin/maven-metadata.xml" > "$tmp_dir/logbrew-kotlin-metadata.xml"
    grep -q "<version>$kotlin_version</version>" "$tmp_dir/logbrew-kotlin-metadata.xml"
fi
if [[ -z "$bundle_path" ]] && artifact_selected "logbrew-kotlin-okhttp"; then
    curl -fsSL "$central_url/co/logbrew/logbrew-kotlin-okhttp/maven-metadata.xml" > "$tmp_dir/logbrew-kotlin-okhttp-metadata.xml"
    grep -q "<version>$okhttp_version</version>" "$tmp_dir/logbrew-kotlin-okhttp-metadata.xml"
fi

run_gradle() {
    local app_dir="$1"
    shift
    (
        cd "$app_dir"
        gradle --no-daemon -q --gradle-user-home "$tmp_dir/gradle-home" "$@"
    )
}

write_gradle_settings() {
    local app_dir="$1"
    local app_name="$2"

    cat > "$app_dir/settings.gradle" <<EOF
pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        def selectedLogBrewArtifacts = System.getenv('LOGBREW_MAVEN_SELECTED_MODULES').split(',')
        exclusiveContent {
            forRepository {
                maven {
                    url = uri(System.getenv('LOGBREW_MAVEN_REPOSITORY_UNDER_TEST'))
                }
            }
            filter {
                selectedLogBrewArtifacts.each { artifact -> includeModule('co.logbrew', artifact) }
            }
        }
        mavenCentral()
    }
}

rootProject.name = '$app_name'
EOF
}

if artifact_selected "logbrew-sdk"; then
    java_app="$tmp_dir/java-public-maven-app"
    mkdir -p "$java_app/src/main/java/smoke"
    write_gradle_settings "$java_app" "logbrew-java-public-maven-smoke"
    cat > "$java_app/build.gradle" <<'EOF'
plugins {
    id 'application'
}

def javaVersion = System.getenv('LOGBREW_MAVEN_JAVA_VERSION_UNDER_TEST')

dependencies {
    implementation("co.logbrew:logbrew-sdk:$javaVersion")
}

application {
    mainClass = 'smoke.JavaMavenCentralSmoke'
}
EOF
cat > "$java_app/src/main/java/smoke/JavaMavenCentralSmoke.java" <<'JAVA'
package smoke;

import co.logbrew.sdk.LogAttributes;
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.RecordingTransport;
import co.logbrew.sdk.TransportResponse;

public final class JavaMavenCentralSmoke {
    public static void main(String[] args) {
        LogBrewClient client = LogBrewClient.create("LOGBREW_API_KEY", "maven-central-java-smoke", "0.1.0", 1);
        client.log(
            "evt_maven_central_java_smoke",
            "2026-07-01T00:00:00Z",
            LogAttributes.create("public Maven Central Java smoke", "info").logger("maven-central-smoke")
        );
        TransportResponse response = client.flush(RecordingTransport.alwaysAccept());
        if (response.statusCode() != 202) {
            throw new IllegalStateException("expected Java flush status 202");
        }
        if (client.pendingEvents() != 0) {
            throw new IllegalStateException("expected Java queue to be empty after flush");
        }
        System.out.println("flush-status=" + response.statusCode());
        System.out.println("java-attempts=" + response.attempts());
    }
}
JAVA

    run_gradle "$java_app" dependencyInsight --dependency co.logbrew:logbrew-sdk --configuration runtimeClasspath \
        > "$tmp_dir/java-dependency-insight.txt"
    grep -q "co.logbrew:logbrew-sdk:$java_version" "$tmp_dir/java-dependency-insight.txt"
    run_gradle "$java_app" run > "$tmp_dir/java-run.out"
    grep -q "flush-status=202" "$tmp_dir/java-run.out"
fi

if artifact_selected "logbrew-kotlin"; then
    kotlin_app="$tmp_dir/kotlin-public-maven-app"
    mkdir -p "$kotlin_app/src/main/java/smoke"
    write_gradle_settings "$kotlin_app" "logbrew-kotlin-public-maven-smoke"
    cat > "$kotlin_app/build.gradle" <<'EOF'
plugins {
    id 'application'
}

def kotlinVersion = System.getenv('LOGBREW_MAVEN_KOTLIN_VERSION_UNDER_TEST')
def kotlinStdlibVersion = System.getenv('LOGBREW_MAVEN_KOTLIN_STDLIB_VERSION_UNDER_TEST')

dependencies {
    implementation("co.logbrew:logbrew-kotlin:$kotlinVersion")
    implementation("org.jetbrains.kotlin:kotlin-stdlib:$kotlinStdlibVersion")
}

application {
    mainClass = 'smoke.KotlinMavenCentralSmoke'
}
EOF
cat > "$kotlin_app/src/main/java/smoke/KotlinMavenCentralSmoke.java" <<'JAVA'
package smoke;

import co.logbrew.sdk.LogAttributes;
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.RecordingTransport;
import co.logbrew.sdk.TransportResponse;

public final class KotlinMavenCentralSmoke {
    public static void main(String[] args) {
        LogBrewClient client = LogBrewClient.Companion.create("LOGBREW_API_KEY", "maven-central-kotlin-smoke", "0.1.0", 1);
        client.log(
            "evt_maven_central_kotlin_smoke",
            "2026-07-01T00:00:00Z",
            LogAttributes.Companion.create("public Maven Central Kotlin smoke", "info")
        );
        TransportResponse response = client.flush(RecordingTransport.Companion.alwaysAccept());
        if (response.getStatusCode() != 202) {
            throw new IllegalStateException("expected Kotlin flush status 202");
        }
        if (client.pendingEvents() != 0) {
            throw new IllegalStateException("expected Kotlin queue to be empty after flush");
        }
        System.out.println("kotlin-status=" + response.getStatusCode());
        System.out.println("kotlin-attempts=" + response.getAttempts());
    }
}
JAVA

    run_gradle "$kotlin_app" dependencyInsight --dependency co.logbrew:logbrew-kotlin --configuration runtimeClasspath \
        > "$tmp_dir/kotlin-dependency-insight.txt"
    grep -q "co.logbrew:logbrew-kotlin:$kotlin_version" "$tmp_dir/kotlin-dependency-insight.txt"
    run_gradle "$kotlin_app" run > "$tmp_dir/kotlin-run.out"
    grep -q "kotlin-status=202" "$tmp_dir/kotlin-run.out"
fi

if artifact_selected "logbrew-kotlin-okhttp"; then
    okhttp_app="$tmp_dir/okhttp-public-maven-app"
    mkdir -p "$okhttp_app/src/main/java/smoke"
    write_gradle_settings "$okhttp_app" "logbrew-kotlin-okhttp-public-maven-smoke"
    cat > "$okhttp_app/build.gradle" <<'EOF'
plugins {
    id 'application'
}

def okhttpVersion = System.getenv('LOGBREW_MAVEN_KOTLIN_OKHTTP_VERSION_UNDER_TEST')
def kotlinStdlibVersion = System.getenv('LOGBREW_MAVEN_KOTLIN_STDLIB_VERSION_UNDER_TEST')

dependencies {
    implementation("co.logbrew:logbrew-kotlin-okhttp:$okhttpVersion")
    implementation("org.jetbrains.kotlin:kotlin-stdlib:$kotlinStdlibVersion")
}

application {
    mainClass = 'smoke.KotlinOkHttpMavenCentralSmoke'
}
EOF
cat > "$okhttp_app/src/main/java/smoke/KotlinOkHttpMavenCentralSmoke.java" <<'JAVA'
package smoke;

import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.okhttp.LogBrewOkHttpCallFactory;
import co.logbrew.sdk.okhttp.LogBrewOkHttpInterceptor;
import co.logbrew.sdk.okhttp.LogBrewOkHttpRouteTemplates;
import okhttp3.OkHttpClient;
import okhttp3.Request;

public final class KotlinOkHttpMavenCentralSmoke {
    public static void main(String[] args) {
        Request original = new Request.Builder()
            .url("https://api.example.com/api/orders/123?page=2")
            .build();
        Request tagged = LogBrewOkHttpRouteTemplates.tag(original, "GET /api/orders/{order_id}");
        String route = LogBrewOkHttpRouteTemplates.get(tagged);
        if (!"GET /api/orders/{order_id}".equals(route)) {
            throw new IllegalStateException("expected route template tag from installed OkHttp artifact");
        }

        LogBrewClient client = LogBrewClient.Companion.create(
            "LOGBREW_API_KEY",
            "maven-central-kotlin-okhttp-smoke",
            "0.1.0",
            1
        );
        LogBrewOkHttpInterceptor interceptor = new LogBrewOkHttpInterceptor(client);
        LogBrewOkHttpCallFactory callFactory = new LogBrewOkHttpCallFactory(new OkHttpClient());
        if (interceptor == null || callFactory == null) {
            throw new IllegalStateException("expected installed OkHttp helpers to be constructible");
        }
        System.out.println("okhttp-route=" + route);
    }
}
JAVA

    run_gradle "$okhttp_app" dependencyInsight --dependency co.logbrew:logbrew-kotlin-okhttp --configuration runtimeClasspath \
        > "$tmp_dir/okhttp-dependency-insight.txt"
    grep -q "co.logbrew:logbrew-kotlin-okhttp:$okhttp_version" "$tmp_dir/okhttp-dependency-insight.txt"
    run_gradle "$okhttp_app" run > "$tmp_dir/okhttp-run.out"
    grep -q "okhttp-route=GET /api/orders/{order_id}" "$tmp_dir/okhttp-run.out"
fi

echo "Maven Central public install smoke passed"
