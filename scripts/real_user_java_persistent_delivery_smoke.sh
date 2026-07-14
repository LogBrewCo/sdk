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
jar --create --file "$jar_path" -C "$tmp_dir/jar-stage" .

app_dir="$tmp_dir/installed-app"
store_dir="$app_dir/state"
key_file="$app_dir/persistence.key"
mkdir -p "$app_dir/src" "$app_dir/classes"
dd if=/dev/urandom of="$key_file" bs=32 count=1 status=none
chmod 600 "$key_file"

cat > "$app_dir/src/Main.java" <<'JAVA'
import co.logbrew.sdk.DeliveryOptions;
import co.logbrew.sdk.EncryptedEventStore;
import co.logbrew.sdk.LogAttributes;
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.PersistenceStatus;
import co.logbrew.sdk.SdkException;
import co.logbrew.sdk.Transport;
import co.logbrew.sdk.TransportResponse;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicInteger;

public final class Main {
    private static final int HIGH_VOLUME_EVENTS = 1500;
    private static final int BATCH_EVENTS = 500;
    private static final String API_KEY = "LOGBREW_INGEST_KEY";
    private static final String MESSAGE = "private-restart-message";

    private Main() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 3 || args.length > 4) {
            throw new IllegalArgumentException("mode, key file, store directory, and optional digest are required");
        }
        byte[] key = Files.readAllBytes(Path.of(args[1]));
        try {
            if ("write".equals(args[0])) {
                assertEquals(3, args.length, "write arguments");
                writeAndHalt(Path.of(args[2]), key);
            } else if ("recover".equals(args[0])) {
                assertEquals(4, args.length, "recover arguments");
                recoverAndDrain(Path.of(args[2]), key, args[3]);
            } else {
                throw new IllegalArgumentException("unsupported mode");
            }
        } finally {
            Arrays.fill(key, (byte) 0);
        }
    }

    private static void writeAndHalt(Path directory, byte[] key) {
        EncryptedEventStore store = EncryptedEventStore.open(directory, key);
        LogBrewClient client = client(store);
        assertEquals(0, client.recoverPersistedEvents().pendingEvents(), "initial recovery");
        for (int index = 0; index < HIGH_VOLUME_EVENTS; index++) {
            client.log(
                eventId(index),
                Instant.parse("2026-06-02T10:00:00Z").plusSeconds(index).toString(),
                LogAttributes.create(MESSAGE, "info")
            );
        }
        assertEquals(HIGH_VOLUME_EVENTS, client.persistenceStatus().pendingEvents(), "durable admission");
        String preview = client.previewJson();
        assertStableRecoveredIds(preview);
        System.out.println("{"
            + "\"phase\":\"hard-exit\","
            + "\"persistedEvents\":" + HIGH_VOLUME_EVENTS + ","
            + "\"previewSha256\":\"" + sha256(preview) + "\""
            + "}");
        System.out.flush();
        Runtime.getRuntime().halt(0);
    }

    private static void recoverAndDrain(Path directory, byte[] key, String expectedPreviewSha256) throws Exception {
        try (EncryptedEventStore store = EncryptedEventStore.open(directory, key)) {
            LogBrewClient client = client(store);
            PersistenceStatus recovered = client.recoverPersistedEvents();
            assertEquals(HIGH_VOLUME_EVENTS, recovered.pendingEvents(), "restart recovery");
            String recoveredPreview = client.previewJson();
            assertStableRecoveredIds(recoveredPreview);
            String recoveredPreviewSha256 = sha256(recoveredPreview);
            assertEquals(expectedPreviewSha256, recoveredPreviewSha256, "pre-halt and recovered bytes");
            assertOwnerOnly(directory);

            ScenarioTransport scenario = new ScenarioTransport(client);
            SdkException failure = expectSdkException(() -> client.flush(scenario));
            assertEquals("transport_error", failure.code(), "third-batch failure");
            assertEquals(5, scenario.calls.get(), "scripted request count");
            assertTrue(scenario.retryBodyStable, "byte-identical 503 to 202 retry");
            assertEquals(501, client.pendingEvents(), "accepted prefix and later retention");
            assertEquals(501, client.persistenceStatus().pendingEvents(), "durable retained suffix");

            AtomicInteger drainCalls = new AtomicInteger();
            TransportResponse drained = client.flush((apiKey, body) -> {
                drainCalls.incrementAndGet();
                return new TransportResponse(202, 1);
            });
            assertEquals(501, drained.acceptedEvents(), "drained retained events");
            assertEquals(2, drainCalls.get(), "bounded retained requests");
            assertEquals(0, client.persistenceStatus().pendingEvents(), "durable drain");
            client.shutdown((apiKey, body) -> new TransportResponse(202, 1));

            System.out.println("{"
                + "\"ok\":true,"
                + "\"hardExitRecovered\":" + recovered.pendingEvents() + ","
                + "\"retryBodiesStable\":true,"
                + "\"retainedAfterPrefixFailure\":501,"
                + "\"drainedEvents\":" + drained.acceptedEvents() + ","
                + "\"recoveredPreviewSha256\":\"" + recoveredPreviewSha256 + "\""
                + "}");
        }
    }

    private static LogBrewClient client(EncryptedEventStore store) {
        return LogBrewClient.create(
            API_KEY,
            "installed-restart-app",
            "0.1.0",
            DeliveryOptions.builder()
                .maxRetries(1)
                .maxQueueEvents(HIGH_VOLUME_EVENTS + 1)
                .maxQueueBytes(32L * 1024L * 1024L)
                .maxBatchEvents(BATCH_EVENTS)
                .maxBatchBytes(8 * 1024 * 1024)
                .encryptedEventStore(store)
                .build()
        );
    }

    private static String eventId(int index) {
        return String.format("evt_restart_%04d", Integer.valueOf(index));
    }

    private static void assertStableRecoveredIds(String preview) {
        int cursor = -1;
        for (int index = 0; index < HIGH_VOLUME_EVENTS; index++) {
            String eventId = "\"id\": \"" + eventId(index) + "\"";
            int position = preview.indexOf(eventId, cursor + 1);
            assertTrue(position > cursor, "stable recovered event ids and order");
            assertEquals(position, preview.lastIndexOf(eventId), "recovered event id uniqueness");
            cursor = position;
        }
    }

    private static String sha256(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(
                value.getBytes(StandardCharsets.UTF_8)
            );
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte item : digest) {
                hex.append(String.format("%02x", Integer.valueOf(item & 0xff)));
            }
            Arrays.fill(digest, (byte) 0);
            return hex.toString();
        } catch (java.security.NoSuchAlgorithmException error) {
            throw new AssertionError("SHA-256 is unavailable", error);
        }
    }

    private static void assertOwnerOnly(Path directory) throws Exception {
        assertEquals(
            PosixFilePermissions.fromString("rwx------"),
            Files.getPosixFilePermissions(directory, LinkOption.NOFOLLOW_LINKS),
            "store permissions"
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

    private static SdkException expectSdkException(Runnable callback) {
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

    private static void assertTrue(boolean value, String label) {
        if (!value) {
            throw new AssertionError(label);
        }
    }

    private static final class ScenarioTransport implements Transport {
        private final LogBrewClient client;
        private final AtomicInteger calls = new AtomicInteger();
        private String firstBody;
        private boolean retryBodyStable;

        private ScenarioTransport(LogBrewClient client) {
            this.client = client;
        }

        @Override
        public TransportResponse send(String apiKey, String body) {
            int call = calls.incrementAndGet();
            if (call == 1) {
                firstBody = body;
                assertTrue(body.contains("evt_restart_0000"), "oldest recovered event first");
                return new TransportResponse(503, 1);
            }
            if (call == 2) {
                retryBodyStable = firstBody.equals(body);
                return new TransportResponse(202, 1);
            }
            if (call == 3) {
                assertTrue(body.contains("evt_restart_0500"), "second recovered prefix");
                client.log(
                    "evt_restart_later",
                    "2026-06-03T10:00:00Z",
                    LogAttributes.create("later", "info")
                );
                return new TransportResponse(202, 1);
            }
            if (call == 4) {
                assertTrue(body.contains("evt_restart_1000"), "failed suffix starts oldest first");
                assertTrue(!body.contains("evt_restart_later"), "later event excluded from active snapshot");
                return new TransportResponse(503, 1);
            }
            return new TransportResponse(400, 1);
        }
    }
}
JAVA

javac -Xlint:all -Werror --release 11 -cp "$jar_path" -d "$app_dir/classes" "$app_dir/src/Main.java"
java -cp "$jar_path:$app_dir/classes" Main write "$key_file" "$store_dir" > "$app_dir/writer.out"
preview_sha256="$(python3 - "$app_dir/writer.out" <<'PY'
import json
import re
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
if payload.get("phase") != "hard-exit" or payload.get("persistedEvents") != 1500:
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
    b"LOGBREW_INGEST_KEY",
    b"private-restart-message",
    b"evt_restart_0000",
]
for path in store.iterdir():
    if not path.is_file():
        raise SystemExit("unexpected persistence entry")
    data = path.read_bytes()
    if any(needle and needle in data for needle in needles):
        raise SystemExit("persistence privacy check failed")
PY

java -cp "$jar_path:$app_dir/classes" Main recover "$key_file" "$store_dir" "$preview_sha256" > "$app_dir/reader.out"
python3 - "$app_dir/reader.out" "$preview_sha256" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
expected = {
    "ok": True,
    "hardExitRecovered": 1500,
    "retryBodiesStable": True,
    "retainedAfterPrefixFailure": 501,
    "drainedEvents": 501,
    "recoveredPreviewSha256": sys.argv[2],
}
if payload != expected:
    raise SystemExit("unexpected recovery proof")
PY

printf '%s\n' 'java encrypted restart installed-Transport proof passed (recovered=1500 retained=501 drained=501)'
