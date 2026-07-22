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
java_spring_boot_classpath="$(fetch_java_spring_boot_deps "$tmp_dir/java-spring-boot-deps")"
java_spring_kafka_classpath="$(fetch_java_spring_kafka_deps "$tmp_dir/java-spring-kafka-deps")"
java_spring_web_classpath="$(fetch_java_spring_web_deps "$tmp_dir/java-spring-web-deps")"
java_optional_classpath="$java_logback_classpath:$java_opentelemetry_classpath:$java_servlet_classpath:$java_spring_boot_classpath:$java_spring_kafka_classpath:$java_spring_web_classpath"

javac -Xlint:all -Werror --release 11 -cp "$java_optional_classpath" -d "$tmp_dir/classes" @"$main_sources"
cp "$package_dir/pom.xml" "$tmp_dir/jar-stage/META-INF/maven/co.logbrew/logbrew-sdk/pom.xml"
cp "$package_dir/README.md" "$tmp_dir/jar-stage/README.md"
cp -R "$tmp_dir/classes/co" "$tmp_dir/jar-stage/co"
if [ -d "$package_dir/src/main/resources" ]; then
  cp -R "$package_dir/src/main/resources/." "$tmp_dir/jar-stage/"
fi
jar --create --file "$tmp_dir/logbrew-sdk-0.1.0.jar" -C "$tmp_dir/jar-stage" .

app_dir="$tmp_dir/java-high-load-app"
mkdir -p "$app_dir/src" "$app_dir/classes"
cat > "$app_dir/src/Main.java" <<'JAVA'
import co.logbrew.sdk.DeliveryOptions;
import co.logbrew.sdk.HttpTransport;
import co.logbrew.sdk.LogAttributes;
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.SdkException;
import co.logbrew.sdk.Transport;
import co.logbrew.sdk.TransportResponse;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

public final class Main {
    private static final int HIGH_VOLUME_LOGS = 1500;
    private static final int RETAINED_LOGS = 1000;
    private static final int BATCH_PROBE_LOGS = 120;
    private static final String API_KEY = "LOGBREW_SERVER_API_KEY";
    private static final String SOURCE = "java-delivery-smoke";
    private static final String TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

    private Main() {
    }

    public static void main(String[] args) throws Exception {
        long queueByteLimit = measureQueueBytes();
        int batchByteLimit = measureBatchBytes();
        List<LogBrewClient.EventDrop> drops = new ArrayList<>();
        LogBrewClient client = client(DeliveryOptions.builder()
            .maxRetries(1)
            .maxQueueEvents(HIGH_VOLUME_LOGS)
            .maxQueueBytes(queueByteLimit)
            .maxBatchEvents(HIGH_VOLUME_LOGS)
            .maxBatchBytes(batchByteLimit)
            .onEventDropped(drops::add)
            .build());

        enqueueRange(client, 0, HIGH_VOLUME_LOGS);
        assertEquals(RETAINED_LOGS, client.pendingEvents(), "byte-bounded queue size");
        assertEquals(queueByteLimit, client.pendingEventBytes(), "byte-bounded queue bytes");
        assertEquals(HIGH_VOLUME_LOGS - RETAINED_LOGS, client.droppedEvents(), "drop count");
        assertTrue(client.droppedEventBytes() > 0L, "drop byte count");
        assertEquals(HIGH_VOLUME_LOGS - RETAINED_LOGS, drops.size(), "drop callback count");
        assertEquals("queue_overflow", drops.get(0).reason(), "drop reason");
        assertTrue(drops.get(0).serializedBytes() > 0L, "drop callback bytes");

        FakeIntake intake = FakeIntake.start(503);
        TransportResponse response;
        int firstFlushRequests;
        try {
            HttpTransport httpTransport = transport(intake);
            AtomicInteger calls = new AtomicInteger();
            Transport captureDuringDelivery = (apiKey, body) -> {
                if (calls.incrementAndGet() == 3) {
                    enqueueLog(client, "evt_java_high_load_later", 2000, "later snapshot");
                }
                return httpTransport.send(apiKey, body);
            };

            response = client.flush(captureDuringDelivery);
            firstFlushRequests = intake.requestCount();

            assertTrue(response.batches() > 1, "bounded request splitting");
            assertEquals(response.batches() + 1, response.attempts(), "aggregate retry attempts");
            assertEquals(RETAINED_LOGS, response.acceptedEvents(), "accepted high-load events");
            assertEquals(response.attempts(), firstFlushRequests, "high-load request count");
            assertEquals(intake.body(0), intake.body(1), "immutable retry body");
            assertEquals(1, client.pendingEvents(), "later capture retained");
            assertContains(client.previewJson(), "evt_java_high_load_later");

            int acceptedEvents = 0;
            for (int index = 0; index < firstFlushRequests; index++) {
                String body = intake.body(index);
                assertTrue(utf8Bytes(body) <= batchByteLimit, "request byte bound");
                assertNoUnsafeContent(body);
                if (index > 0) {
                    acceptedEvents += occurrences(body, "\"type\": \"log\"");
                }
            }
            assertEquals(RETAINED_LOGS, acceptedEvents, "accepted fake-intake event count");
            assertContains(intake.body(1), "evt_java_high_load_0000");
            assertAnyBodyContains(intake.bodies(), "evt_java_high_load_0999");
            assertNoBodyContains(intake.bodies(), "evt_java_high_load_later", firstFlushRequests);

            TransportResponse laterResponse = client.flush(httpTransport);
            assertEquals(1, laterResponse.acceptedEvents(), "later accepted events");
            assertEquals(0, client.pendingEvents(), "later pending events");
        } finally {
            intake.close();
        }

        testAcceptedPrefixRetention();
        testFailedShutdownRecovery();

        System.out.println("{"
            + "\"ok\":true,"
            + "\"acceptedEvents\":" + response.acceptedEvents() + ","
            + "\"droppedEvents\":" + client.droppedEvents() + ","
            + "\"highLoadBatches\":" + response.batches() + ","
            + "\"highVolumeLogs\":" + HIGH_VOLUME_LOGS + ","
            + "\"prefixRetainedEvents\":3,"
            + "\"retryAttempts\":" + response.attempts() + ","
            + "\"shutdownRecovered\":true"
            + "}");
    }

