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
find "$package_dir/src/main/java" -name '*.java' | sort > "$main_sources"

mkdir -p "$tmp_dir/classes" "$tmp_dir/jar-stage/META-INF/maven/co.logbrew/logbrew-sdk"
java_logback_classpath="$(fetch_java_logback_deps "$tmp_dir/java-logback-deps")"
java_opentelemetry_classpath="$(fetch_java_opentelemetry_deps "$tmp_dir/java-opentelemetry-deps")"
java_servlet_classpath="$(fetch_java_servlet_deps "$tmp_dir/java-servlet-deps")"
java_optional_classpath="$java_logback_classpath:$java_opentelemetry_classpath:$java_servlet_classpath"

javac -Xlint:all -Werror --release 11 -cp "$java_optional_classpath" -d "$tmp_dir/classes" @"$main_sources"
cp "$package_dir/pom.xml" "$tmp_dir/jar-stage/META-INF/maven/co.logbrew/logbrew-sdk/pom.xml"
cp "$package_dir/README.md" "$tmp_dir/jar-stage/README.md"
cp -R "$tmp_dir/classes/co" "$tmp_dir/jar-stage/co"
jar --create --file "$tmp_dir/logbrew-sdk-0.1.0.jar" -C "$tmp_dir/jar-stage" .

app_dir="$tmp_dir/java-high-load-app"
mkdir -p "$app_dir/src" "$app_dir/classes"
cat > "$app_dir/src/Main.java" <<'JAVA'
import co.logbrew.sdk.HttpTransport;
import co.logbrew.sdk.LogAttributes;
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.RecordingTransport;
import co.logbrew.sdk.SdkException;
import co.logbrew.sdk.TransportResponse;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

public final class Main {
    private static final int HIGH_VOLUME_LOGS = 1500;
    private static final int MAX_QUEUE_SIZE = 1000;
    private static final String API_KEY = "LOGBREW_SERVER_API_KEY";
    private static final String TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

    private Main() {
    }

    public static void main(String[] args) throws Exception {
        List<LogBrewClient.EventDrop> drops = new ArrayList<>();
        LogBrewClient client = LogBrewClient.create(
            API_KEY,
            "java-high-load-smoke",
            "0.1.0",
            1,
            MAX_QUEUE_SIZE,
            drops::add
        );

        for (int index = 0; index < HIGH_VOLUME_LOGS; index++) {
            client.log(eventId(index), timestamp(index), LogAttributes
                .create("checkout queue heartbeat", index % 10 == 0 ? "warning" : "info")
                .logger("checkout.high-load")
                .metadata(metadata(index)));
        }

        assertEquals(MAX_QUEUE_SIZE, client.pendingEvents(), "bounded queue size");
        assertEquals(HIGH_VOLUME_LOGS - MAX_QUEUE_SIZE, client.droppedEvents(), "dropped event count");
        assertEquals(HIGH_VOLUME_LOGS - MAX_QUEUE_SIZE, drops.size(), "drop callback count");
        assertEquals("evt_java_high_load_1000", drops.get(0).eventId(), "first dropped event id");
        assertEquals("log", drops.get(0).eventType(), "first dropped event type");
        assertEquals("queue_overflow", drops.get(0).reason(), "first dropped event reason");

        LogBrewClient advisoryClient = LogBrewClient.create(
            API_KEY,
            "java-high-load-advisory-drop-smoke",
            "0.1.0",
            1,
            1,
            drop -> {
                throw new IllegalStateException("drop callback must not interrupt logging");
            }
        );
        advisoryClient.log("evt_java_advisory_001", timestamp(2000), LogAttributes.create("queued", "info"));
        advisoryClient.log("evt_java_advisory_002", timestamp(2001), LogAttributes.create("dropped", "info"));
        assertEquals(1, advisoryClient.pendingEvents(), "advisory queue size");
        assertEquals(1, advisoryClient.droppedEvents(), "advisory drops");

        FakeIntake intake = FakeIntake.start();
        TransportResponse response;
        try {
            response = client.flush(HttpTransport.builder()
                .endpoint(URI.create("http://127.0.0.1:" + intake.port() + "/v1/events"))
                .header("x-logbrew-source", "java-high-load-smoke")
                .timeout(Duration.ofSeconds(5))
                .build());
        } finally {
            intake.close();
        }

        assertEquals(202, response.statusCode(), "flush status");
        assertEquals(2, response.attempts(), "retry attempts");
        assertEquals(2, intake.requestCount(), "retry request count");
        assertEquals(0, client.pendingEvents(), "queue after successful flush");
        String body = intake.lastBody();
        assertEquals(MAX_QUEUE_SIZE, occurrences(body, "\"type\": \"log\""), "flushed event count");
        assertContains(body, "\"name\": \"java-high-load-smoke\"");
        assertContains(body, "evt_java_high_load_0000");
        assertContains(body, "evt_java_high_load_0999");
        assertContains(body, "\"traceId\": \"" + TRACE_ID + "\"");
        assertContains(body, "\"release\": \"checkout@1.2.3\"");
        assertContains(body, "\"environment\": \"production\"");
        assertContains(body, "\"level\": \"warning\"");
        assertNotContains(body, "evt_java_high_load_1000");
        assertNoUnsafeContent(body);

        LogBrewClient shutdownClient = LogBrewClient.create(API_KEY, "java-high-load-shutdown-smoke", "0.1.0");
        shutdownClient.log("evt_java_shutdown_001", timestamp(3000), LogAttributes.create("shutdown flush", "info"));
        TransportResponse shutdownResponse = shutdownClient.shutdown(RecordingTransport.alwaysAccept());
        assertEquals(202, shutdownResponse.statusCode(), "shutdown status");
        SdkException shutdownError = captureSdkException(() ->
            shutdownClient.log("evt_java_shutdown_after_001", timestamp(3001), LogAttributes.create("after shutdown", "info"))
        );
        assertEquals("shutdown_error", shutdownError.code(), "post-shutdown error code");

        System.out.println("{"
            + "\"ok\":true,"
            + "\"droppedEvents\":" + client.droppedEvents() + ","
            + "\"flushedEvents\":" + occurrences(body, "\"type\": \"log\"") + ","
            + "\"highVolumeLogs\":" + HIGH_VOLUME_LOGS + ","
            + "\"pendingEvents\":" + client.pendingEvents() + ","
            + "\"retryAttempts\":" + response.attempts() + ","
            + "\"shutdownStatus\":" + shutdownResponse.statusCode()
            + "}");
    }

