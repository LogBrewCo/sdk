import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.RecordingTransport;
import co.logbrew.sdk.SdkException;
import co.logbrew.sdk.TransportException;
import co.logbrew.sdk.TransportResponse;

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
                + ",\"events\":6}"
        );
    }
}
