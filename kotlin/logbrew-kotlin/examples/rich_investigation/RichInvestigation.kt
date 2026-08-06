import co.logbrew.sdk.IssueAttributes
import co.logbrew.sdk.IssueBreadcrumb
import co.logbrew.sdk.IssueBreadcrumbLevel
import co.logbrew.sdk.LogBrewClient
import co.logbrew.sdk.LogBrewTelemetry
import co.logbrew.sdk.LogBrewTrace
import co.logbrew.sdk.SpanAttributes
import co.logbrew.sdk.SpanLinkSummary
import co.logbrew.sdk.TelemetryContext
import co.logbrew.sdk.TelemetryDeployment
import co.logbrew.sdk.TelemetryNamedVersion
import co.logbrew.sdk.TelemetryResource
import co.logbrew.sdk.TelemetrySessionContext
import co.logbrew.sdk.TelemetrySubjectContext
import co.logbrew.sdk.TelemetrySubjectKind

private const val TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
private const val PARENT_SPAN_ID = "00f067aa0ba902b7"
private const val LINKED_SPAN_ID = "7a085853722dc6d2"

fun main() {
    val client =
        LogBrewClient.create(
            apiKey = "LOGBREW_API_KEY",
            sdkName = "checkout-android",
            sdkVersion = "0.2.0",
            context =
                TelemetryContext(
                    resource =
                        TelemetryResource(
                            service = TelemetryNamedVersion("checkout", "2.4.0"),
                            deployment = TelemetryDeployment(environment = "production", release = "2026.08.06"),
                        ),
                    tags = mapOf("region" to "eu"),
                ),
            includeAutomaticContext = false,
        )
    client.addBreadcrumb(
        IssueBreadcrumb(
            timestamp = "2026-08-06T12:00:00Z",
            category = "navigation",
            type = "screen",
            level = IssueBreadcrumbLevel.INFO,
            message = "Checkout opened",
            data = mapOf("screen" to "Checkout"),
        ),
    )
    val trace = LogBrewTrace.continueOrCreate("00-$TRACE_ID-$PARENT_SPAN_ID-01")
    val session = TelemetryContext(session = TelemetrySessionContext("session-safe-7"))

    LogBrewTelemetry.withContext(session) {
        LogBrewTrace.withTrace(trace) {
            client.issue(
                id = "evt_issue_rich_001",
                timestamp = "2026-08-06T12:00:01Z",
                attributes =
                    IssueAttributes
                        .fromThrowable(
                            throwable = IllegalStateException("private checkout detail"),
                            mechanismType = "kotlin.exception",
                            handled = true,
                        ).withContext(
                            TelemetryContext(
                                subject = TelemetrySubjectContext("opaque-user-7", TelemetrySubjectKind.USER),
                            ),
                        ),
            )
            client.span(
                id = "evt_span_linked_001",
                timestamp = "2026-08-06T12:00:02Z",
                attributes =
                    SpanAttributes
                        .create("queue.consume", trace.traceId, trace.spanId, "error")
                        .withLink(
                            SpanLinkSummary(
                                traceId = TRACE_ID,
                                spanId = LINKED_SPAN_ID,
                                sampled = true,
                                metadata = mapOf("relation" to "batch.parent"),
                            ),
                        ),
            )
        }
    }

    val preview = client.previewJson()
    check("private checkout detail" !in preview)
    println(preview)
    System.err.println("{\"richIssueEvents\":1,\"linkedSpanEvents\":1,\"privateThrowableTextOmitted\":true}")
}
