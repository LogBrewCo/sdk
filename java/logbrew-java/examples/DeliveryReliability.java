import co.logbrew.sdk.DeliveryOptions;
import co.logbrew.sdk.LogAttributes;
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.RecordingTransport;
import co.logbrew.sdk.TransportResponse;

public final class DeliveryReliability {
    private DeliveryReliability() {
    }

    public static void main(String[] args) {
        DeliveryOptions options = DeliveryOptions.builder()
            .maxRetries(2)
            .maxQueueEvents(2_000)
            .maxQueueBytes(8L * 1024L * 1024L)
            .maxBatchEvents(100)
            .maxBatchBytes(512 * 1024)
            .onEventDropped(drop -> System.err.println(
                "dropped=" + drop.reason() + " bytes=" + drop.serializedBytes()))
            .build();
        LogBrewClient client = LogBrewClient.create(
            "LOGBREW_INGEST_KEY",
            "checkout-api",
            "1.0.0",
            options
        );

        client.log(
            "evt_log_delivery_001",
            "2026-06-02T10:00:03Z",
            LogAttributes.create("worker started", "info")
        );
        TransportResponse response = client.flush(RecordingTransport.alwaysAccept());

        System.err.println(
            "status=" + response.statusCode()
                + " batches=" + response.batches()
                + " acceptedEvents=" + response.acceptedEvents()
                + " pendingEvents=" + client.pendingEvents()
                + " pendingEventBytes=" + client.pendingEventBytes()
        );
    }
}