    private static long measureQueueBytes() {
        LogBrewClient probe = client(DeliveryOptions.builder()
            .maxQueueEvents(RETAINED_LOGS)
            .maxQueueBytes(64L * 1024L * 1024L)
            .build());
        enqueueRange(probe, 0, RETAINED_LOGS);
        return probe.pendingEventBytes();
    }

    private static int measureBatchBytes() {
        LogBrewClient probe = client(DeliveryOptions.builder()
            .maxQueueEvents(BATCH_PROBE_LOGS)
            .maxQueueBytes(64L * 1024L * 1024L)
            .build());
        enqueueRange(probe, 0, BATCH_PROBE_LOGS);
        return utf8Bytes(probe.previewJson());
    }

    private static void testAcceptedPrefixRetention() throws Exception {
        LogBrewClient client = client(DeliveryOptions.builder()
            .maxRetries(0)
            .maxQueueEvents(10)
            .maxQueueBytes(1_000_000)
            .maxBatchEvents(2)
            .maxBatchBytes(1_000_000)
            .build());
        for (int index = 0; index < 5; index++) {
            enqueueLog(client, "evt_java_prefix_" + index, 3000 + index, "prefix");
        }
        FakeIntake intake = FakeIntake.start(202, 400);
        try {
            SdkException error = captureSdkException(() -> client.flush(transport(intake)));
            assertEquals("transport_error", error.code(), "prefix failure code");
            assertEquals(2, intake.requestCount(), "prefix request count");
            assertEquals(3, client.pendingEvents(), "prefix retained events");
            String pending = client.previewJson();
            assertNotContains(pending, "evt_java_prefix_0");
            assertNotContains(pending, "evt_java_prefix_1");
            assertContains(pending, "evt_java_prefix_2");
            assertContains(pending, "evt_java_prefix_4");
        } finally {
            intake.close();
        }
    }

    private static void testFailedShutdownRecovery() throws Exception {
        LogBrewClient client = client(DeliveryOptions.builder().maxRetries(0).build());
        enqueueLog(client, "evt_java_shutdown_initial", 4000, "initial");
        FakeIntake intake = FakeIntake.start(503, 202);
        try {
            HttpTransport transport = transport(intake);
            SdkException failure = captureSdkException(() -> client.shutdown(transport));
            assertEquals("transport_error", failure.code(), "failed shutdown code");
            assertTrue(!client.isClosed(), "failed shutdown reopens");
            assertEquals(1, client.pendingEvents(), "failed shutdown retained events");

            enqueueLog(client, "evt_java_shutdown_recovery", 4001, "recovery");
            TransportResponse recovered = client.shutdown(transport);
            assertEquals(2, recovered.acceptedEvents(), "shutdown recovered events");
            assertTrue(client.isClosed(), "successful shutdown closes");
            assertEquals(0, client.pendingEvents(), "shutdown recovery pending events");
            assertEquals("shutdown_error", captureSdkException(() ->
                enqueueLog(client, "evt_java_shutdown_after", 4002, "closed")).code(),
                "post-shutdown code");
        } finally {
            intake.close();
        }
    }

