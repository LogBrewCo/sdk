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
java_spring_web_classpath="$(fetch_java_spring_web_deps "$tmp_dir/java-spring-web-deps")"
java_optional_classpath="$java_logback_classpath:$java_opentelemetry_classpath:$java_servlet_classpath:$java_spring_boot_classpath:$java_spring_kafka_classpath:$java_spring_web_classpath"

javac -Xlint:all -Werror --release 11 -cp "$java_optional_classpath" -d "$tmp_dir/classes" @"$main_sources"
cp "$package_dir/pom.xml" "$tmp_dir/jar-stage/META-INF/maven/co.logbrew/logbrew-sdk/pom.xml"
cp "$package_dir/README.md" "$tmp_dir/jar-stage/README.md"
cp -R "$tmp_dir/classes/co" "$tmp_dir/jar-stage/co"
if [ -d "$package_dir/src/main/resources" ]; then
  cp -R "$package_dir/src/main/resources/." "$tmp_dir/jar-stage/"
fi
jar --create --file "$jar_path" -C "$tmp_dir/jar-stage" .
jar --list --file "$jar_path" > "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/AutomaticDeliveryOptions.class$' "$tmp_dir/jar-contents.txt"
grep -q '^co/logbrew/sdk/DeliveryHealth.class$' "$tmp_dir/jar-contents.txt"

app_dir="$tmp_dir/installed-app"
store_dir="$app_dir/state"
key_file="$app_dir/persistence.key"
mkdir -p "$app_dir/src" "$app_dir/classes"
dd if=/dev/urandom of="$key_file" bs=32 count=1 status=none
chmod 600 "$key_file"

cat > "$app_dir/src/Main.java" <<'JAVA'
import co.logbrew.sdk.AutomaticDeliveryOptions;
import co.logbrew.sdk.DeliveryHealth;
import co.logbrew.sdk.DeliveryOptions;
import co.logbrew.sdk.EncryptedEventStore;
import co.logbrew.sdk.HttpTransport;
import co.logbrew.sdk.LogAttributes;
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.PersistenceStatus;
import co.logbrew.sdk.Transport;
import co.logbrew.sdk.TransportResponse;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

public final class Main {
    private static final String API_KEY = "LOGBREW_AUTOMATIC_PROOF_KEY";
    private static final String SOURCE = "java-automatic-proof";
    private static final String PERSISTED_ID = "evt_java_auto_persisted";
    private static final String INITIAL_ID = "evt_java_auto_initial";
    private static final String LATER_ID = "evt_java_auto_later";
    private static final String AUTH_ID = "evt_java_auto_auth";
    private static final String PRIVATE_MESSAGE = "automatic-private-message";

