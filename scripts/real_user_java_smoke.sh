#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/java/logbrew-java"
tmp_dir="$(mktemp -d)"
# shellcheck source=scripts/java_logback_deps.sh
source "$repo_root/scripts/java_logback_deps.sh"

read_pom_version() {
  python3 - "$1" <<'PY'
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
namespace = {"m": "http://maven.apache.org/POM/4.0.0"}
version = root.findtext("m:version", namespaces=namespace)
if not version:
    raise SystemExit(f"missing POM version in {sys.argv[1]}")
print(version)
PY
}

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT
java_version="$(read_pom_version "$package_dir/pom.xml")"
java_jar="$tmp_dir/logbrew-sdk-$java_version.jar"
java_sources_jar="$tmp_dir/logbrew-sdk-$java_version-sources.jar"
main_sources="$tmp_dir/main-sources.txt"
example_sources="$tmp_dir/example-sources.txt"
find "$package_dir/src/main/java" -name '*.java' | sort > "$main_sources"
find "$package_dir/examples" -name '*.java' | sort > "$example_sources"
mkdir -p "$tmp_dir/classes" "$tmp_dir/jar-stage" "$tmp_dir/source-stage" "$tmp_dir/example-classes"
java_logback_classpath="$(fetch_java_logback_deps "$tmp_dir/java-logback-deps")"
java_opentelemetry_classpath="$(fetch_java_opentelemetry_deps "$tmp_dir/java-opentelemetry-deps")"
java_servlet_classpath="$(fetch_java_servlet_deps "$tmp_dir/java-servlet-deps")"
java_spring_boot_classpath="$(fetch_java_spring_boot_deps "$tmp_dir/java-spring-boot-deps")"
java_spring_kafka_classpath="$(fetch_java_spring_kafka_deps "$tmp_dir/java-spring-kafka-deps")"
java_spring_web_classpath="$(fetch_java_spring_web_deps "$tmp_dir/java-spring-web-deps")"
java_optional_classpath="$java_logback_classpath:$java_opentelemetry_classpath:$java_servlet_classpath:$java_spring_boot_classpath:$java_spring_kafka_classpath:$java_spring_web_classpath"
javac -Xlint:all -Werror --release 11 -cp "$java_optional_classpath" -d "$tmp_dir/classes" @"$main_sources"

mkdir -p "$tmp_dir/jar-stage/META-INF/maven/co.logbrew/logbrew-sdk"
cp "$package_dir/pom.xml" "$tmp_dir/jar-stage/META-INF/maven/co.logbrew/logbrew-sdk/pom.xml"
cp "$package_dir/README.md" "$tmp_dir/jar-stage/README.md"
cp -R "$tmp_dir/classes/co" "$tmp_dir/jar-stage/co"
if [ -d "$package_dir/src/main/resources" ]; then
  cp -R "$package_dir/src/main/resources/." "$tmp_dir/jar-stage/"
fi
jar --create --file "$java_jar" -C "$tmp_dir/jar-stage" .
cp "$package_dir/pom.xml" "$tmp_dir/source-stage/pom.xml"
cp "$package_dir/README.md" "$tmp_dir/source-stage/README.md"
cp -R "$package_dir/src" "$tmp_dir/source-stage/src"
cp -R "$package_dir/examples" "$tmp_dir/source-stage/examples"
jar --create --file "$java_sources_jar" -C "$tmp_dir/source-stage" .
jar --list --file "$java_jar" > "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewClient.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewClient\$EventDrop.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewClient\$EventDroppedHandler.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/HttpTransport.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/HttpTransport\$Builder.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/MetricAttributes.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/ProductTimeline.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/ProductTimeline\$ProductAction.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/ProductTimeline\$NetworkMilestone.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/Traceparent.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/Traceparent\$Context.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/Traceparent\$SpanInput.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewTraceContext.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewTrace.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewTrace\$Scope.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewOpenTelemetry.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/SpanEventSummary.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewHttpClientTracing.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewHttpClientTracing\$ClientRequest.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewHttpRequestTelemetry.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewServletFilter.class$' "$tmp_dir/binary-jar-contents.txt"
while IFS= read -r expected; do
  grep -Fxq "$expected" "$tmp_dir/binary-jar-contents.txt"
done < <(printf '%s\n' \
  'co/logbrew/sdk/LogBrewSpringBootAutoConfiguration.class' \
  'co/logbrew/sdk/LogBrewSpringBootCacheAutoConfiguration.class' \
  'co/logbrew/sdk/LogBrewSpringBootCacheManagerPostProcessor.class' \
  'co/logbrew/sdk/LogBrewSpringCacheTracing.class' \
  'co/logbrew/sdk/LogBrewSpringCacheTracing$CacheConfig.class' \
  'co/logbrew/sdk/LogBrewSpringBootJdbcAutoConfiguration.class' \
  'co/logbrew/sdk/LogBrewSpringBootJdbcDataSourcePostProcessor.class' \
  'co/logbrew/sdk/LogBrewSpringBootJdbcDataSourcePostProcessor$SingleLogBrewClientProvider.class' \
  'co/logbrew/sdk/LogBrewSpringBootKafkaAutoConfiguration.class' \
  'co/logbrew/sdk/LogBrewSpringBootKafkaBeanPostProcessor.class' \
  'co/logbrew/sdk/LogBrewSpringBootKafkaBeanPostProcessor$LogBrewKafkaProducerPostProcessor.class' \
  'co/logbrew/sdk/LogBrewSpringBootKafkaBeanPostProcessor$SingleLogBrewClientProvider.class' \
  'co/logbrew/sdk/LogBrewSpringKafkaTracing.class' \
  'co/logbrew/sdk/LogBrewSpringKafkaTracing$ConsumerConfig.class' \
  'co/logbrew/sdk/LogBrewSpringKafkaTracing$ProducerConfig.class')
grep -q '^co/logbrew/sdk/LogBrewOperationTracing.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewOperationTracing\$DatabaseOperation.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewOperationTracing\$CacheOperation.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewOperationTracing\$QueueOperation.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewJdbcTracing.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewJdbcTracing\$ConnectionConfig.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/SupportTicketDraft.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/SupportTicketDraft\$Input.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewJulHandler.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewLogbackAppender.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/Transport.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/RecordingTransport.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^META-INF/maven/co.logbrew/logbrew-sdk/pom.xml$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^README.md$' "$tmp_dir/binary-jar-contents.txt"

jar --list --file "$java_sources_jar" > "$tmp_dir/source-jar-contents.txt"
grep -q '^pom.xml$' "$tmp_dir/source-jar-contents.txt"
grep -q '^README.md$' "$tmp_dir/source-jar-contents.txt"
grep -q '^src/main/java/co/logbrew/sdk/LogBrewClient.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^src/main/java/co/logbrew/sdk/HttpTransport.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^src/main/java/co/logbrew/sdk/MetricAttributes.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^src/main/java/co/logbrew/sdk/ProductTimeline.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^src/main/java/co/logbrew/sdk/Traceparent.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^src/main/java/co/logbrew/sdk/LogBrewTraceContext.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^src/main/java/co/logbrew/sdk/LogBrewTrace.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^src/main/java/co/logbrew/sdk/LogBrewOpenTelemetry.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^src/main/java/co/logbrew/sdk/SpanEventSummary.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^src/main/java/co/logbrew/sdk/LogBrewHttpClientTracing.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^src/main/java/co/logbrew/sdk/LogBrewHttpRequestTelemetry.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^src/main/java/co/logbrew/sdk/LogBrewServletFilter.java$' "$tmp_dir/source-jar-contents.txt"
while IFS= read -r expected; do
  grep -Fxq "$expected" "$tmp_dir/source-jar-contents.txt"
