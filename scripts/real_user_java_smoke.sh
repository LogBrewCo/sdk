#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/java/logbrew-java"
tmp_dir="$(mktemp -d)"

# shellcheck source=scripts/java_logback_deps.sh
source "$repo_root/scripts/java_logback_deps.sh"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

main_sources="$tmp_dir/main-sources.txt"
example_sources="$tmp_dir/example-sources.txt"
find "$package_dir/src/main/java" -name '*.java' | sort > "$main_sources"
find "$package_dir/examples" -name '*.java' | sort > "$example_sources"

mkdir -p "$tmp_dir/classes" "$tmp_dir/jar-stage" "$tmp_dir/source-stage" "$tmp_dir/example-classes"
java_logback_classpath="$(fetch_java_logback_deps "$tmp_dir/java-logback-deps")"
javac -Xlint:all -Werror --release 11 -cp "$java_logback_classpath" -d "$tmp_dir/classes" @"$main_sources"

mkdir -p "$tmp_dir/jar-stage/META-INF/maven/co.logbrew/logbrew-sdk"
cp "$package_dir/pom.xml" "$tmp_dir/jar-stage/META-INF/maven/co.logbrew/logbrew-sdk/pom.xml"
cp "$package_dir/README.md" "$tmp_dir/jar-stage/README.md"
cp -R "$tmp_dir/classes/co" "$tmp_dir/jar-stage/co"
jar --create --file "$tmp_dir/logbrew-sdk-0.1.0.jar" -C "$tmp_dir/jar-stage" .

cp "$package_dir/pom.xml" "$tmp_dir/source-stage/pom.xml"
cp "$package_dir/README.md" "$tmp_dir/source-stage/README.md"
cp -R "$package_dir/src" "$tmp_dir/source-stage/src"
cp -R "$package_dir/examples" "$tmp_dir/source-stage/examples"
jar --create --file "$tmp_dir/logbrew-sdk-0.1.0-sources.jar" -C "$tmp_dir/source-stage" .

jar --list --file "$tmp_dir/logbrew-sdk-0.1.0.jar" > "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewClient.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/HttpTransport.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/HttpTransport\$Builder.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/MetricAttributes.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/ProductTimeline.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/ProductTimeline\$ProductAction.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/ProductTimeline\$NetworkMilestone.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewJulHandler.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/LogBrewLogbackAppender.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/Transport.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^co/logbrew/sdk/RecordingTransport.class$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^META-INF/maven/co.logbrew/logbrew-sdk/pom.xml$' "$tmp_dir/binary-jar-contents.txt"
grep -q '^README.md$' "$tmp_dir/binary-jar-contents.txt"

jar --list --file "$tmp_dir/logbrew-sdk-0.1.0-sources.jar" > "$tmp_dir/source-jar-contents.txt"
grep -q '^pom.xml$' "$tmp_dir/source-jar-contents.txt"
grep -q '^README.md$' "$tmp_dir/source-jar-contents.txt"
grep -q '^src/main/java/co/logbrew/sdk/LogBrewClient.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^src/main/java/co/logbrew/sdk/HttpTransport.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^src/main/java/co/logbrew/sdk/MetricAttributes.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^src/main/java/co/logbrew/sdk/ProductTimeline.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^src/main/java/co/logbrew/sdk/LogBrewJulHandler.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^src/main/java/co/logbrew/sdk/LogBrewLogbackAppender.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^examples/ReadmeExample.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^examples/RealUserSmoke.java$' "$tmp_dir/source-jar-contents.txt"
grep -q '^examples/Makefile$' "$tmp_dir/source-jar-contents.txt"

