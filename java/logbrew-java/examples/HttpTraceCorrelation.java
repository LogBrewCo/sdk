import co.logbrew.sdk.IssueAttributes;
import co.logbrew.sdk.LogBrewClient;
import co.logbrew.sdk.LogBrewHttpRequestTelemetry;
import co.logbrew.sdk.LogBrewJulHandler;
import co.logbrew.sdk.LogBrewTrace;
import co.logbrew.sdk.LogBrewTraceContext;
import co.logbrew.sdk.RecordingTransport;
import co.logbrew.sdk.TransportResponse;
import java.time.Instant;
import java.util.Collections;
import java.util.logging.Level;
import java.util.logging.LogRecord;

public final class HttpTraceCorrelation {
    private static final String TRACEPARENT =
        "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01";
    private static final String CHILD_SPAN_ID = "b7ad6b7169203331";

    private HttpTraceCorrelation() {
    }

    public static void main(String[] args) {
        LogBrewClient client = LogBrewClient.create("LOGBREW_API_KEY", "checkout-java-service", "0.1.0");
        LogBrewTraceContext trace = LogBrewTraceContext.fromTraceparent(TRACEPARENT, CHILD_SPAN_ID);
        LogBrewHttpRequestTelemetry request = LogBrewHttpRequestTelemetry.start(
            client,
            "POST",
            "https://shop.example/checkout/{cart_id}?cart=private#review",
            trace,
            Collections.singletonMap("service", "checkout-api")
        );

        LogBrewTrace.Scope scope = request.activate();
        try {
            LogRecord record = new LogRecord(Level.WARNING, "checkout handler saw a slow payment response");
            record.setInstant(Instant.parse("2026-06-02T10:00:02Z"));
            record.setLoggerName("checkout.http");
            record.setSequenceNumber(101L);
            client.log(
                LogBrewJulHandler.defaultEventId(record),
                LogBrewJulHandler.timestampFromRecord(record),
                LogBrewJulHandler.logAttributesFromRecord(record)
            );
            client.issue(
                "evt_issue_checkout_request",
                "2026-06-02T10:00:03Z",
                IssueAttributes.create("Checkout returned a server error", "error")
                    .message("handler returned 502")
                    .metadata(LogBrewTrace.metadataWithCurrentTrace(Collections.singletonMap("stage", "handler")))
            );
        } finally {
            scope.close();
        }

        request.finishSpanAndMetric(
            "evt_span_checkout_request",
            "evt_metric_checkout_request_duration",
            "2026-06-02T10:00:04Z",
            502,
            183.4
        );

        System.out.println(client.previewJson());
        TransportResponse response = client.shutdown(RecordingTransport.alwaysAccept());
        System.err.println(
            "{\"ok\":true,\"status\":"
                + response.statusCode()
                + ",\"attempts\":"
                + response.attempts()
                + ",\"events\":4,\"outgoingTraceparent\":\""
                + request.outgoingHeaders().get("traceparent")
                + "\"}"
        );
    }
}