    private Main() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length == 4 && "persist".equals(args[0])) {
            persistAndHalt(Path.of(args[1]), Path.of(args[2]), args[3]);
            return;
        }
        if (args.length == 5 && "recover".equals(args[0])) {
            recoverAndDeliver(Path.of(args[1]), Path.of(args[2]), args[3], args[4]);
            return;
        }
        throw new IllegalArgumentException("mode, key, store, digest when recovering, and version are required");
    }

    private static void persistAndHalt(Path keyFile, Path directory, String version) throws Exception {
        byte[] key = Files.readAllBytes(keyFile);
        try {
            EncryptedEventStore store = EncryptedEventStore.open(directory, key);
            LogBrewClient client = LogBrewClient.createAutomatic(
                API_KEY,
                "installed-java-automatic-persistent",
                version,
                (apiKey, body) -> {
                    throw new AssertionError("long-interval writer must not deliver");
                },
                DeliveryOptions.builder().encryptedEventStore(store).build(),
                AutomaticDeliveryOptions.builder()
                    .flushInterval(Duration.ofHours(1))
                    .queueThreshold(10)
                    .build()
            );
            assertEquals(0, client.recoverPersistedEvents().pendingEvents(), "empty writer recovery");
            client.log(
                PERSISTED_ID,
                "2026-06-02T10:00:03Z",
                LogAttributes.create(PRIVATE_MESSAGE, "info")
            );
            String preview = client.previewJson();
            assertContains(preview, PERSISTED_ID, "writer preview id");
            assertEquals(1, client.persistenceStatus().pendingEvents(), "durable writer admission");
            System.out.println("{"
                + "\"phase\":\"hard-exit\","
                + "\"persistedEvents\":1,"
                + "\"previewSha256\":\"" + sha256(preview) + "\""
                + "}");
            System.out.flush();
            Runtime.getRuntime().halt(0);
        } finally {
            Arrays.fill(key, (byte) 0);
        }
    }

    private static void recoverAndDeliver(
        Path keyFile,
        Path directory,
        String expectedPreviewSha256,
        String version
    ) throws Exception {
        byte[] key = Files.readAllBytes(keyFile);
        FakeIntake intake = new FakeIntake();
        intake.start();
        try {
            HttpTransport http = HttpTransport.builder()
                .endpoint(intake.endpoint())
                .header("x-logbrew-source", SOURCE)
                .timeout(Duration.ofSeconds(3))
                .build();
            proveRestartHydration(directory, key, version, http, intake, expectedPreviewSha256);
            proveRetryPauseAndRecovery(directory, key, version, http, intake);
            assertRequestContract(intake.requests());
            assertNoDeliveryThreads();
            System.out.println("{"
                + "\"ok\":true,"
                + "\"restartHydrated\":1,"
                + "\"requests\":6,"
                + "\"acceptedEvents\":3,"
                + "\"retryBodiesStable\":true,"
                + "\"terminalBodyStable\":true,"
                + "\"healthContentFree\":true,"
                + "\"processExitClean\":true"
                + "}");
        } finally {
            intake.stop();
            Arrays.fill(key, (byte) 0);
        }
    }

    private static void proveRestartHydration(
        Path directory,
        byte[] key,
        String version,
        Transport transport,
        FakeIntake intake,
        String expectedPreviewSha256
    ) throws Exception {
        try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
            LogBrewClient client = LogBrewClient.createAutomatic(
                API_KEY,
                "installed-java-automatic-persistent",
                version,
                transport,
                DeliveryOptions.builder().encryptedEventStore(store).maxRetries(0).build(),
                AutomaticDeliveryOptions.builder()
                    .flushInterval(Duration.ofSeconds(1))
                    .queueThreshold(10)
                    .build()
            );
            PersistenceStatus recovered = client.recoverPersistedEvents();
            assertEquals(1, recovered.pendingEvents(), "restart hydrated count");
            String preview = client.previewJson();
            assertEquals(expectedPreviewSha256, sha256(preview), "restart preview digest");
            assertContains(preview, PERSISTED_ID, "restart stable id");
            await(() -> intake.requests().size() == 1, "restart automatic request");
            await(() -> client.deliveryHealth().acceptedEvents() == 1L, "restart accepted health");
            assertEquals(0, client.persistenceStatus().pendingEvents(), "restart durable acknowledgement");
            assertOwnerOnly(directory);
            assertHealthContentFree(client.deliveryHealth(), directory, key);
            client.shutdown();
            assertEquals(DeliveryHealth.Lifecycle.CLOSED, client.deliveryHealth().lifecycle(), "restart closed");
        }
    }

    private static void proveRetryPauseAndRecovery(
        Path directory,
        byte[] key,
        String version,
        Transport http,
        FakeIntake intake
    ) throws Exception {
        AtomicReference<LogBrewClient> clientRef = new AtomicReference<>();
        AtomicInteger calls = new AtomicInteger();
        Transport captureDuringFailure = (apiKey, body) -> {
            TransportResponse response = http.send(apiKey, body);
            if (calls.incrementAndGet() == 1) {
                clientRef.get().log(
                    LATER_ID,
                    "2026-06-02T10:00:04Z",
                    LogAttributes.create("later-private-message", "info")
                );
            }
            return response;
        };
        LogBrewClient client = LogBrewClient.createAutomatic(
            API_KEY,
            "installed-java-automatic-memory",
            version,
            captureDuringFailure,
            DeliveryOptions.builder()
                .maxRetries(0)
                .maxBatchEvents(10)
                .maxBatchBytes(256 * 1024)
                .build(),
            AutomaticDeliveryOptions.builder()
                .flushInterval(Duration.ofSeconds(1))
                .queueThreshold(1)
                .initialRetryDelay(Duration.ofMillis(20))
                .maxRetryDelay(Duration.ofMillis(20))
                .maxRetryAttempts(2)
                .build()
        );
        clientRef.set(client);
        client.log(
            INITIAL_ID,
            "2026-06-02T10:00:03Z",
            LogAttributes.create(PRIVATE_MESSAGE, "info")
        );
        await(() -> intake.requests().size() == 4, "retry and later requests");
        await(() -> client.deliveryHealth().acceptedEvents() == 2L, "retry accepted health");

        List<Request> firstFour = intake.requests();
        assertEquals(firstFour.get(1).body, firstFour.get(2).body, "503 retry body identity");
        assertContains(firstFour.get(1).body, INITIAL_ID, "failed prefix id");
        assertNotContains(firstFour.get(1).body, LATER_ID, "failed prefix excludes later capture");
        assertContains(firstFour.get(3).body, LATER_ID, "later capture retained");

        client.log(
            AUTH_ID,
            "2026-06-02T10:00:05Z",
            LogAttributes.create("auth-private-message", "error")
        );
        await(() -> intake.requests().size() == 5, "terminal request");
        await(
            () -> client.deliveryHealth().pauseReason() == DeliveryHealth.PauseReason.AUTHENTICATION,
            "authentication pause"
        );
        int pausedRequests = intake.requests().size();
        Thread.sleep(100L);
        assertEquals(pausedRequests, intake.requests().size(), "terminal pause has no hot loop");
        DeliveryHealth paused = client.deliveryHealth();
        assertEquals(1, paused.queuedEvents(), "terminal prefix retained");
        assertEquals(DeliveryHealth.Activity.PAUSED, paused.activity(), "terminal activity");
        assertHealthContentFree(paused, directory, key);

        client.resumeAutomaticDelivery();
        await(() -> intake.requests().size() == 6, "manual recovery request");
        await(() -> client.deliveryHealth().acceptedEvents() == 3L, "manual recovery accepted");
        List<Request> all = intake.requests();
        assertEquals(all.get(4).body, all.get(5).body, "terminal recovery body identity");
        assertEquals(0, client.deliveryHealth().queuedEvents(), "manual recovery drained");
        assertHealthContentFree(client.deliveryHealth(), directory, key);
        client.shutdown();
        assertEquals(DeliveryHealth.Lifecycle.CLOSED, client.deliveryHealth().lifecycle(), "memory closed");
    }

    private static void assertRequestContract(List<Request> requests) {
        assertEquals(6, requests.size(), "request count");
        for (Request request : requests) {
            assertEquals("POST", request.method, "request method");
            assertEquals("/v1/events", request.path, "request path");
            assertEquals("Bearer " + API_KEY, request.authorization, "authorization header");
            assertEquals("application/json", request.contentType, "content type");
            assertEquals(SOURCE, request.source, "source header");
            assertTrue(request.body.getBytes(StandardCharsets.UTF_8).length <= 256 * 1024, "request byte bound");
            assertNotContains(request.body, API_KEY, "body omits API key");
            assertNotContains(request.body, "persistence.key", "body omits key path");
        }
    }

    private static void assertHealthContentFree(DeliveryHealth health, Path directory, byte[] key) {
        String rendered = health.lifecycle() + " "
            + health.activity() + " "
            + health.lastOutcome() + " "
            + health.pauseReason() + " "
            + health.lastDropReason() + " "
            + health.automaticDelivery() + " "
            + health.inFlight() + " "
            + health.wakeCoalesced() + " "
            + health.queuedEvents() + " "
            + health.queuedBytes() + " "
            + health.droppedEvents() + " "
            + health.droppedBytes() + " "
            + health.automaticAttempts() + " "
            + health.transportAttempts() + " "
            + health.acceptedBatches() + " "
            + health.acceptedEvents() + " "
            + health.consecutiveFailures() + " "
            + health.scheduledDelayMillis();
        for (String forbidden : Arrays.asList(
            API_KEY,
            SOURCE,
            PERSISTED_ID,
            INITIAL_ID,
            LATER_ID,
            AUTH_ID,
            PRIVATE_MESSAGE,
            directory.toString(),
            hex(key),
            "http://",
            "/v1/events"
        )) {
            assertNotContains(rendered, forbidden, "health privacy");
        }
        Arrays.stream(DeliveryHealth.class.getDeclaredFields()).forEach(field -> {
            Class<?> type = field.getType();
            if (String.class.equals(type)
                || Throwable.class.isAssignableFrom(type)
                || Thread.class.isAssignableFrom(type)
                || Path.class.isAssignableFrom(type)) {
                throw new AssertionError("unsafe health field " + field.getName());
            }
        });
    }

    private static void assertOwnerOnly(Path directory) throws Exception {
        assertEquals(
            PosixFilePermissions.fromString("rwx------"),
            Files.getPosixFilePermissions(directory, LinkOption.NOFOLLOW_LINKS),
            "store directory permissions"
        );
        try (java.util.stream.Stream<Path> paths = Files.list(directory)) {
            for (Path path : (Iterable<Path>) paths::iterator) {
                assertEquals(
                    PosixFilePermissions.fromString("rw-------"),
                    Files.getPosixFilePermissions(path, LinkOption.NOFOLLOW_LINKS),
                    "store file permissions"
                );
            }
        }
    }

    private static void assertNoDeliveryThreads() throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2L);
        while (deliveryThreadCount() > 0L && System.nanoTime() < deadline) {
            Thread.sleep(5L);
        }
        assertEquals(0L, deliveryThreadCount(), "delivery scheduler teardown");
    }

    private static long deliveryThreadCount() {
        return Thread.getAllStackTraces().keySet().stream()
            .filter(thread -> thread.isAlive() && "logbrew-delivery".equals(thread.getName()))
            .count();
    }

    private static void await(Check check, String label) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5L);
        while (!check.value() && System.nanoTime() < deadline) {
            Thread.sleep(5L);
        }
        assertTrue(check.value(), label);
    }

    private static String sha256(String value) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        try {
            return hex(digest);
        } finally {
            Arrays.fill(digest, (byte) 0);
        }
    }

    private static String hex(byte[] value) {
        StringBuilder result = new StringBuilder(value.length * 2);
        for (byte item : value) {
            result.append(String.format("%02x", Integer.valueOf(item & 0xff)));
        }
        return result.toString();
    }

    private static void assertEquals(Object expected, Object actual, String label) {
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new AssertionError(label + ": expected " + expected + ", got " + actual);
        }
    }

    private static void assertTrue(boolean value, String label) {
        if (!value) {
            throw new AssertionError(label);
        }
    }

    private static void assertContains(String value, String expected, String label) {
        if (!value.contains(expected)) {
            throw new AssertionError(label);
        }
    }

    private static void assertNotContains(String value, String forbidden, String label) {
        if (value.contains(forbidden)) {
            throw new AssertionError(label);
        }
    }

    private interface Check {
        boolean value();
    }

    private static final class Request {
        private final String method;
        private final String path;
        private final String authorization;
        private final String contentType;
        private final String source;
        private final String body;

        private Request(HttpExchange exchange, String body) {
            this.method = exchange.getRequestMethod();
            this.path = exchange.getRequestURI().getRawPath();
            this.authorization = exchange.getRequestHeaders().getFirst("authorization");
            this.contentType = exchange.getRequestHeaders().getFirst("content-type");
            this.source = exchange.getRequestHeaders().getFirst("x-logbrew-source");
            this.body = body;
        }
    }

    private static final class FakeIntake {
        private final Deque<Integer> statuses = new ArrayDeque<>(
            Arrays.asList(
                Integer.valueOf(202),
                Integer.valueOf(503),
                Integer.valueOf(202),
                Integer.valueOf(202),
                Integer.valueOf(401),
                Integer.valueOf(202)
            )
        );
        private final List<Request> requests = Collections.synchronizedList(new ArrayList<>());
        private final AtomicReference<Throwable> failure = new AtomicReference<>();
        private HttpServer server;

        void start() throws IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/v1/events", this::handle);
            server.start();
        }

        URI endpoint() {
            return URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/v1/events");
        }

        List<Request> requests() {
            Throwable error = failure.get();
            if (error != null) {
                throw new AssertionError("fake intake failed", error);
            }
            synchronized (requests) {
                return new ArrayList<>(requests);
            }
        }

        void stop() {
            if (server != null) {
                server.stop(0);
            }
        }

        private void handle(HttpExchange exchange) throws IOException {
            int status = 500;
            try {
                String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
                requests.add(new Request(exchange, body));
                synchronized (statuses) {
                    if (statuses.isEmpty()) {
                        throw new AssertionError("unexpected request");
                    }
                    status = statuses.removeFirst().intValue();
                }
            } catch (Throwable error) {
                failure.compareAndSet(null, error);
            } finally {
                byte[] response = "discarded-server-text".getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(status, response.length);
                exchange.getResponseBody().write(response);
                exchange.close();
            }
        }
    }
}
JAVA