    private static String eventId(int index) {
        return String.format("evt_java_high_load_%04d", Integer.valueOf(index));
    }

    private static String timestamp(int offsetSeconds) {
        return Instant.parse("2026-06-02T10:00:00Z").plusSeconds(offsetSeconds).toString();
    }

    private static Map<String, Object> metadata(int index) {
        Map<String, Object> values = new LinkedHashMap<>();
        values.put("environment", "production");
        values.put("release", "checkout@1.2.3");
        values.put("sequence", Integer.valueOf(index));
        values.put("traceId", TRACE_ID);
        return values;
    }

    private static void assertEquals(Object expected, Object actual, String label) {
        if (!expected.equals(actual)) {
            throw new AssertionError(label + ": expected " + expected + ", got " + actual);
        }
    }

    private static void assertContains(String value, String needle) {
        if (!value.contains(needle)) {
            throw new AssertionError("expected payload to contain " + needle);
        }
    }

    private static void assertNotContains(String value, String needle) {
        if (value.contains(needle)) {
            throw new AssertionError("expected payload to omit " + needle);
        }
    }

    private static void assertNoUnsafeContent(String body) {
        for (String unsafe : new String[] {
            API_KEY,
            "coupon=summer",
            "#fragment",
            "authorization"
        }) {
            if (body.contains(unsafe)) {
                throw new AssertionError("payload included unsafe content " + unsafe);
            }
        }
    }

    private static SdkException captureSdkException(Runnable callback) {
        try {
            callback.run();
        } catch (SdkException error) {
            return error;
        }
        throw new AssertionError("expected SdkException");
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

    private static final class FakeIntake implements AutoCloseable {
        private final HttpServer server;
        private final AtomicInteger requests = new AtomicInteger();
        private final List<String> bodies = new ArrayList<>();

        private FakeIntake(HttpServer server) {
            this.server = server;
        }

        static FakeIntake start() throws IOException {
            HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            FakeIntake intake = new FakeIntake(server);
            server.createContext("/v1/events", intake::handle);
            server.start();
            return intake;
        }

        int port() {
            return server.getAddress().getPort();
        }

        int requestCount() {
            return requests.get();
        }

        String lastBody() {
            if (bodies.isEmpty()) {
                throw new AssertionError("expected fake intake body");
            }
            return bodies.get(bodies.size() - 1);
        }

        private void handle(HttpExchange exchange) throws IOException {
            int requestNumber = requests.incrementAndGet();
            assertEquals("POST", exchange.getRequestMethod(), "fake intake method");
            assertEquals("/v1/events", exchange.getRequestURI().getPath(), "fake intake path");
            assertEquals("Bearer " + API_KEY, firstHeader(exchange, "authorization"), "fake intake auth");
            assertEquals("application/json", firstHeader(exchange, "content-type"), "fake intake content type");
            assertEquals("java-high-load-smoke", firstHeader(exchange, "x-logbrew-source"), "fake intake source");
            bodies.add(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] response = "accepted".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(requestNumber == 1 ? 503 : 202, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        }

        private static String firstHeader(HttpExchange exchange, String name) {
            List<String> values = exchange.getRequestHeaders().get(name);
            if (values == null || values.isEmpty()) {
                return "";
            }
            return values.get(0);
        }

        @Override
        public void close() {
            server.stop(0);
        }
    }
}
JAVA

javac -Xlint:all -Werror --release 11 \
  -cp "$tmp_dir/logbrew-sdk-0.1.0.jar:$java_optional_classpath" \
  -d "$app_dir/classes" \
  "$app_dir/src/Main.java"
java -cp "$tmp_dir/logbrew-sdk-0.1.0.jar:$app_dir/classes:$java_optional_classpath" Main > "$tmp_dir/smoke-summary.json"

python3 - "$tmp_dir/smoke-summary.json" <<'PY'
import json
import sys
from pathlib import Path

summary = json.loads(Path(sys.argv[1]).read_text())
expected = {
    "ok": True,
    "droppedEvents": 500,
    "flushedEvents": 1000,
    "highVolumeLogs": 1500,
    "pendingEvents": 0,
    "retryAttempts": 2,
    "shutdownStatus": 202,
}
for key, value in expected.items():
    if summary.get(key) != value:
        raise SystemExit(f"unexpected {key}: {summary!r}")
PY

echo "java high-load installed-artifact smoke passed: 1500 logs, 1000 flushed, 500 dropped, retryAttempts=2"
