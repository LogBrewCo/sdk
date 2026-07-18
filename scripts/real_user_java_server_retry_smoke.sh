#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/java/logbrew-java"
tmp_dir="$(mktemp -d)"
tmp_dir="$(cd "$tmp_dir" && pwd -P)"

# shellcheck source=scripts/java_logback_deps.sh
source "$repo_root/scripts/java_logback_deps.sh"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

package_version="$(python3 - "$package_dir/pom.xml" <<'PY'
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
namespace = {"m": "http://maven.apache.org/POM/4.0.0"}
print(root.findtext("m:version", namespaces=namespace))
PY
)"
jar_path="$tmp_dir/logbrew-sdk-$package_version.jar"
main_sources="$tmp_dir/main-sources.txt"
find "$package_dir/src/main/java" -name '*.java' | sort > "$main_sources"

mkdir -p "$tmp_dir/classes" "$tmp_dir/jar-stage/META-INF/maven/co.logbrew/logbrew-sdk"
java_logback_classpath="$(fetch_java_logback_deps "$tmp_dir/java-logback-deps")"
java_opentelemetry_classpath="$(fetch_java_opentelemetry_deps "$tmp_dir/java-opentelemetry-deps")"
java_servlet_classpath="$(fetch_java_servlet_deps "$tmp_dir/java-servlet-deps")"
java_spring_boot_classpath="$(fetch_java_spring_boot_deps "$tmp_dir/java-spring-boot-deps")"
java_spring_kafka_classpath="$(fetch_java_spring_kafka_deps "$tmp_dir/java-spring-kafka-deps")"
java_optional_classpath="$java_logback_classpath:$java_opentelemetry_classpath:$java_servlet_classpath:$java_spring_boot_classpath:$java_spring_kafka_classpath"

javac -Xlint:all -Werror --release 11 -cp "$java_optional_classpath" -d "$tmp_dir/classes" @"$main_sources"
cp "$package_dir/pom.xml" "$tmp_dir/jar-stage/META-INF/maven/co.logbrew/logbrew-sdk/pom.xml"
cp "$package_dir/README.md" "$tmp_dir/jar-stage/README.md"
cp -R "$tmp_dir/classes/co" "$tmp_dir/jar-stage/co"
if [ -d "$package_dir/src/main/resources" ]; then
  cp -R "$package_dir/src/main/resources/." "$tmp_dir/jar-stage/"
fi
jar --create --file "$jar_path" -C "$tmp_dir/jar-stage" .
jar --list --file "$jar_path" > "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/DeliveryHealth\$RetryDelaySource.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/HttpTransport.class$' "$tmp_dir/jar-contents.txt"

app_dir="$tmp_dir/installed-app"
mkdir -p "$app_dir/src" "$app_dir/classes"
cat > "$app_dir/src/Main.java" <<'JAVA'
import co.logbrew.sdk.AutomaticDeliveryOptions;
import co.logbrew.sdk.DeliveryHealth;
import co.logbrew.sdk.DeliveryOptions;
import co.logbrew.sdk.HttpTransport;
import co.logbrew.sdk.LogAttributes;
import co.logbrew.sdk.LogBrewClient;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

public final class Main {
    private static final String API_KEY = "LOGBREW_SERVER_RETRY_PROOF_KEY";
    private static final String SOURCE = "java-server-retry-proof";
    private static final DateTimeFormatter IMF_FIXDATE = new DateTimeFormatterBuilder()
        .appendPattern("EEE, dd MMM uuuu HH:mm:ss 'GMT'")
        .toFormatter(Locale.US)
        .withZone(ZoneOffset.UTC);