grep -q '<groupId>co.logbrew</groupId>' "$package_dir/pom.xml"
grep -q '<artifactId>logbrew-sdk</artifactId>' "$package_dir/pom.xml"
grep -q '<version>0.1.0</version>' "$package_dir/pom.xml"
grep -q 'LogBrewClient.create' "$package_dir/README.md"
grep -q 'HttpTransport' "$package_dir/README.md"
grep -q 'MetricAttributes' "$package_dir/README.md"
grep -q 'ProductTimeline' "$package_dir/README.md"
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
(cd "$extract_dir" && jar --extract --file "$tmp_dir/logbrew-sdk-0.1.0-sources.jar")
test -f "$extract_dir/examples/Makefile"
make -C "$extract_dir/examples" > "$tmp_dir/extracted-examples-help.txt"
grep -qx 'run-readme-example -> make run-readme-example' "$tmp_dir/extracted-examples-help.txt"
grep -qx 'run (real-user-smoke) -> make run' "$tmp_dir/extracted-examples-help.txt"
grep -qx 'run-real-user-smoke -> make run-real-user-smoke' "$tmp_dir/extracted-examples-help.txt"
(cd "$extract_dir/examples" && make LOGBREW_JAVA_EXTRA_CP="$java_logback_classpath" run-readme-example) > "$tmp_dir/extracted-readme.stdout.json" 2> "$tmp_dir/extracted-readme.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/extracted-readme.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/extracted-readme.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/extracted-readme.stderr.json"
(cd "$extract_dir/examples" && make LOGBREW_JAVA_EXTRA_CP="$java_logback_classpath" run) > "$tmp_dir/extracted-smoke-alias.stdout.json" 2> "$tmp_dir/extracted-smoke-alias.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/extracted-smoke-alias.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/extracted-smoke-alias.stdout.json" >/dev/null
grep -q '"retryAttempts":2' "$tmp_dir/extracted-smoke-alias.stderr.json"

javac -Xlint:all -Werror --release 11 -cp "$tmp_dir/logbrew-sdk-0.1.0.jar:$java_logback_classpath" -d "$tmp_dir/example-classes" @"$example_sources"
java -cp "$tmp_dir/logbrew-sdk-0.1.0.jar:$tmp_dir/example-classes:$java_logback_classpath" ReadmeExample > "$tmp_dir/packaged-readme.stdout.json" 2> "$tmp_dir/packaged-readme.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/packaged-readme.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/packaged-readme.stdout.json" >/dev/null
grep -q '"events":6' "$tmp_dir/packaged-readme.stderr.json"
java -cp "$tmp_dir/logbrew-sdk-0.1.0.jar:$tmp_dir/example-classes:$java_logback_classpath" RealUserSmoke > "$tmp_dir/packaged-smoke.stdout.json" 2> "$tmp_dir/packaged-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/packaged-smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/packaged-smoke.stdout.json" >/dev/null
grep -q '"retryAttempts":2' "$tmp_dir/packaged-smoke.stderr.json"

lifecycle_app="$tmp_dir/lifecycle-app"
mkdir -p "$lifecycle_app/lib" "$lifecycle_app/src" "$lifecycle_app/classes"
cp "$tmp_dir/logbrew-sdk-0.1.0.jar" "$lifecycle_app/lib/logbrew-sdk-0.1.0.jar"
cat > "$lifecycle_app/src/LifecycleApp.java" <<'JAVA'
import co.logbrew.sdk.LogBrewClient;

public final class LifecycleApp {
    private LifecycleApp() {
    }

    public static void main(String[] args) {
        LogBrewClient client = LogBrewClient.create("LOGBREW_API_KEY", "lifecycle-app", "0.1.0");
        System.out.println(client.pendingEvents());
    }
}
JAVA
javac -Xlint:all -Werror --release 11 -cp "$lifecycle_app/lib/logbrew-sdk-0.1.0.jar:$java_logback_classpath" -d "$lifecycle_app/classes" "$lifecycle_app/src/LifecycleApp.java"
java -cp "$lifecycle_app/lib/logbrew-sdk-0.1.0.jar:$lifecycle_app/classes:$java_logback_classpath" LifecycleApp > "$tmp_dir/lifecycle.out"
grep -qx '0' "$tmp_dir/lifecycle.out"
rm "$lifecycle_app/lib/logbrew-sdk-0.1.0.jar"
if javac -Xlint:all -Werror --release 11 -cp "$lifecycle_app/lib/logbrew-sdk-0.1.0.jar" -d "$lifecycle_app/classes-missing" "$lifecycle_app/src/LifecycleApp.java" 2> "$tmp_dir/lifecycle-missing.err"; then
  echo "expected lifecycle app compile to fail after removing SDK jar" >&2
  exit 1