done < <(printf '%s\n' \
  'src/main/java/co/logbrew/sdk/LogBrewSpringBootAutoConfiguration.java' \
  'src/main/java/co/logbrew/sdk/LogBrewSpringBootCacheAutoConfiguration.java' \
  'src/main/java/co/logbrew/sdk/LogBrewSpringBootCacheManagerPostProcessor.java' \
  'src/main/java/co/logbrew/sdk/LogBrewSpringCacheTracing.java' \
  'src/main/java/co/logbrew/sdk/LogBrewSpringBootJdbcAutoConfiguration.java' \
  'src/main/java/co/logbrew/sdk/LogBrewSpringBootJdbcDataSourcePostProcessor.java' \
  'src/main/java/co/logbrew/sdk/LogBrewSpringBootKafkaAutoConfiguration.java' \
  'src/main/java/co/logbrew/sdk/LogBrewSpringBootKafkaBeanPostProcessor.java' \
  'src/main/java/co/logbrew/sdk/LogBrewSpringKafkaTracing.java')
grep -q '^src/main/java/co/logbrew/sdk/LogBrewOperationTracing.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^src/main/java/co/logbrew/sdk/LogBrewJdbcTracing.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^src/main/java/co/logbrew/sdk/SupportTicketDraft.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^src/main/java/co/logbrew/sdk/LogBrewJulHandler.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^src/main/java/co/logbrew/sdk/LogBrewLogbackAppender.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports$' "$tmp_dir/source-jar-contents.txt"
grep -q '^examples/FirstUsefulTelemetry.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^examples/HttpTraceCorrelation.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^examples/ReadmeExample.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^examples/RealUserSmoke.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^examples/Makefile$' "$tmp_dir/source-jar-contents.txt"

grep -q '<groupId>co.logbrew</groupId>' "$package_dir/pom.xml"
grep -q '<artifactId>logbrew-sdk</artifactId>' "$package_dir/pom.xml"
grep -q "<version>${java_version}</version>" "$package_dir/pom.xml"
grep -q 'LogBrewClient.create' "$package_dir/README.md"
grep -q 'HttpTransport' "$package_dir/README.md"
grep -q 'MetricAttributes' "$package_dir/README.md"
grep -q 'ProductTimeline' "$package_dir/README.md"
grep -q 'Traceparent' "$package_dir/README.md"
grep -q 'LogBrewOpenTelemetry' "$package_dir/README.md"
grep -q 'LogBrewHttpClientTracing' "$package_dir/README.md"
grep -q 'LogBrewOperationTracing' "$package_dir/README.md"
grep -q 'LogBrewJdbcTracing' "$package_dir/README.md"
grep -q 'LogBrewServletFilter' "$package_dir/README.md"
while IFS= read -r expected; do
  grep -Fq "$expected" "$package_dir/README.md"
done < <(printf '%s\n' \
  'LogBrewSpringBootAutoConfiguration' \
  'LogBrewSpringBootCacheAutoConfiguration' \
  'LogBrewSpringCacheTracing' \
  'LogBrewSpringBootJdbcAutoConfiguration' \
  'LogBrewSpringBootKafkaAutoConfiguration' \
  'LogBrewSpringKafkaTracing' \
  'producerPostProcessor' \
  'producerSend' \
  'ProducerConfig')
grep -q 'SupportTicketDraft' "$package_dir/README.md"
grep -q 'droppedEvents()' "$package_dir/README.md"
grep -q 'maxQueueSize' "$package_dir/README.md"
grep -q 'first useful LogBrew payload' "$package_dir/README.md"
grep -q 'without visual replay, HTTP client patching, request/response payload capture, or header capture' "$package_dir/README.md"
grep -q 'This SDK does not automatically collect JVM, runtime, or framework metrics yet.' "$package_dir/README.md"
grep -q 'java.net.http' "$package_dir/README.md"
grep -q 'LogBrewJulHandler' "$package_dir/README.md"
grep -q 'LogBrewLogbackAppender' "$package_dir/README.md"
grep -q 'java.util.logging' "$package_dir/README.md"
grep -q 'Logback' "$package_dir/README.md"
grep -q 'copyable snippets' "$package_dir/README.md"
extract_dir="$tmp_dir/source-extract"
mkdir -p "$extract_dir"
(cd "$extract_dir" && jar --extract --file "$java_sources_jar")
test -f "$extract_dir/examples/Makefile"
make -C "$extract_dir/examples" > "$tmp_dir/extracted-examples-help.txt"
grep -Fxq 'run-readme-example -> make run-readme-example' "$tmp_dir/extracted-examples-help.txt"
grep -Fxq 'run-first-useful-telemetry -> make run-first-useful-telemetry' "$tmp_dir/extracted-examples-help.txt"
grep -Fxq 'run-http-trace-correlation -> make run-http-trace-correlation' "$tmp_dir/extracted-examples-help.txt"
grep -Fxq 'run (real-user-smoke) -> make run' "$tmp_dir/extracted-examples-help.txt"
grep -Fxq 'run-real-user-smoke -> make run-real-user-smoke' "$tmp_dir/extracted-examples-help.txt"
(cd "$extract_dir/examples" && make run-readme-example) > "$tmp_dir/extracted-readme-default.stdout.json" 2> "$tmp_dir/extracted-readme-default.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/extracted-readme-default.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/extracted-readme-default.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/extracted-readme-default.stderr.json"
(cd "$extract_dir/examples" && make LOGBREW_JAVA_EXTRA_CP="$java_optional_classpath" run-readme-example) > "$tmp_dir/extracted-readme.stdout.json" 2> "$tmp_dir/extracted-readme.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/extracted-readme.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/extracted-readme.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/extracted-readme.stderr.json"
(cd "$extract_dir/examples" && make LOGBREW_JAVA_EXTRA_CP="$java_optional_classpath" run) > "$tmp_dir/extracted-smoke-alias.stdout.json" 2> "$tmp_dir/extracted-smoke-alias.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/extracted-smoke-alias.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/extracted-smoke-alias.stdout.json" >/dev/null
grep -q '"retryAttempts":2' "$tmp_dir/extracted-smoke-alias.stderr.json"
grep -q '"supportDraftRedacted":true' "$tmp_dir/extracted-smoke-alias.stderr.json"
(cd "$extract_dir/examples" && make LOGBREW_JAVA_EXTRA_CP="$java_optional_classpath" run-first-useful-telemetry) > "$tmp_dir/extracted-first-useful.stdout.json" 2> "$tmp_dir/extracted-first-useful.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/extracted-first-useful.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_java_first_useful_payload.py" "$tmp_dir/extracted-first-useful.stdout.json" "$tmp_dir/extracted-first-useful.stderr.json" >/dev/null
(cd "$extract_dir/examples" && make LOGBREW_JAVA_EXTRA_CP="$java_optional_classpath" run-http-trace-correlation) > "$tmp_dir/extracted-http-trace.stdout.json" 2> "$tmp_dir/extracted-http-trace.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/extracted-http-trace.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_java_http_trace_payload.py" "$tmp_dir/extracted-http-trace.stdout.json" "$tmp_dir/extracted-http-trace.stderr.json" >/dev/null

javac -Xlint:all -Werror --release 11 -cp "$java_jar:$java_optional_classpath" -d "$tmp_dir/example-classes" @"$example_sources"
java -cp "$java_jar:$tmp_dir/example-classes:$java_optional_classpath" ReadmeExample > "$tmp_dir/packaged-readme.stdout.json" 2> "$tmp_dir/packaged-readme.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/packaged-readme.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/packaged-readme.stdout.json" >/dev/null
grep -q '"events":6' "$tmp_dir/packaged-readme.stderr.json"
java -cp "$java_jar:$tmp_dir/example-classes:$java_optional_classpath" RealUserSmoke > "$tmp_dir/packaged-smoke.stdout.json" 2> "$tmp_dir/packaged-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/packaged-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/packaged-smoke.stdout.json" >/dev/null
grep -q '"retryAttempts":2' "$tmp_dir/packaged-smoke.stderr.json"
grep -q '"supportDraftRedacted":true' "$tmp_dir/packaged-smoke.stderr.json"
java -cp "$java_jar:$tmp_dir/example-classes:$java_optional_classpath" FirstUsefulTelemetry > "$tmp_dir/packaged-first-useful.stdout.json" 2> "$tmp_dir/packaged-first-useful.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/packaged-first-useful.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_java_first_useful_payload.py" "$tmp_dir/packaged-first-useful.stdout.json" "$tmp_dir/packaged-first-useful.stderr.json" >/dev/null
java -cp "$java_jar:$tmp_dir/example-classes:$java_optional_classpath" HttpTraceCorrelation > "$tmp_dir/packaged-http-trace.stdout.json" 2> "$tmp_dir/packaged-http-trace.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/packaged-http-trace.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_java_http_trace_payload.py" "$tmp_dir/packaged-http-trace.stdout.json" "$tmp_dir/packaged-http-trace.stderr.json" >/dev/null