    private static LogBrewClient client(DeliveryOptions options) {
        return LogBrewClient.create(API_KEY, SOURCE, "0.1.0", options);
    }

    private static HttpTransport transport(FakeIntake intake) {
        return HttpTransport.builder()
            .endpoint(URI.create("http://127.0.0.1:" + intake.port() + "/v1/events"))
            .header("x-logbrew-source", SOURCE)
            .timeout(Duration.ofSeconds(5))
            .build();
    }

    private static void enqueueRange(LogBrewClient client, int start, int end) {
        for (int index = start; index < end; index++) {
            enqueueLog(client, eventId(index), index, "checkout queue heartbeat");
        }
    }

    private static void enqueueLog(LogBrewClient client, String id, int offsetSeconds, String message) {
        client.log(id, timestamp(offsetSeconds), LogAttributes
            .create(message, offsetSeconds % 10 == 0 ? "warning" : "info")
            .logger("checkout.high-load")
            .metadata(metadata(offsetSeconds)));
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

    private static int utf8Bytes(String value) {
        return value.getBytes(StandardCharsets.UTF_8).length;
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

    private static void assertAnyBodyContains(List<String> bodies, String needle) {
        for (String body : bodies) {
            if (body.contains(needle)) {
                return;
            }
        }
        throw new AssertionError("expected a body to contain " + needle);
    }

    private static void assertNoBodyContains(List<String> bodies, String needle, int limit) {
        for (int index = 0; index < limit; index++) {
            assertNotContains(bodies.get(index), needle);
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
                throw new AssertionError("payload included unsafe content");
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

    private static void assertEquals(Object expected, Object actual, String label) {
        if (!expected.equals(actual)) {
            throw new AssertionError(label + ": expected " + expected + ", got " + actual);
        }
    }

    private static void assertContains(String value, String needle) {
        if (!value.contains(needle)) {
            throw new AssertionError("expected value to contain " + needle);
        }
    }

    private static void assertNotContains(String value, String needle) {
        if (value.contains(needle)) {
            throw new AssertionError("expected value to omit " + needle);
        }
    }

    private static void assertTrue(boolean value, String label) {
        if (!value) {
            throw new AssertionError(label);
        }
    }

    private static final class FakeIntake implements AutoCloseable {
        private final HttpServer server;
        private final Deque<Integer> statuses;
        private final List<String> bodies = Collections.synchronizedList(new ArrayList<>());

        private FakeIntake(HttpServer server, int... statuses) {
            this.server = server;
            this.statuses = new ArrayDeque<>();
            for (int status : statuses) {
                this.statuses.add(Integer.valueOf(status));
            }
        }

        static FakeIntake start(int... statuses) throws IOException {
            HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            FakeIntake intake = new FakeIntake(server, statuses);
            server.createContext("/v1/events", intake::handle);
            server.start();
            return intake;
        }

        int port() {
            return server.getAddress().getPort();
        }

        int requestCount() {
            return bodies.size();
        }

        String body(int index) {
            return bodies.get(index);
        }

        List<String> bodies() {
            return new ArrayList<>(bodies);
        }

        private void handle(HttpExchange exchange) throws IOException {
            assertEquals("POST", exchange.getRequestMethod(), "fake intake method");
            assertEquals("/v1/events", exchange.getRequestURI().getPath(), "fake intake path");
            assertEquals("Bearer " + API_KEY, firstHeader(exchange, "authorization"), "fake intake auth");
            assertEquals("application/json", firstHeader(exchange, "content-type"), "fake intake content type");
            assertEquals(SOURCE, firstHeader(exchange, "x-logbrew-source"), "fake intake source");
            bodies.add(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            int status = statuses.isEmpty() ? 202 : statuses.removeFirst().intValue();
            byte[] response = "accepted".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(status, response.length);
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
    "acceptedEvents": 1000,
    "droppedEvents": 500,
    "highVolumeLogs": 1500,
    "prefixRetainedEvents": 3,
    "shutdownRecovered": True,
}
for key, value in expected.items():
    if summary.get(key) != value:
        raise SystemExit(f"unexpected {key}: {summary!r}")
if summary.get("highLoadBatches", 0) < 2:
    raise SystemExit(f"expected split high-load batches: {summary!r}")
if summary.get("retryAttempts") != summary.get("highLoadBatches") + 1:
    raise SystemExit(f"expected one immutable-body retry: {summary!r}")
PY

echo "java installed delivery smoke passed: 1500 logs, byte/count bounds, split retry, prefix retention, shutdown recovery"