    private Main() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 1) {
            throw new IllegalArgumentException("package version is required");
        }
        try (Intake intake = new Intake()) {
            intake.start();
            LogBrewClient client = LogBrewClient.createAutomatic(
                API_KEY,
                "installed-java-server-retry",
                args[0],
                HttpTransport.builder()
                    .endpoint(intake.endpoint())
                    .header("x-logbrew-source", SOURCE)
                    .timeout(Duration.ofSeconds(3))
                    .build(),
                DeliveryOptions.builder().maxRetries(2).build(),
                AutomaticDeliveryOptions.builder()
                    .flushInterval(Duration.ofSeconds(5))
                    .queueThreshold(1)
                    .initialRetryDelay(Duration.ofMillis(60))
                    .maxRetryDelay(Duration.ofMillis(120))
                    .maxRetryAttempts(2)
                    .build()
            );

            proveRetry(client, intake, "evt_server_delta", 0, DeliveryHealth.RetryDelaySource.SERVER, 120L);
            proveRetry(client, intake, "evt_server_date", 2, DeliveryHealth.RetryDelaySource.SERVER, 120L);
            proveRetry(client, intake, "evt_server_malformed", 4, DeliveryHealth.RetryDelaySource.CLIENT, -1L);
            proveRetry(client, intake, "evt_server_duplicate", 6, DeliveryHealth.RetryDelaySource.CLIENT, -1L);
            proveTerminalGuidance(client, intake);

            DeliveryHealth finalHealth = client.deliveryHealth();
            assertEquals(2L, finalHealth.acceptedServerRetryHints(), "accepted hint count");
            assertEquals(2L, finalHealth.rejectedServerRetryHints(), "rejected hint count");
            assertHealthContentFree(finalHealth);
            client.shutdown();
            assertEquals(DeliveryHealth.Lifecycle.CLOSED, client.deliveryHealth().lifecycle(), "closed lifecycle");
            assertEquals(DeliveryHealth.RetryDelaySource.NONE, client.deliveryHealth().retryDelaySource(), "closed source");
            assertNoDeliveryThreads();
            intake.assertHealthy();

            System.out.println("{"
                + "\"ok\":true,"
                + "\"requests\":10,"
                + "\"acceptedEvents\":5,"
                + "\"exactRetryBodies\":5,"
                + "\"serverHints\":2,"
                + "\"rejectedHints\":2,"
                + "\"terminalHintIgnored\":true,"
                + "\"boundedDelays\":true,"
                + "\"healthContentFree\":true,"
                + "\"processExitClean\":true"
                + "}");
        }
    }

    private static void proveRetry(
        LogBrewClient client,
        Intake intake,
        String id,
        int requestOffset,
        DeliveryHealth.RetryDelaySource expectedSource,
        long expectedDelay
    ) throws Exception {
        client.log(id, "2026-06-02T10:00:03Z", LogAttributes.create("installed retry", "info"));
        await(() -> intake.size() >= requestOffset + 1, id + " first request");
        await(() -> client.deliveryHealth().activity() == DeliveryHealth.Activity.RETRYING, id + " retry health");
        DeliveryHealth retrying = client.deliveryHealth();
        assertEquals(expectedSource, retrying.retryDelaySource(), id + " retry source");
        if (expectedDelay >= 0L) {
            assertEquals(expectedDelay, retrying.scheduledDelayMillis(), id + " bounded server delay");
        } else {
            assertBetween(30L, 60L, retrying.scheduledDelayMillis(), id + " bounded fallback delay");
        }
        await(() -> intake.size() >= requestOffset + 2, id + " accepted retry");
        await(() -> client.deliveryHealth().acceptedEvents() >= (requestOffset / 2L) + 1L, id + " accepted health");
        Request failed = intake.request(requestOffset);
        Request accepted = intake.request(requestOffset + 1);
        assertEquals(failed.body, accepted.body, id + " byte-identical failed prefix");
        assertContains(failed.body, id, id + " stable id");
        assertNotContains(failed.body, API_KEY, id + " body key privacy");
        long elapsedMillis = TimeUnit.NANOSECONDS.toMillis(accepted.startedNanos - failed.startedNanos);
        long minimumDelay = expectedDelay >= 0L ? 80L : 15L;
        assertBetween(minimumDelay, 5_000L, elapsedMillis, id + " observed delay");
        assertEquals(DeliveryHealth.RetryDelaySource.NONE, client.deliveryHealth().retryDelaySource(), id + " cleared source");
    }

    private static void proveTerminalGuidance(LogBrewClient client, Intake intake) throws Exception {
        client.log(
            "evt_server_terminal",
            "2026-06-02T10:00:04Z",
            LogAttributes.create("installed terminal", "info")
        );
        await(() -> intake.size() >= 9, "terminal request");
        await(() -> client.deliveryHealth().activity() == DeliveryHealth.Activity.PAUSED, "terminal pause");
        DeliveryHealth paused = client.deliveryHealth();
        assertEquals(DeliveryHealth.PauseReason.AUTHENTICATION, paused.pauseReason(), "terminal reason");
        assertEquals(DeliveryHealth.RetryDelaySource.NONE, paused.retryDelaySource(), "terminal guidance ignored");
        assertEquals(2L, paused.acceptedServerRetryHints(), "terminal hint not counted");
        Thread.sleep(180L);
        assertEquals(9, intake.size(), "terminal has no scheduled retry");
        client.resumeAutomaticDelivery();
        await(() -> intake.size() >= 10, "terminal explicit recovery");
        await(() -> client.deliveryHealth().acceptedEvents() == 5L, "terminal accepted health");
        assertEquals(intake.request(8).body, intake.request(9).body, "terminal recovery body identity");
    }

    private static void assertHealthContentFree(DeliveryHealth health) {
        for (java.lang.reflect.Field field : DeliveryHealth.class.getDeclaredFields()) {
            Class<?> type = field.getType();
            if (!type.isPrimitive() && !type.isEnum()) {
                throw new AssertionError("health field is not fixed and content-free: " + field.getName());
            }
        }
        String rendered = health.lifecycle() + " " + health.activity() + " " + health.lastOutcome()
            + " " + health.pauseReason() + " " + health.lastDropReason() + " "
            + health.retryDelaySource() + " " + health.queuedEvents() + " " + health.queuedBytes()
            + " " + health.automaticAttempts() + " " + health.transportAttempts() + " "
            + health.acceptedBatches() + " " + health.acceptedEvents() + " "
            + health.consecutiveFailures() + " " + health.scheduledDelayMillis() + " "
            + health.acceptedServerRetryHints() + " " + health.rejectedServerRetryHints();
        assertNotContains(rendered, API_KEY, "health key privacy");
        assertNotContains(rendered, "Retry-After", "health header privacy");
        assertNotContains(rendered, "/v1/events", "health path privacy");
    }

    private static void assertNoDeliveryThreads() throws Exception {
        Thread.sleep(50L);
        for (Thread thread : Thread.getAllStackTraces().keySet()) {
            if (thread.isAlive() && thread.getName().startsWith("logbrew-delivery-")) {
                throw new AssertionError("delivery scheduler teardown failed");
            }
        }
    }

    private interface Condition {
        boolean value();
    }

    private static void await(Condition condition, String label) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5L);
        while (System.nanoTime() < deadline) {
            if (condition.value()) {
                return;
            }
            Thread.sleep(5L);
        }
        throw new AssertionError("timed out: " + label);
    }

    private static void assertBetween(long minimum, long maximum, long actual, String label) {
        if (actual < minimum || actual > maximum) {
            throw new AssertionError(label + ": expected " + minimum + ".." + maximum + ", got " + actual);
        }
    }

    private static void assertContains(String value, String expected, String label) {
        if (!value.contains(expected)) {
            throw new AssertionError(label);
        }
    }

    private static void assertNotContains(String value, String expected, String label) {
        if (value.contains(expected)) {
            throw new AssertionError(label);
        }
    }

    private static void assertEquals(Object expected, Object actual, String label) {
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new AssertionError(label + ": expected " + expected + ", got " + actual);
        }
    }

    private static final class Intake implements AutoCloseable {
        private final List<Request> requests = new ArrayList<>();
        private final HttpServer server;
        private volatile Throwable failure;

        private Intake() throws IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/v1/events", this::handle);
        }

        private void start() {
            server.start();
        }

        private URI endpoint() {
            return URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/v1/events");
        }

        private synchronized int size() {
            return requests.size();
        }

        private synchronized Request request(int index) {
            return requests.get(index);
        }

        private void assertHealthy() {
            if (failure != null) {
                throw new AssertionError("loopback intake failed", failure);
            }
        }

        private void handle(HttpExchange exchange) throws IOException {
            try {
                String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
                assertEquals("POST", exchange.getRequestMethod(), "request method");
                assertEquals("/v1/events", exchange.getRequestURI().getPath(), "request path");
                assertEquals("Bearer " + API_KEY, firstHeader(exchange, "authorization"), "request authorization");
                assertEquals(SOURCE, firstHeader(exchange, "x-logbrew-source"), "request source");
                int index;
                synchronized (this) {
                    index = requests.size();
                    requests.add(new Request(body, System.nanoTime()));
                }
                if (index == 0) {
                    exchange.getResponseHeaders().add("Retry-After", "1");
                    sendStatus(exchange, 503);
                } else if (index == 2) {
                    exchange.getResponseHeaders().add(
                        "Retry-After",
                        IMF_FIXDATE.format(Instant.now().plusSeconds(10L))
                    );
                    sendStatus(exchange, 503);
                } else if (index == 4) {
                    exchange.getResponseHeaders().add("Retry-After", "1, 2");
                    sendStatus(exchange, 503);
                } else if (index == 6) {
                    exchange.getResponseHeaders().add("Retry-After", "1");
                    exchange.getResponseHeaders().add("Retry-After", "2");
                    sendStatus(exchange, 503);
                } else if (index == 8) {
                    exchange.getResponseHeaders().add("Retry-After", "1");
                    sendStatus(exchange, 401);
                } else {
                    sendStatus(exchange, 202);
                }
            } catch (Throwable error) {
                failure = error;
                sendStatus(exchange, 500);
            }
        }

        @Override
        public void close() {
            server.stop(0);
        }

        private static String firstHeader(HttpExchange exchange, String name) {
            List<String> values = exchange.getRequestHeaders().get(name);
            return values == null || values.isEmpty() ? "" : values.get(0);
        }

        private static void sendStatus(HttpExchange exchange, int status) throws IOException {
            exchange.sendResponseHeaders(status, -1L);
            exchange.close();
        }
    }

    private static final class Request {
        private final String body;
        private final long startedNanos;

        private Request(String body, long startedNanos) {
            this.body = body;
            this.startedNanos = startedNanos;
        }
    }
}
JAVA

javac -Xlint:all -Werror --release 11 -cp "$jar_path" -d "$app_dir/classes" "$app_dir/src/Main.java"
summary="$(java -cp "$app_dir/classes:$jar_path" Main "$package_version")"

python3 - "$summary" <<'PY'
import json
import sys

summary = json.loads(sys.argv[1])
expected = {
    "ok": True,
    "requests": 10,
    "acceptedEvents": 5,
    "exactRetryBodies": 5,
    "serverHints": 2,
    "rejectedHints": 2,
    "terminalHintIgnored": True,
    "boundedDelays": True,
    "healthContentFree": True,
    "processExitClean": True,
}
if summary != expected:
    raise SystemExit(f"unexpected Java server retry proof: {summary!r}")
PY

jar_sha256="$(shasum -a 256 "$jar_path" | awk '{print $1}')"
printf 'java server-directed retry installed-JAR proof passed (version=%s sha256=%s requests=10 exact-retries=5)\n' \
  "$package_version" "$jar_sha256"