lifecycle_app="$tmp_dir/lifecycle-app"
mkdir -p "$lifecycle_app/lib" "$lifecycle_app/src" "$lifecycle_app/classes"
cp "$java_jar" "$lifecycle_app/lib/logbrew-sdk-$java_version.jar"
cat > "$lifecycle_app/src/LifecycleApp.java" <<'JAVA'
import co.logbrew.sdk.LogBrewClient;

public final class LifecycleApp {
    private LifecycleApp() {
    }

    public static void main(String[] args) throws Exception {
        LogBrewClient client = LogBrewClient.create("LOGBREW_API_KEY", "lifecycle-app", "0.1.0");
        System.out.println(client.pendingEvents());
    }
}
JAVA
javac -Xlint:all -Werror --release 11 -cp "$lifecycle_app/lib/logbrew-sdk-$java_version.jar:$java_optional_classpath" -d "$lifecycle_app/classes" "$lifecycle_app/src/LifecycleApp.java"
java -cp "$lifecycle_app/lib/logbrew-sdk-$java_version.jar:$lifecycle_app/classes:$java_optional_classpath" LifecycleApp > "$tmp_dir/lifecycle.out"
grep -qx '0' "$tmp_dir/lifecycle.out"
rm "$lifecycle_app/lib/logbrew-sdk-$java_version.jar"
if javac -Xlint:all -Werror --release 11 -cp "$lifecycle_app/lib/logbrew-sdk-$java_version.jar" -d "$lifecycle_app/classes-missing" "$lifecycle_app/src/LifecycleApp.java" 2> "$tmp_dir/lifecycle-missing.err"; then
  echo "expected lifecycle app compile to fail after removing SDK jar" >&2
  exit 1
fi
test -s "$tmp_dir/lifecycle-missing.err"
cp "$java_jar" "$lifecycle_app/lib/logbrew-sdk-$java_version.jar"
javac -Xlint:all -Werror --release 11 -cp "$lifecycle_app/lib/logbrew-sdk-$java_version.jar:$java_optional_classpath" -d "$lifecycle_app/classes-readded" "$lifecycle_app/src/LifecycleApp.java"

smoke_app="$tmp_dir/smoke-app"
mkdir -p "$smoke_app/lib" "$smoke_app/src" "$smoke_app/classes"
cp "$java_jar" "$smoke_app/lib/logbrew-sdk-$java_version.jar"
cat > "$smoke_app/src/Main.java" <<'JAVA'
import co.logbrew.sdk.ActionAttributes;
import co.logbrew.sdk.EnvironmentAttributes;
import co.logbrew.sdk.HttpTransport;
import co.logbrew.sdk.IssueAttributes;
import co.logbrew.sdk.LogAttributes;
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.LogBrewHttpClientTracing;
import co.logbrew.sdk.LogBrewJulHandler;
import co.logbrew.sdk.LogBrewLogbackAppender;
import co.logbrew.sdk.LogBrewJdbcTracing;
import co.logbrew.sdk.LogBrewOpenTelemetry;
import co.logbrew.sdk.LogBrewOperationTracing;
import co.logbrew.sdk.LogBrewTrace;
import co.logbrew.sdk.LogBrewTraceContext;
import co.logbrew.sdk.MetricAttributes;
import co.logbrew.sdk.ProductTimeline;
import co.logbrew.sdk.RecordingTransport;
import co.logbrew.sdk.ReleaseAttributes;
import co.logbrew.sdk.SdkException;
import co.logbrew.sdk.SpanAttributes;
import co.logbrew.sdk.SpanEventSummary;
import co.logbrew.sdk.SupportTicketDraft;
import co.logbrew.sdk.TransportException;
import co.logbrew.sdk.TransportResponse;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanContext;
import io.opentelemetry.api.trace.TraceFlags;
import io.opentelemetry.api.trace.TraceState;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import java.io.IOException;
import java.net.Authenticator;
import java.net.CookieHandler;
import java.net.InetSocketAddress;
import java.net.ProxySelector;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.net.http.HttpClient;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.Collections;
import java.util.Map;
import java.util.Optional;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import javax.sql.DataSource;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.Logger;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSession;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;

public final class Main {
    private Main() {
    }

