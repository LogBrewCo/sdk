#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/logbrew-maven-central-public.XXXXXX")"
central_url="https://repo.maven.apache.org/maven2"

java_version="${1:-${LOGBREW_MAVEN_JAVA_VERSION:-0.1.1}}"
kotlin_version="${2:-${LOGBREW_MAVEN_KOTLIN_VERSION:-0.1.1}}"
okhttp_version="${3:-${LOGBREW_MAVEN_KOTLIN_OKHTTP_VERSION:-$kotlin_version}}"
kotlin_stdlib_version="${LOGBREW_MAVEN_KOTLIN_STDLIB_VERSION:-2.4.0}"

on_error() {
    local status=$?
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

export LOGBREW_MAVEN_JAVA_VERSION_UNDER_TEST="$java_version"
export LOGBREW_MAVEN_KOTLIN_VERSION_UNDER_TEST="$kotlin_version"
export LOGBREW_MAVEN_KOTLIN_OKHTTP_VERSION_UNDER_TEST="$okhttp_version"
export LOGBREW_MAVEN_KOTLIN_STDLIB_VERSION_UNDER_TEST="$kotlin_stdlib_version"

curl -fsSL "$central_url/co/logbrew/logbrew-sdk/maven-metadata.xml" > "$tmp_dir/logbrew-sdk-metadata.xml"
curl -fsSL "$central_url/co/logbrew/logbrew-kotlin/maven-metadata.xml" > "$tmp_dir/logbrew-kotlin-metadata.xml"
curl -fsSL "$central_url/co/logbrew/logbrew-kotlin-okhttp/maven-metadata.xml" > "$tmp_dir/logbrew-kotlin-okhttp-metadata.xml"
grep -q "<version>$java_version</version>" "$tmp_dir/logbrew-sdk-metadata.xml"
grep -q "<version>$kotlin_version</version>" "$tmp_dir/logbrew-kotlin-metadata.xml"
grep -q "<version>$okhttp_version</version>" "$tmp_dir/logbrew-kotlin-okhttp-metadata.xml"

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
        mavenCentral()
    }
}

rootProject.name = '$app_name'
EOF
}

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

echo "Maven Central public install smoke passed"