javac -Xlint:all -Werror --release 11 -cp "$jar_path" -d "$app_dir/classes" "$app_dir/src/Main.java"
java -cp "$jar_path:$app_dir/classes" Main persist "$key_file" "$store_dir" "$package_version" > "$app_dir/writer.out"
preview_sha256="$(python3 - "$app_dir/writer.out" <<'PY'
import json
import re
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
if payload.get("phase") != "hard-exit" or payload.get("persistedEvents") != 1:
    raise SystemExit("unexpected writer proof")
digest = payload.get("previewSha256", "")
if re.fullmatch(r"[0-9a-f]{64}", digest) is None:
    raise SystemExit("invalid writer digest")
print(digest)
PY
)"

python3 - "$key_file" "$store_dir" <<'PY'
import sys
from pathlib import Path

key = Path(sys.argv[1]).read_bytes()
store = Path(sys.argv[2])
needles = [
    key,
    key.hex().encode("ascii"),
    b"LOGBREW_AUTOMATIC_PROOF_KEY",
    b"automatic-private-message",
    b"evt_java_auto_persisted",
    str(store).encode("utf-8"),
]
for path in store.iterdir():
    if not path.is_file():
        raise SystemExit("unexpected persistence entry")
    data = path.read_bytes()
    if any(needle and needle in data for needle in needles):
        raise SystemExit("automatic persistence privacy check failed")
PY

java -cp "$jar_path:$app_dir/classes" Main recover \
  "$key_file" "$store_dir" "$preview_sha256" "$package_version" > "$app_dir/reader.out"
python3 - "$app_dir/reader.out" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
expected = {
    "ok": True,
    "restartHydrated": 1,
    "requests": 6,
    "acceptedEvents": 3,
    "retryBodiesStable": True,
    "terminalBodyStable": True,
    "healthContentFree": True,
    "processExitClean": True,
}
if payload != expected:
    raise SystemExit("unexpected automatic delivery proof")
PY

jar_digest="$(shasum -a 256 "$jar_path" | awk '{print $1}')"
printf 'java automatic delivery installed-JAR proof passed (version=%s sha256=%s requests=6 accepted=3)\n' \
  "$package_version" "$jar_digest"