    public static void main(String[] args) throws Exception {
        LogBrewClient client = LogBrewClient.create("LOGBREW_API_KEY", "smoke-app", "0.1.0");
        enqueueAll(client);
        System.out.println(client.previewJson());
        TransportResponse response = client.flush(RecordingTransport.alwaysAccept());
        if (response.statusCode() != 202 || response.attempts() != 1 || client.pendingEvents() != 0) {
            throw new AssertionError("unexpected successful flush state");
        }

        TransportResponse empty = client.flush(RecordingTransport.alwaysAccept());
        require(empty.statusCode() == 204 && empty.attempts() == 0, "empty flush");

        SupportTicketDraft supportDraft = SupportTicketDraft.create(SupportTicketDraft.Input
            .create("sdk", "ingest_failure", "Telemetry flush failed", "Flush returned usage_limit_exceeded")
            .runtime("java 21")
            .sdkPackage("co.logbrew:logbrew-sdk")
            .sdkVersion("0.1.0")
            .traceId("4BF92F3577B34DA6A3CE929D0E0E4736")
            .diagnostics(Map.of(
                "apiKey", "lbw_ingest_hidden",
                "endpoint", "https://api.example/ingest?debug=true",
                "error", new IllegalStateException("private detail")
            )));
        String supportDraftJson = supportDraft.toJson();
        require(supportDraft.traceId().equals("4bf92f3577b34da6a3ce929d0e0e4736"), "support draft trace id");
        require(supportDraftJson.contains("[redacted]"), "support draft redaction placeholder");
        require(supportDraftJson.contains("[redacted-url]/ingest"), "support draft redacts URL origin");
        require(supportDraftJson.contains("java.lang.IllegalStateException"), "support draft keeps exception type");
        require(!supportDraftJson.contains("hidden"), "support draft omits raw sample");
        require(!supportDraftJson.contains("api.example"), "support draft omits URL origin");
        require(!supportDraftJson.contains("private detail"), "support draft omits exception message");

        LogBrewClient metrics = LogBrewClient.create("LOGBREW_API_KEY", "smoke-app", "0.1.0");
        metrics.metric(
            "evt_metric_queue_depth",
            "2026-06-02T10:00:06Z",
            MetricAttributes.create("queue.depth", "gauge", -2.0, "{items}", "instant")
                .metadata(Collections.singletonMap("service", "worker"))
        );
        String metricPayload = metrics.previewJson();
        require(metrics.pendingEvents() == 1, "metric queues one event");
        require(metricPayload.contains("\"type\": \"metric\""), "metric event type");
        require(metricPayload.contains("\"name\": \"queue.depth\""), "metric name");
        require(metricPayload.contains("\"kind\": \"gauge\""), "metric kind");
        require(metricPayload.contains("\"value\": -2.0"), "metric value");
        require(metricPayload.contains("\"temporality\": \"instant\""), "metric temporality");
        expect("validation_error", () -> metrics.metric(
            "evt_metric_invalid_value",
            "2026-06-02T10:00:06Z",
            MetricAttributes.create("queue.depth", "gauge", Double.NaN, "{items}", "instant")
        ));
        expect("validation_error", () -> metrics.metric(
            "evt_metric_invalid_counter",
            "2026-06-02T10:00:06Z",
            MetricAttributes.create("jobs.completed", "counter", -1.0, "1", "delta")
        ));
        expect("validation_error", () -> metrics.metric(
            "evt_metric_invalid_temporality",
            "2026-06-02T10:00:06Z",
            MetricAttributes.create("queue.depth", "gauge", 2.0, "{items}", "delta")
        ));

        LogBrewClient timeline = LogBrewClient.create("LOGBREW_API_KEY", "smoke-app", "0.1.0");
        timeline.action(
            "evt_timeline_action",
            "2026-06-02T10:00:05Z",
            ProductTimeline.productAction("checkout.submit")
                .routeTemplate("https://shop.example/checkout/:step?cart=sample#review")
                .sessionId("session_123")
                .traceId("trace_abc")
                .screen("Checkout")
                .funnel("checkout")
                .step("submit")
                .metadata(Collections.singletonMap("cartTier", "gold"))
                .toActionAttributes()
        );
        timeline.action(
            "evt_timeline_network",
            "2026-06-02T10:00:06Z",
            ProductTimeline.networkMilestone("https://api.example/v1/payments/:id?debug=sample")
                .method("post")
                .statusCode(503)
                .durationMs(183.4)
                .sessionId("session_123")
                .traceId("trace_abc")
                .toActionAttributes()
        );
        String timelinePayload = timeline.previewJson();
        require(timeline.pendingEvents() == 2, "timeline queues two action events");
        require(timelinePayload.contains("\"source\": \"product.action\""), "product timeline source");
        require(timelinePayload.contains("\"source\": \"network.milestone\""), "network timeline source");
        require(timelinePayload.contains("\"routeTemplate\": \"/checkout/:step\""), "product route template");
        require(timelinePayload.contains("\"routeTemplate\": \"/v1/payments/:id\""), "network route template");
        require(timelinePayload.contains("\"method\": \"POST\""), "network method");
        require(timelinePayload.contains("\"statusCode\": 503"), "network status code");
        require(timelinePayload.contains("\"status\": \"failure\""), "network failure status");
        require(!timelinePayload.contains("cart=sample"), "timeline strips product query");
        require(!timelinePayload.contains("debug=sample"), "timeline strips network query");

        LogBrewClient dependencies = LogBrewClient.create("LOGBREW_API_KEY", "smoke-app", "0.1.0");
        String dbResult = LogBrewOperationTracing.databaseOperation(
            dependencies,
            "select checkout",
            () -> "order-123",
            LogBrewOperationTracing.DatabaseOperation.create()
                .system("postgresql")
                .operationKind("query")
                .databaseName("orders")
                .statementTemplate("SELECT * FROM orders WHERE id = ?")
                .rowCount(1)
                .eventIdPrefix("java_db_smoke")
                .spanId("b7ad6b7169203331")
                .spanEvent(SpanEventSummary.create("db.rows")
                    .timestamp("2026-06-02T10:00:00.012Z")
                    .metadata(Map.of("rowCount", 1, "query", "SELECT private", "service", "checkout")))
                .metadata(Map.of("service", "checkout", "query", "SELECT private", "host", "db.internal"))
                .nowSequence(Instant.parse("2026-06-02T10:00:00Z"), Instant.parse("2026-06-02T10:00:00.025Z"))
        );
        require("order-123".equals(dbResult), "database operation result");
        LogBrewOperationTracing.cacheOperation(
            dependencies,
            "get cart",
            () -> Integer.valueOf(42),
            LogBrewOperationTracing.CacheOperation.create()
                .system("redis")
                .operationKind("get")
                .cacheName("checkout-cache")
                .hit(true)
                .itemCount(1)
                .eventIdPrefix("java_cache_smoke")
                .spanId("b7ad6b7169203332")
                .metadata(Map.of("service", "checkout", "cacheKey", "cart:private"))
                .nowSequence(Instant.parse("2026-06-02T10:00:01Z"), Instant.parse("2026-06-02T10:00:01.005Z"))
        );
        LogBrewOperationTracing.queueOperation(
            dependencies,
            "publish invoice",
            () -> "delivered",
            LogBrewOperationTracing.QueueOperation.create()
                .system("kafka")
                .operationKind("publish")
                .queueName("billing-events")
                .taskName("invoice.created")
                .messageCount(1)
                .eventIdPrefix("java_queue_smoke")
                .spanId("b7ad6b7169203333")
                .metadata(Map.of("component", "billing", "messageBody", "private body"))
                .nowSequence(Instant.parse("2026-06-02T10:00:02Z"), Instant.parse("2026-06-02T10:00:02.010Z"))
        );
        try {
            LogBrewOperationTracing.queueOperation(
                dependencies,
                "publish failed invoice",
                () -> {
                    throw new QueueFailure("private failure message body");
                },
                LogBrewOperationTracing.QueueOperation.create()
                    .system("kafka")
                    .operationKind("publish")
                    .queueName("billing-events")
                    .taskName("invoice.failed")
                    .messageCount(1)
                    .eventIdPrefix("java_queue_error_smoke")
                    .spanId("b7ad6b7169203334")
                    .spanEvent(SpanEventSummary.create("queue.enqueued")
                        .metadata(Map.of("component", "billing", "messageBody", "private body")))
                    .nowSequence(Instant.parse("2026-06-02T10:00:03Z"), Instant.parse("2026-06-02T10:00:03.010Z"))
            );
            throw new AssertionError("expected queue failure");
        } catch (QueueFailure expected) {
            // Expected path proves failing operations still emit sanitized trace events.
        }
        String dependencyPayload = dependencies.previewJson();
        require(dependencies.pendingEvents() == 4, "dependency helpers queue four spans");
        require(dependencyPayload.contains("\"source\": \"database.operation\""), "database span source");
        require(dependencyPayload.contains("\"dbSystem\": \"postgresql\""), "database span system");
        require(dependencyPayload.contains("\"events\": ["), "dependency spans include bounded events");
        require(dependencyPayload.contains("\"name\": \"db.rows\""), "database span event name");
        require(dependencyPayload.contains("\"timestamp\": \"2026-06-02T10:00:00.012Z\""), "database span event timestamp");
        require(dependencyPayload.contains("\"name\": \"queue.enqueued\""), "queue span event name");
        require(dependencyPayload.contains("\"name\": \"exception\""), "queue failure exception event");
        require(dependencyPayload.contains("\"exceptionType\": \"QueueFailure\""), "queue failure exception type");
        require(dependencyPayload.contains("\"exceptionEscaped\": true"), "queue failure exception escaped");
        require(dependencyPayload.contains("\"source\": \"cache.operation\""), "cache span source");
        require(dependencyPayload.contains("\"cacheHit\": true"), "cache span hit");
        require(dependencyPayload.contains("\"source\": \"queue.operation\""), "queue span source");
        require(dependencyPayload.contains("\"queueName\": \"billing-events\""), "queue span name");
        require(!dependencyPayload.contains("db.internal"), "dependency metadata drops host");
        require(!dependencyPayload.contains("cart:private"), "dependency metadata drops cache key");
        require(!dependencyPayload.contains("SELECT private"), "dependency span events drop raw queries");
        require(!dependencyPayload.contains("private body"), "dependency metadata drops message body");
        require(!dependencyPayload.contains("private failure message body"), "dependency exception event drops messages");

        LogBrewClient outbound = LogBrewClient.create("LOGBREW_API_KEY", "smoke-app", "0.1.0");
        LogBrewTraceContext outboundParent = LogBrewTraceContext.fromTraceparent(
            "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
            "a7ad6b7169203330"
        );
        String authHeader = "Author" + "ization";
        String authValue = "Bea" + "rer redacted";
        RecordingHttpClient okHttpClient = RecordingHttpClient.responding(202, "accepted");
        HttpRequest outboundRequest = HttpRequest.newBuilder(
                URI.create("https://api.example.invalid/orders/123?debug=redacted#frag"))
            .header("traceparent", "00-11111111111111111111111111111111-2222222222222222-01")
            .header(authHeader, authValue)
            .GET()
            .build();
        HttpResponse<String> outboundResponse;
        LogBrewTrace.Scope traceScope = LogBrewTrace.activate(outboundParent);
        try {
            outboundResponse = LogBrewHttpClientTracing.send(
                outbound,
                okHttpClient,
                outboundRequest,
                HttpResponse.BodyHandlers.ofString(),
                LogBrewHttpClientTracing.ClientRequest.create()
                    .routeTemplate("https://api.example.invalid/orders/{id}?debug=redacted#frag")
                    .eventIdPrefix("java_http_client_smoke")
                    .spanId("b7ad6b7169203501")
                    .metadata(Map.of(
                        "component", "checkout",
                        "url", "https://api.example.invalid/orders/123?debug=redacted",
                        "headers", authHeader + ": " + authValue,
                        "payload", "private body"
                    ))
                    .nowSequence(
                        Instant.parse("2026-06-02T10:00:10Z"),
                        Instant.parse("2026-06-02T10:00:10.018Z")
                    )
            );
        } finally {
            traceScope.close();
        }
        require(outboundResponse.statusCode() == 202, "HTTP client helper preserves response status");
        require(
            "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203501-01".equals(
                firstHeader(okHttpClient.lastRequest, "traceparent")
            ),
            "HTTP client helper injects child traceparent"
        );
        require(authValue.equals(firstHeader(okHttpClient.lastRequest, authHeader)), "HTTP headers preserved");

        RecordingHttpClient busyHttpClient = RecordingHttpClient.responding(503, "busy");
        LogBrewHttpClientTracing.sendAsync(
            outbound,
            busyHttpClient,
            HttpRequest.newBuilder(URI.create("https://api.example.invalid/retry"))
                .POST(HttpRequest.BodyPublishers.ofString("payload should not be captured"))
                .build(),
            HttpResponse.BodyHandlers.ofString(),
            LogBrewHttpClientTracing.ClientRequest.create()
                .routeTemplate("/retry")
                .eventIdPrefix("java_http_client_async_smoke")
                .spanId("b7ad6b7169203502")
                .nowSequence(
                    Instant.parse("2026-06-02T10:00:11Z"),
                    Instant.parse("2026-06-02T10:00:11.006Z")
                )
        ).join();
        String outboundPayload = outbound.previewJson();
        require(outbound.pendingEvents() == 2, "HTTP client helper queues two spans");
        require(outboundPayload.contains("\"source\": \"http.client\""), "HTTP client span source");
        require(outboundPayload.contains("\"id\": \"java_http_client_smoke_span_b7ad6b7169203501\""), "HTTP client span id");
        require(outboundPayload.contains("\"name\": \"http.client:GET /orders/{id}\""), "HTTP client span name");
        require(outboundPayload.contains("\"routeTemplate\": \"/orders/{id}\""), "HTTP client route template");
        require(outboundPayload.contains("\"statusCode\": 202"), "HTTP client status code");
        require(outboundPayload.contains("\"http.response.status_code\": 503"), "HTTP client async status code");
        require(outboundPayload.contains("\"status\": \"error\""), "HTTP client records 5xx as error");
        require(!outboundPayload.contains("api.example.invalid"), "HTTP client omits host");
        require(!outboundPayload.contains("debug=redacted"), "HTTP client omits query");
        require(!outboundPayload.contains(authHeader), "HTTP client omits header names");
        require(!outboundPayload.contains(authValue), "HTTP client omits header values");
        require(!outboundPayload.contains("private body"), "HTTP client omits metadata payload");
        require(!outboundPayload.contains("payload should not be captured"), "HTTP client omits request body");
        require(!outboundPayload.contains("11111111111111111111111111111111"), "HTTP client replaces incoming traceparent");

        LogBrewClient jdbcClient = LogBrewClient.create("LOGBREW_API_KEY", "smoke-app", "0.1.0");
        RecordingJdbc jdbc = new RecordingJdbc();
        Connection tracedConnection = LogBrewJdbcTracing.instrumentConnection(
            fakeConnection(jdbc),
            jdbcClient,
            LogBrewJdbcTracing.ConnectionConfig.create()
                .system("postgresql")
                .databaseName("orders")
                .eventIdPrefix("java_jdbc_smoke")
                .spanIds(
                    "b7ad6b7169203401",
                    "b7ad6b7169203402",
                    "b7ad6b7169203403",
                    "b7ad6b7169203404"
                )
                .nowSequence(
                    Instant.parse("2026-06-02T10:00:05Z"),
                    Instant.parse("2026-06-02T10:00:05.011Z"),
                    Instant.parse("2026-06-02T10:00:06Z"),
                    Instant.parse("2026-06-02T10:00:06.015Z"),
                    Instant.parse("2026-06-02T10:00:07Z"),
                    Instant.parse("2026-06-02T10:00:07.003Z"),
                    Instant.parse("2026-06-02T10:00:08Z"),
                    Instant.parse("2026-06-02T10:00:08.004Z")
                )
                .metadata(Map.of(
                    "service", "checkout",
                    "sql", "SELECT private",
                    "connectionString", "jdbc:postgresql://private.example/orders"
                ))
        );
        ResultSet resultSet = tracedConnection
            .createStatement()
            .executeQuery("SELECT * FROM orders WHERE card_number = '4111111111111111'");
        require(resultSet == jdbc.resultSet, "JDBC statement preserves result set");
        PreparedStatement prepared = tracedConnection.prepareStatement(
            "UPDATE orders SET status = 'private' WHERE id = ?"
        );
        require(prepared.executeUpdate() == 2, "JDBC prepared update row count");
        SQLException originalSqlError = new SQLException("private SQL and bind values failed");
        jdbc.failure = originalSqlError;
        try {
            tracedConnection.createStatement().execute("DELETE FROM orders WHERE session_marker = 'private'");
            throw new AssertionError("expected JDBC failure");
        } catch (SQLException expected) {
            require(expected == originalSqlError, "JDBC helper preserves original SQLException");
        }
        jdbc.failure = null;
        tracedConnection
            .createStatement()
            .executeQuery("/* CommentMarker private */ SELECT * FROM orders");
        DataSource tracedDataSource = LogBrewJdbcTracing.instrumentDataSource(
            fakeDataSource(jdbc),
            jdbcClient,
            LogBrewJdbcTracing.ConnectionConfig.create()
                .system("postgresql")
                .databaseName("orders")
                .eventIdPrefix("java_jdbc_datasource_smoke")
                .traceConnectionAcquisition(true)
                .spanIds("b7ad6b7169203405", "b7ad6b7169203406")
                .nowSequence(
                    Instant.parse("2026-06-02T10:00:09Z"), Instant.parse("2026-06-02T10:00:09.004Z"),
                    Instant.parse("2026-06-02T10:00:09.005Z"), Instant.parse("2026-06-02T10:00:09.011Z")
                )
                .metadata(Map.of(
                    "service", "checkout",
                    "username", "private_user",
                    "authSecondArgument", "private_second_arg"
                ))
        );
        int dataSourceRowCount = tracedDataSource
            .getConnection("private_user", "private_second_arg")
            .prepareStatement("UPDATE orders SET owner = 'private_user' WHERE id = ?")
            .executeUpdate();
        require(dataSourceRowCount == 2, "JDBC data source prepared update row count");
        require("private_user".equals(jdbc.dataSourceUsername), "JDBC data source passes username");
        require("private_second_arg".equals(jdbc.dataSourceSecondArgument), "JDBC data source passes second argument");
        String jdbcPayload = jdbcClient.previewJson();
        require(jdbcClient.pendingEvents() == 6, "JDBC helper queues six spans");
        require(jdbcPayload.contains("\"id\": \"java_jdbc_datasource_smoke_span_b7ad6b7169203405\""), "JDBC data source acquire span id");
        require(jdbcPayload.contains("\"source\": \"jdbc.connection\""), "JDBC acquisition source");
        require(jdbcPayload.contains("\"source\": \"jdbc.statement\""), "JDBC span source");
        require(jdbcPayload.contains("\"framework\": \"jdbc\""), "JDBC framework metadata");
        require(jdbcPayload.contains("\"dbOperation\": \"CONNECT\""), "JDBC connect operation");
        require(jdbcPayload.contains("\"dbOperation\": \"SELECT\""), "JDBC select operation");
        require(jdbcPayload.contains("\"dbOperation\": \"UPDATE\""), "JDBC update operation");
        require(jdbcPayload.contains("\"rowCount\": 2"), "JDBC update row count");
        require(jdbcPayload.contains("\"exceptionType\": \"SQLException\""), "JDBC exception type");
        require(!jdbcPayload.contains("CommentMarker"), "JDBC omits leading SQL comment text");
        require(!jdbcPayload.contains("COMMENTMARKER"), "JDBC omits leading SQL comment operation");
        require(!jdbcPayload.contains("4111111111111111"), "JDBC omits SQL literal");
        require(!jdbcPayload.contains("SELECT * FROM"), "JDBC omits raw select SQL");
        require(!jdbcPayload.contains("UPDATE orders SET"), "JDBC omits raw update SQL");
        require(!jdbcPayload.contains("DELETE FROM"), "JDBC omits raw error SQL");
        require(!jdbcPayload.contains("private SQL"), "JDBC omits exception message");
        require(!jdbcPayload.contains("private.example"), "JDBC omits connection URL");
        require(!jdbcPayload.contains("private_user"), "JDBC data source omits username");
        require(!jdbcPayload.contains("private_second_arg"), "JDBC data source omits second argument");

        LogBrewClient otel = LogBrewClient.create("LOGBREW_API_KEY", "smoke-app", "0.1.0");
        SpanContext otelSpanContext = SpanContext.create(
            "4bf92f3577b34da6a3ce929d0e0e4736",
            "00f067aa0ba902b7",
            TraceFlags.getSampled(),
            TraceState.builder().put("vendor", "private").build()
        );
        Context otelContext = Context.root().with(Span.wrap(otelSpanContext));
        Optional<LogBrewTraceContext> copied = LogBrewOpenTelemetry.traceContextFromContext(
            otelContext,
            "b7ad6b7169203331"
        );
        require(copied.isPresent(), "otel explicit context copies");
        require("00f067aa0ba902b7".equals(copied.get().parentSpanId()), "otel parent span id copied");
        require(
            "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01".equals(copied.get().traceparent()),
            "otel outgoing traceparent"
        );
        try (Scope scope = otelContext.makeCurrent()) {
            require(scope != null, "otel scope created");
            LogBrewTraceContext active = LogBrewOpenTelemetry.traceContextFromCurrentSpan(
                "1111111111111111"
            ).orElseThrow();
            otel.span(
                "evt_otel_child_span",
                "2026-06-02T10:00:04Z",
                SpanAttributes.create("otel child operation", active.traceId(), active.spanId(), "ok")
                    .parentSpanId(active.parentSpanId())
                    .metadata(active.metadata())
            );
        }
        require(
            LogBrewOpenTelemetry.traceContextFromSpanContext(SpanContext.getInvalid(), "2222222222222222").isEmpty(),
            "invalid otel context ignored"
        );
        String otelPayload = otel.previewJson();
        require(otel.pendingEvents() == 1, "otel helper queues one correlated span");
        require(otelPayload.contains("\"traceId\": \"4bf92f3577b34da6a3ce929d0e0e4736\""), "otel trace id");
        require(otelPayload.contains("\"spanId\": \"1111111111111111\""), "otel child span id");
        require(otelPayload.contains("\"parentSpanId\": \"00f067aa0ba902b7\""), "otel parent span id");
        require(otelPayload.contains("\"traceSampled\": true"), "otel sampled metadata");
        require(!otelPayload.contains("tracestate"), "otel helper omits tracestate");
        require(!otelPayload.contains("vendor"), "otel helper omits tracestate values");

        expect("validation_error", () -> client.log(
            "evt_log_bad",
            "2026-06-02T10:00:03",
            LogAttributes.create("worker started", "info")
        ));

        LogBrewClient unauthenticated = LogBrewClient.create("LOGBREW_API_KEY", "smoke-app", "0.1.0");
        enqueueAll(unauthenticated);
        expect("unauthenticated", () -> unauthenticated.flush(RecordingTransport.scripted(Integer.valueOf(401))));
        require(unauthenticated.pendingEvents() == 6, "unauthenticated preserves queue");

        LogBrewClient retry = LogBrewClient.create("LOGBREW_API_KEY", "smoke-app", "0.1.0");
        enqueueAll(retry);
        TransportResponse retryResponse = retry.flush(RecordingTransport.scripted(
            TransportException.network("temporary outage"),
            Integer.valueOf(202)
        ));
        require(retryResponse.attempts() == 2, "retry recovery");

        LogBrewClient exhausted = LogBrewClient.create("LOGBREW_API_KEY", "smoke-app", "0.1.0", 1);
        enqueueAll(exhausted);
        expect("network_failure", () -> exhausted.flush(RecordingTransport.scripted(
            TransportException.network("temporary outage"),
            TransportException.network("still down")
        )));
        require(exhausted.pendingEvents() == 6, "retry budget preserves queue");

        LogBrewClient rejected = LogBrewClient.create("LOGBREW_API_KEY", "smoke-app", "0.1.0");
        enqueueAll(rejected);
        expect("transport_error", () -> rejected.flush(RecordingTransport.scripted(Integer.valueOf(400))));
        require(rejected.pendingEvents() == 6, "transport status preserves queue");

        LogBrewClient shutdown = LogBrewClient.create("LOGBREW_API_KEY", "smoke-app", "0.1.0");
        enqueueAll(shutdown);
        shutdown.shutdown(RecordingTransport.alwaysAccept());
        expect("shutdown_error", () -> shutdown.action(
            "evt_action_002",
            "2026-06-02T10:00:06Z",
            ActionAttributes.create("deploy", "success")
        ));

        LogBrewClient loggingClient = LogBrewClient.create("LOGBREW_API_KEY", "smoke-app", "0.1.0");
        RecordingTransport loggingTransport = RecordingTransport.alwaysAccept();
        LogBrewJulHandler logbrewHandler = new LogBrewJulHandler(
            loggingClient,
            loggingTransport,
            false,
            false,
            Collections.singletonMap("service", "checkout")
        );
        Logger rootLogger = Logger.getLogger("");
        int rootHandlerCount = rootLogger.getHandlers().length;
        Level rootLevel = rootLogger.getLevel();
        Logger logger = Logger.getLogger("checkout.worker");
        Handler[] originalHandlers = logger.getHandlers();
        Level originalLevel = logger.getLevel();
        boolean originalUseParentHandlers = logger.getUseParentHandlers();
        try {
            logger.setUseParentHandlers(false);
            logger.setLevel(Level.ALL);
            logger.addHandler(logbrewHandler);
            logger.warning("cart queued");
            logger.log(Level.SEVERE, "checkout failed", new IllegalStateException("database unavailable"));
            logbrewHandler.flush();
        } finally {
            logger.removeHandler(logbrewHandler);
            logger.setUseParentHandlers(originalUseParentHandlers);
            logger.setLevel(originalLevel);
        }
        require(rootLogger.getHandlers().length == rootHandlerCount, "JUL handler does not mutate root handlers");
        require(rootLogger.getLevel() == rootLevel, "JUL handler does not mutate root level");
        require(logger.getHandlers().length == originalHandlers.length, "app logger handler count unchanged");
        require(loggingClient.pendingEvents() == 0, "JUL handler flush clears queue");
        require(loggingTransport.sentBodies().size() == 1, "JUL handler sends one batch");
        String loggingBody = loggingTransport.lastBody().orElse("");
        require(occurrences(loggingBody, "\"type\": \"log\"") == 2, "JUL handler captures two log records");
        require(loggingBody.contains("\"logger\": \"checkout.worker\""), "JUL handler captures logger name");
        require(loggingBody.contains("\"service\": \"checkout\""), "JUL handler keeps base metadata");
        require(loggingBody.contains("\"level\": \"warning\""), "JUL handler maps warning");
        require(loggingBody.contains("\"level\": \"error\""), "JUL handler maps severe");
        require(loggingBody.contains("\"exceptionType\": \"IllegalStateException\""), "JUL handler captures exception type");
        require(!loggingBody.contains("javaStackTrace"), "JUL handler omits stack traces by default");

        LogBrewClient logbackClient = LogBrewClient.create("LOGBREW_API_KEY", "smoke-app", "0.1.0");
        RecordingTransport logbackTransport = RecordingTransport.alwaysAccept();
        LogBrewLogbackAppender appender = new LogBrewLogbackAppender(logbackClient, logbackTransport, false);
        appender.setName("LOGBREW");
        appender.setEventIdPrefix("logback_smoke");
        appender.setMetadata(Collections.singletonMap("service", "checkout"));
        appender.start();
        ch.qos.logback.classic.Logger logbackLogger = logbackLogger("checkout.slf4j");
        ch.qos.logback.classic.Level originalLogbackLevel = logbackLogger.getLevel();
        boolean originalAdditive = logbackLogger.isAdditive();
        try {
            logbackLogger.setAdditive(false);
            logbackLogger.setLevel(ch.qos.logback.classic.Level.TRACE);
            logbackLogger.addAppender(appender);
            MDC.put("requestId", "req_123");
            logbackLogger.atWarn().addKeyValue("cartId", Integer.valueOf(42)).log("cart queued");
            logbackLogger.error("checkout failed", new IllegalStateException("database unavailable"));
        } finally {
            MDC.remove("requestId");
            logbackLogger.detachAppender(appender);
            logbackLogger.setLevel(originalLogbackLevel);
            logbackLogger.setAdditive(originalAdditive);
        }
        appender.stop();
        require(logbackClient.pendingEvents() == 0, "Logback appender stop flush clears queue");
        require(logbackTransport.sentBodies().size() == 1, "Logback appender sends one batch");
        String logbackBody = logbackTransport.lastBody().orElse("");
        require(occurrences(logbackBody, "\"type\": \"log\"") == 2, "Logback appender captures two log records");
        require(logbackBody.contains("\"id\": \"logback_smoke_1\""), "Logback appender generates ids");
        require(logbackBody.contains("\"logger\": \"checkout.slf4j\""), "Logback appender captures logger name");
        require(logbackBody.contains("\"source\": \"logback\""), "Logback appender records source");
        require(logbackBody.contains("\"service\": \"checkout\""), "Logback appender keeps base metadata");
        require(logbackBody.contains("\"level\": \"warning\""), "Logback appender maps warn");
        require(logbackBody.contains("\"level\": \"error\""), "Logback appender maps error");
        require(logbackBody.contains("\"mdc.requestId\": \"req_123\""), "Logback appender captures MDC");
        require(logbackBody.contains("\"kv.cartId\": 42"), "Logback appender captures key value pairs");
        require(logbackBody.contains("\"exceptionType\": \"IllegalStateException\""), "Logback appender captures exception type");
        require(!logbackBody.contains("logbackStackTrace"), "Logback appender omits stack traces by default");

        runHttpTransportSmoke();

        System.err.println("{\"ok\":true,\"status\":202,\"attempts\":1,\"events\":6,\"metricEvents\":1,\"timelineEvents\":2,\"httpClientEvents\":2,\"jdbcEvents\":6,\"otelEvents\":1,\"httpAttempts\":2,\"httpRequests\":2,\"logbackEvents\":2}");
    }