fi
test -s "$tmp_dir/lifecycle-missing.err"
cp "$tmp_dir/logbrew-sdk-0.1.0.jar" "$lifecycle_app/lib/logbrew-sdk-0.1.0.jar"
javac -Xlint:all -Werror --release 11 -cp "$lifecycle_app/lib/logbrew-sdk-0.1.0.jar:$java_logback_classpath" -d "$lifecycle_app/classes-readded" "$lifecycle_app/src/LifecycleApp.java"

smoke_app="$tmp_dir/smoke-app"
mkdir -p "$smoke_app/lib" "$smoke_app/src" "$smoke_app/classes"
cp "$tmp_dir/logbrew-sdk-0.1.0.jar" "$smoke_app/lib/logbrew-sdk-0.1.0.jar"
cat > "$smoke_app/src/Main.java" <<'JAVA'
import co.logbrew.sdk.ActionAttributes;
import co.logbrew.sdk.EnvironmentAttributes;
import co.logbrew.sdk.HttpTransport;
import co.logbrew.sdk.IssueAttributes;
import co.logbrew.sdk.LogAttributes;
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.LogBrewJulHandler;
import co.logbrew.sdk.LogBrewLogbackAppender;
import co.logbrew.sdk.MetricAttributes;
import co.logbrew.sdk.ProductTimeline;
import co.logbrew.sdk.RecordingTransport;
import co.logbrew.sdk.ReleaseAttributes;
import co.logbrew.sdk.SdkException;
import co.logbrew.sdk.SpanAttributes;
import co.logbrew.sdk.TransportException;
import co.logbrew.sdk.TransportResponse;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Collections;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;

public final class Main {
    private Main() {
    }

    public static void main(String[] args) {
        LogBrewClient client = LogBrewClient.create("LOGBREW_API_KEY", "smoke-app", "0.1.0");
        enqueueAll(client);
        System.out.println(client.previewJson());
        TransportResponse response = client.flush(RecordingTransport.alwaysAccept());
        if (response.statusCode() != 202 || response.attempts() != 1 || client.pendingEvents() != 0) {
            throw new AssertionError("unexpected successful flush state");
        }

        TransportResponse empty = client.flush(RecordingTransport.alwaysAccept());
        require(empty.statusCode() == 204 && empty.attempts() == 0, "empty flush");

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

        System.err.println("{\"ok\":true,\"status\":202,\"attempts\":1,\"events\":6,\"metricEvents\":1,\"timelineEvents\":2,\"httpAttempts\":2,\"httpRequests\":2,\"logbackEvents\":2}");
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
}
JAVA
javac -Xlint:all -Werror --release 11 -cp "$smoke_app/lib/logbrew-sdk-0.1.0.jar:$java_logback_classpath" -d "$smoke_app/classes" "$smoke_app/src/Main.java"
java -cp "$smoke_app/lib/logbrew-sdk-0.1.0.jar:$smoke_app/classes:$java_logback_classpath" Main > "$tmp_dir/smoke-app.stdout.json" 2> "$tmp_dir/smoke-app.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/smoke-app.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/smoke-app.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/smoke-app.stderr.json"
grep -q '"httpAttempts":2' "$tmp_dir/smoke-app.stderr.json"
grep -q '"httpRequests":2' "$tmp_dir/smoke-app.stderr.json"
grep -q '"logbackEvents":2' "$tmp_dir/smoke-app.stderr.json"
grep -q '"metricEvents":1' "$tmp_dir/smoke-app.stderr.json"
grep -q '"timelineEvents":2' "$tmp_dir/smoke-app.stderr.json"

jdeps --multi-release 11 --class-path "$tmp_dir/logbrew-sdk-0.1.0.jar:$java_logback_classpath" "$tmp_dir/logbrew-sdk-0.1.0.jar" > "$tmp_dir/jdeps.txt"
grep -q 'java.base' "$tmp_dir/jdeps.txt"
grep -q 'java.net.http' "$tmp_dir/jdeps.txt"
grep -q 'logback-classic' "$tmp_dir/jdeps.txt"

echo "java real-user smoke passed"
