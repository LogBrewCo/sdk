import co.logbrew.sdk.DeliveryOptions;
import co.logbrew.sdk.EncryptedEventStore;
import co.logbrew.sdk.LogAttributes;
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.RecordingTransport;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Base64;

public final class EncryptedRestartDelivery {
    private EncryptedRestartDelivery() {
    }

    public static void main(String[] args) {
        byte[] key = Base64.getDecoder().decode(required("LOGBREW_PERSISTENCE_KEY_BASE64"));
        try (EncryptedEventStore store = EncryptedEventStore.open(
            Path.of(required("LOGBREW_PERSISTENCE_DIRECTORY")),
            key
        )) {
            LogBrewClient client = LogBrewClient.create(
                "LOGBREW_INGEST_KEY",
                "checkout-api",
                "1.0.0",
                DeliveryOptions.builder().encryptedEventStore(store).build()
            );

            client.recoverPersistedEvents();
            client.log(
                "evt_restart_delivery_001",
                "2026-06-02T10:00:03Z",
                LogAttributes.create("worker started", "info")
            );
            client.shutdown(RecordingTransport.alwaysAccept());
        } finally {
            Arrays.fill(key, (byte) 0);
        }
    }

    private static String required(String name) {
        String value = System.getenv(name);
        if (value == null || value.isEmpty()) {
            throw new IllegalArgumentException(name + " is required");
        }
        return value;
    }
}
