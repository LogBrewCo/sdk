import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.RecordingTransport;
import co.logbrew.sdk.SdkException;
import co.logbrew.sdk.SupportTicketDraft;
import co.logbrew.sdk.TransportException;
import co.logbrew.sdk.TransportResponse;
import java.util.Map;

public final class RealUserSmoke {
    private RealUserSmoke() {
    }

    public static void main(String[] args) {
        LogBrewClient client = LogBrewClient.create("LOGBREW_API_KEY", "logbrew-java", "0.1.0");
        ReadmeExample.enqueueAll(client);

        System.out.println(client.previewJson());
        TransportResponse response = client.shutdown(RecordingTransport.alwaysAccept());

        LogBrewClient retryClient = LogBrewClient.create("LOGBREW_API_KEY", "logbrew-java", "0.1.0");
        ReadmeExample.enqueueAll(retryClient);
        TransportResponse retryResponse = retryClient.flush(RecordingTransport.scripted(
            TransportException.network("temporary outage"),
            Integer.valueOf(202)
        ));
        SupportTicketDraft supportDraft = SupportTicketDraft.create(SupportTicketDraft.Input
            .create("sdk", "ingest_failure", "Telemetry flush failed", "Flush returned usage_limit_exceeded")
            .runtime("java 21")
            .sdkPackage("co.logbrew:logbrew-sdk")
            .sdkVersion("0.1.0")
            .traceId("4BF92F3577B34DA6A3CE929D0E0E4736")
            .diagnostics(Map.of(
                "apiKey", "lbw_ingest_hidden",
                "endpoint", "https://api.example/ingest?debug=true"
            )));
        String supportDraftJson = supportDraft.toJson();
        boolean supportDraftRedacted = supportDraftJson.contains("[redacted]")
            && supportDraftJson.contains("[redacted-url]/ingest")
            && !supportDraftJson.contains("hidden")
            && !supportDraftJson.contains("api.example")
            && supportDraft.traceId().equals("4bf92f3577b34da6a3ce929d0e0e4736");

        boolean rejectedAfterShutdown = false;
        try {
            client.action(
                "evt_action_002",
                "2026-06-02T10:00:06Z",
                co.logbrew.sdk.ActionAttributes.create("deploy", "success")
            );
        } catch (SdkException error) {
            rejectedAfterShutdown = "shutdown_error".equals(error.code());
        }

        System.err.println(
            "{\"ok\":"
                + rejectedAfterShutdown
                + ",\"status\":"
                + response.statusCode()
                + ",\"attempts\":"
                + response.attempts()
                + ",\"retryAttempts\":"
                + retryResponse.attempts()
                + ",\"supportDraftRedacted\":"
                + supportDraftRedacted
                + ",\"events\":6}"
        );
    }
}