    private static void runHttpTransportSmoke() {
        AtomicInteger requestCount = new AtomicInteger();
        AtomicReference<String> firstBody = new AtomicReference<>("");
        AtomicReference<String> secondBody = new AtomicReference<>("");
        AtomicReference<String> authorization = new AtomicReference<>("");
        AtomicReference<String> contentType = new AtomicReference<>("");
        AtomicReference<String> method = new AtomicReference<>("");
        AtomicReference<String> path = new AtomicReference<>("");
        AtomicReference<String> source = new AtomicReference<>("");
        AtomicReference<RuntimeException> failure = new AtomicReference<>();
        HttpServer server;
        try {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        } catch (IOException error) {
            throw new AssertionError(error);
        }
        server.createContext("/v1/events", exchange -> {
            try {
                int current = requestCount.incrementAndGet();
                method.set(exchange.getRequestMethod());
                path.set(exchange.getRequestURI().getPath());
                authorization.set(firstHeader(exchange, "authorization"));
                contentType.set(firstHeader(exchange, "content-type"));
                source.set(firstHeader(exchange, "x-logbrew-source"));
                String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
                if (current == 1) {
                    firstBody.set(body);
                    sendStatus(exchange, 503);
                    return;
                }
                secondBody.set(body);
                sendStatus(exchange, 202);
            } catch (RuntimeException | IOException error) {
                failure.set(new RuntimeException(error));
                sendStatus(exchange, 500);
            }
        });
        server.start();
        try {
            LogBrewClient client = LogBrewClient.create("LOGBREW_API_KEY", "smoke-app", "0.1.0", 1);
            client.log(
                "evt_java_http_transport",
                "2026-06-02T10:00:03Z",
                LogAttributes.create("http transport", "info")
            );
            HttpTransport transport = HttpTransport.builder()
                .endpoint(URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/v1/events"))
                .header("x-logbrew-source", "java-smoke")
                .timeout(Duration.ofSeconds(5))
                .build();
            TransportResponse response = client.flush(transport);

            if (failure.get() != null) {
                throw failure.get();
            }
            require(response.statusCode() == 202, "HTTP transport status");
            require(response.attempts() == 2, "HTTP transport retry attempts");
            require(requestCount.get() == 2, "HTTP transport request count");
            require(client.pendingEvents() == 0, "HTTP transport clears queue");
            require("POST".equals(method.get()), "HTTP transport method");
            require("/v1/events".equals(path.get()), "HTTP transport path");
            require("Bearer LOGBREW_API_KEY".equals(authorization.get()), "HTTP transport authorization");
            require(contentType.get().contains("application/json"), "HTTP transport content type");
            require("java-smoke".equals(source.get()), "HTTP transport source header");
            require(firstBody.get().contains("evt_java_http_transport"), "HTTP transport event id");
            require(firstBody.get().equals(secondBody.get()), "HTTP transport retry body");
        } finally {
            server.stop(0);
        }
    }

    private static void enqueueAll(LogBrewClient client) {
        client.release("evt_release_001", "2026-06-02T10:00:00Z", ReleaseAttributes.create("1.2.3").commit("abc123def456").notes("Public release marker"));
        client.environment("evt_environment_001", "2026-06-02T10:00:01Z", EnvironmentAttributes.create("production").region("global"));
        client.issue("evt_issue_001", "2026-06-02T10:00:02Z", IssueAttributes.create("Checkout timeout", "error").message("Request timed out after retry budget"));
        client.log("evt_log_001", "2026-06-02T10:00:03Z", LogAttributes.create("worker started", "info").logger("job-runner"));
        client.span("evt_span_001", "2026-06-02T10:00:04Z", SpanAttributes.create("GET /health", "trace_001", "span_001", "ok").durationMs(12.5));
        client.action("evt_action_001", "2026-06-02T10:00:05Z", ActionAttributes.create("deploy", "success"));
    }

    private static void expect(String code, Runnable callback) {
        try {
            callback.run();
        } catch (SdkException error) {
            require(code.equals(error.code()), "expected " + code + " but got " + error.code());
            return;
        }
        throw new AssertionError("expected SdkException with code " + code);
    }

    private static void require(boolean condition, String label) {
        if (!condition) {
            throw new AssertionError(label);
        }
    }

    private static Connection fakeConnection(RecordingJdbc jdbc) {
        return proxy(Connection.class, (proxy, method, args) -> {
            if ("createStatement".equals(method.getName())) {
                return fakeStatement(jdbc, Statement.class);
            }
            if ("prepareStatement".equals(method.getName())) {
                return fakeStatement(jdbc, PreparedStatement.class);
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static DataSource fakeDataSource(RecordingJdbc jdbc) {
        return proxy(DataSource.class, (proxy, method, args) -> {
            if ("getConnection".equals(method.getName())) {
                if (args != null && args.length == 2) {
                    jdbc.dataSourceUsername = (String) args[0];
                    jdbc.dataSourceSecondArgument = (String) args[1];
                }
                return fakeConnection(jdbc);
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static <T> T fakeStatement(RecordingJdbc jdbc, Class<?> interfaceType) {
        return proxy(interfaceType, (proxy, method, args) -> {
            if (method.getName().startsWith("execute")) {
                if (jdbc.failure != null) {
                    throw jdbc.failure;
                }
                if (method.getReturnType() == ResultSet.class) {
                    return jdbc.resultSet;
                }
                if (method.getReturnType() == int.class) {
                    return Integer.valueOf(2);
                }
                if (method.getReturnType() == boolean.class) {
                    return Boolean.TRUE;
                }
            }
            return defaultValue(method.getReturnType());
        });
    }

    private static ResultSet fakeResultSet() {
        return proxy(ResultSet.class, (proxy, method, args) -> defaultValue(method.getReturnType()));
    }

    @SuppressWarnings("unchecked")
    private static <T> T proxy(Class<?> interfaceType, InvocationHandler handler) {
        return (T) Proxy.newProxyInstance(
            interfaceType.getClassLoader(),
            new Class<?>[] {interfaceType},
            (proxy, method, args) -> {
                if ("toString".equals(method.getName()) && method.getParameterCount() == 0) {
                    return interfaceType.getSimpleName() + "Proxy";
                }
                if ("hashCode".equals(method.getName()) && method.getParameterCount() == 0) {
                    return Integer.valueOf(System.identityHashCode(proxy));
                }
                if ("equals".equals(method.getName()) && method.getParameterCount() == 1) {
                    return Boolean.valueOf(proxy == args[0]);
                }
                return handler.invoke(proxy, method, args == null ? new Object[0] : args);
            }
        );
    }

    private static Object defaultValue(Class<?> type) {
        if (type == void.class) {
            return null;
        }
        if (type == boolean.class) {
            return Boolean.FALSE;
        }
        if (type == int.class) {
            return Integer.valueOf(0);
        }
        if (type == long.class) {
            return Long.valueOf(0L);
        }
        if (type == double.class) {
            return Double.valueOf(0.0);
        }
        if (type == float.class) {
            return Float.valueOf(0.0f);
        }
        if (type == short.class) {
            return Short.valueOf((short) 0);
        }
        if (type == byte.class) {
            return Byte.valueOf((byte) 0);
        }
        if (type == char.class) {
            return Character.valueOf('\0');
        }
        return null;
    }

    private static final class RecordingJdbc {
        private final ResultSet resultSet = fakeResultSet();
        private SQLException failure;
        private String dataSourceUsername;
        private String dataSourceSecondArgument;
    }

    private static final class QueueFailure extends Exception {
        private static final long serialVersionUID = 1L;

        private QueueFailure(String message) {
            super(message);
        }
    }

    private static String firstHeader(HttpRequest request, String name) {
        return request.headers().firstValue(name).orElseThrow(() -> new AssertionError("missing header: " + name));
    }

    private static String firstHeader(HttpExchange exchange, String name) {
        String value = exchange.getRequestHeaders().getFirst(name);
        if (value == null) {
            throw new AssertionError("missing header: " + name);
        }
        return value;
    }

    private static void sendStatus(HttpExchange exchange, int statusCode) {
        try {
            exchange.sendResponseHeaders(statusCode, -1L);
        } catch (IOException error) {
            throw new AssertionError(error);
        } finally {
            exchange.close();
        }
    }

    private static ch.qos.logback.classic.Logger logbackLogger(String name) {
        ch.qos.logback.classic.LoggerContext context =
            (ch.qos.logback.classic.LoggerContext) LoggerFactory.getILoggerFactory();
        return context.getLogger(name);
    }

    private static int occurrences(String value, String needle) {
        int count = 0;
        int cursor = 0;
        while (true) {
            int index = value.indexOf(needle, cursor);
            if (index < 0) {
                return count;
            }
            count++;
            cursor = index + needle.length();
        }
    }

    private static final class RecordingHttpClient extends HttpClient {
        private final int statusCode;
        private final String body;
        private HttpRequest lastRequest;

        private RecordingHttpClient(int statusCode, String body) {
            this.statusCode = statusCode;
            this.body = body;
        }

        static RecordingHttpClient responding(int statusCode, String body) {
            return new RecordingHttpClient(statusCode, body);
        }

        @Override
        public Optional<CookieHandler> cookieHandler() {
            return Optional.empty();
        }

        @Override
        public Optional<Duration> connectTimeout() {
            return Optional.empty();
        }

        @Override
        public Redirect followRedirects() {
            return Redirect.NEVER;
        }

        @Override
        public Optional<ProxySelector> proxy() {
            return Optional.empty();
        }

        @Override
        public SSLContext sslContext() {
            return null;
        }

        @Override
        public SSLParameters sslParameters() {
            return null;
        }

        @Override
        public Optional<Authenticator> authenticator() {
            return Optional.empty();
        }

        @Override
        public HttpClient.Version version() {
            return HttpClient.Version.HTTP_1_1;
        }

        @Override
        public Optional<Executor> executor() {
            return Optional.empty();
        }

        @Override
        public <T> HttpResponse<T> send(
            HttpRequest request,
            HttpResponse.BodyHandler<T> responseBodyHandler
        ) {
            lastRequest = request;
            return new RecordingHttpResponse<>(request, statusCode, body);
        }

        @Override
        public <T> CompletableFuture<HttpResponse<T>> sendAsync(
            HttpRequest request,
            HttpResponse.BodyHandler<T> responseBodyHandler
        ) {
            lastRequest = request;
            return CompletableFuture.completedFuture(new RecordingHttpResponse<>(request, statusCode, body));
        }

        @Override
        public <T> CompletableFuture<HttpResponse<T>> sendAsync(
            HttpRequest request,
            HttpResponse.BodyHandler<T> responseBodyHandler,
            HttpResponse.PushPromiseHandler<T> pushPromiseHandler
        ) {
            return sendAsync(request, responseBodyHandler);
        }
    }

    private static final class RecordingHttpResponse<T> implements HttpResponse<T> {
        private final HttpRequest request;
        private final int statusCode;
        private final Object body;

        private RecordingHttpResponse(HttpRequest request, int statusCode, Object body) {
            this.request = request;
            this.statusCode = statusCode;
            this.body = body;
        }

        @Override
        public int statusCode() {
            return statusCode;
        }

        @Override
        public HttpRequest request() {
            return request;
        }

        @Override
        public Optional<HttpResponse<T>> previousResponse() {
            return Optional.empty();
        }

        @Override
        @SuppressWarnings("unchecked")
        public T body() {
            return (T) body;
        }

        @Override
        public HttpHeaders headers() {
            return HttpHeaders.of(Collections.emptyMap(), (name, value) -> true);
        }

        @Override
        public URI uri() {
            return request.uri();
        }

        @Override
        public HttpClient.Version version() {
            return HttpClient.Version.HTTP_1_1;
        }

        @Override
        public Optional<SSLSession> sslSession() {
            return Optional.empty();
        }
    }
}
JAVA
javac -Xlint:all -Werror --release 11 -cp "$smoke_app/lib/logbrew-sdk-$java_version.jar:$java_optional_classpath" -d "$smoke_app/classes" "$smoke_app/src/Main.java"
java -cp "$smoke_app/lib/logbrew-sdk-$java_version.jar:$smoke_app/classes:$java_optional_classpath" Main > "$tmp_dir/smoke-app.stdout.json" 2> "$tmp_dir/smoke-app.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/smoke-app.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/smoke-app.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/smoke-app.stderr.json"
grep -q '"httpAttempts":2' "$tmp_dir/smoke-app.stderr.json"
grep -q '"httpRequests":2' "$tmp_dir/smoke-app.stderr.json"
grep -q '"logbackEvents":2' "$tmp_dir/smoke-app.stderr.json"
grep -q '"metricEvents":1' "$tmp_dir/smoke-app.stderr.json"
grep -q '"timelineEvents":2' "$tmp_dir/smoke-app.stderr.json"
grep -q '"httpClientEvents":2' "$tmp_dir/smoke-app.stderr.json"
grep -q '"jdbcEvents":6' "$tmp_dir/smoke-app.stderr.json"
grep -q '"otelEvents":1' "$tmp_dir/smoke-app.stderr.json"

jdeps --multi-release 11 --class-path "$java_jar:$java_optional_classpath" "$java_jar" > "$tmp_dir/jdeps.txt"
for expected_jdeps in java.base java.net.http logback-classic opentelemetry-api spring-kafka kafka-clients; do
  grep -q "$expected_jdeps" "$tmp_dir/jdeps.txt"
done

echo "java real-user smoke passed"
