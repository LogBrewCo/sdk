using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using LogBrew;
using Microsoft.Extensions.Logging;

static void AssertTrue(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException(message);
    }
}

static SdkException ExpectSdkError(string code, string messageFragment, Action callback)
{
    try
    {
        callback();
    }
    catch (SdkException error)
    {
        AssertTrue(error.Code == code, "expected " + code + " but got " + error.Code);
        AssertTrue(error.Message.Contains(messageFragment, StringComparison.Ordinal), "expected error containing " + messageFragment);
        return error;
    }

    throw new InvalidOperationException("expected SdkException with code " + code);
}

static void ExpectArgumentNullContract(string parameterName, Action callback)
{
    try
    {
        callback();
    }
    catch (ArgumentNullException error)
    {
        var expected = new ArgumentNullException(parameterName);
        AssertTrue(error.GetType() == typeof(ArgumentNullException), "expected exact ArgumentNullException type");
        AssertTrue(error.ParamName == expected.ParamName, "unexpected ArgumentNullException parameter name");
        AssertTrue(error.Message == expected.Message, "unexpected ArgumentNullException message");
        return;
    }

    throw new InvalidOperationException("expected ArgumentNullException for " + parameterName);
}

static void ExpectObjectDisposedContract(string objectName, Action callback)
{
    try
    {
        callback();
    }
    catch (ObjectDisposedException error)
    {
        var expected = new ObjectDisposedException(objectName);
        AssertTrue(error.GetType() == typeof(ObjectDisposedException), "expected exact ObjectDisposedException type");
        AssertTrue(error.ObjectName == expected.ObjectName, "unexpected ObjectDisposedException object name");
        AssertTrue(error.Message == expected.Message, "unexpected ObjectDisposedException message");
        return;
    }

    throw new InvalidOperationException("expected ObjectDisposedException for " + objectName);
}

static LogBrewClient SampleClient(int maxRetries = 2)
{
    return LogBrewClient.Create("LOGBREW_API_KEY", "logbrew-dotnet", "0.1.0", maxRetries);
}

static void CreateAndDisposeHttpTransport(HttpTransportOptions options)
{
    using var transport = new HttpTransport(options);
    AssertTrue(transport.Endpoint != null, "expected HTTP transport endpoint");
}

static void EnqueueAll(LogBrewClient client)
{
    client.Release("evt_release_001", "2026-06-02T10:00:00Z", ReleaseAttributes.Create("1.2.3").WithCommit("abc123def456").WithNotes("Public release marker"));
    client.Environment("evt_environment_001", "2026-06-02T10:00:01Z", EnvironmentAttributes.Create("production").WithRegion("global"));
    client.Issue("evt_issue_001", "2026-06-02T10:00:02Z", IssueAttributes.Create("Checkout timeout", "error").WithMessage("Request timed out after retry budget"));
    client.Log("evt_log_001", "2026-06-02T10:00:03Z", LogAttributes.Create("worker started", "info").WithLogger("job-runner"));
    client.Span("evt_span_001", "2026-06-02T10:00:04Z", SpanAttributes.Create("GET /health", "trace_001", "span_001", "ok").WithDurationMs(12.5));
    client.Action("evt_action_001", "2026-06-02T10:00:05Z", ActionAttributes.Create("deploy", "success"));
}

static int CountOccurrences(string text, string value)
{
    var count = 0;
    var index = 0;
    while ((index = text.IndexOf(value, index, StringComparison.Ordinal)) >= 0)
    {
        count++;
        index += value.Length;
    }

    return count;
}

var tests = 0;

ExpectArgumentNullContract("client", () => LogBrewActivitySourceListener.Start(null!));
ExpectArgumentNullContract("client", () => LogBrewActivitySpanTelemetry.Capture(null!, null));
ExpectArgumentNullContract("parent", () => LogBrewTraceContext.CreateChild(null!));
ExpectArgumentNullContract("context", () => LogBrewTrace.Activate(null!));
ExpectArgumentNullContract("summaries", () => SpanAttributes.Create("GET /", "trace_001", "span_001", "ok").WithEvents(null!));
ExpectArgumentNullContract("summaries", () => SpanAttributes.Create("GET /", "trace_001", "span_001", "ok").WithLinks(null!));
ExpectArgumentNullContract("summary", () => SpanAttributes.Create("GET /", "trace_001", "span_001", "ok").WithLink(null!));
ExpectArgumentNullContract("summary", () => SpanAttributes.Create("GET /", "trace_001", "span_001", "ok").WithEvent(null!));
ExpectArgumentNullContract("metadata", () => SpanEventSummary.Create("event").WithMetadata(null!));
ExpectArgumentNullContract("client", () => LogBrewDbCommandTelemetry.ExecuteNonQuery(null!, null!));
ExpectArgumentNullContract("command", () => LogBrewDbCommandTelemetry.ExecuteNonQuery(SampleClient(), null!));
ExpectArgumentNullContract("client", () => LogBrewOperationTracing.DatabaseOperation<int>(null!, "select", () => 1));
ExpectArgumentNullContract("operation", () => LogBrewOperationTracing.DatabaseOperation<int>(SampleClient(), "select", null!));
ExpectArgumentNullContract("client", () => LogBrewOperationTracing.DatabaseOperationAsync<int>(null!, "select", () => Task.FromResult(1)).GetAwaiter().GetResult());
ExpectArgumentNullContract("operation", () => LogBrewOperationTracing.DatabaseOperationAsync<int>(SampleClient(), "select", null!).GetAwaiter().GetResult());
ExpectArgumentNullContract("builder", () => LogBrewLoggingBuilderExtensions.AddLogBrew(null!, SampleClient()));
using (var provider = new LogBrewLoggerProvider(SampleClient()))
{
    var logger = provider.CreateLogger("contract");
    var logState = new object();
    ExpectArgumentNullContract("formatter", () => logger.Log<object>(LogLevel.Information, default, logState, null, null!));
    provider.Dispose();
    ExpectObjectDisposedContract(nameof(LogBrewLoggerProvider), () => provider.CreateLogger("closed"));
}

ExpectArgumentNullContract("client", () => LogBrewServerRequestTelemetry.CaptureAsync(null!, "GET", "/", null, _ => Task.FromResult(200)).GetAwaiter().GetResult());
ExpectArgumentNullContract("handler", () => LogBrewServerRequestTelemetry.CaptureAsync(SampleClient(), "GET", "/", null, null!).GetAwaiter().GetResult());
tests++;

var previewClient = SampleClient();
EnqueueAll(previewClient);
var preview = previewClient.PreviewJson();
var releaseIndex = preview.IndexOf("\"type\": \"release\"", StringComparison.Ordinal);
var actionIndex = preview.IndexOf("\"type\": \"action\"", StringComparison.Ordinal);
AssertTrue(releaseIndex >= 0 && actionIndex > releaseIndex, "expected ordered event preview");
tests++;

var flushClient = SampleClient();
EnqueueAll(flushClient);
var transport = RecordingTransport.AlwaysAccept();
var response = flushClient.Flush(transport);
AssertTrue(response.StatusCode == 202, "expected successful flush status");
AssertTrue(response.Attempts == 1, "expected one attempt");
AssertTrue(flushClient.PendingEvents() == 0, "expected queue to clear");
AssertTrue(transport.LastBody != null && transport.LastBody.Contains("\"events\"", StringComparison.Ordinal), "expected transport body");
tests++;

var emptyResponse = SampleClient().Flush(RecordingTransport.AlwaysAccept());
AssertTrue(emptyResponse.StatusCode == 204 && emptyResponse.Attempts == 0, "expected empty flush no-op");
tests++;

ExpectSdkError("validation_error", "timestamp must include a timezone offset", () =>
    SampleClient().Log("evt_log_001", "2026-06-02T10:00:03", LogAttributes.Create("worker started", "info")));
tests++;

ExpectSdkError("validation_error", "issue level must be one of", () =>
    SampleClient().Issue("evt_issue_001", "2026-06-02T10:00:02Z", IssueAttributes.Create("Checkout timeout", "verbose")));
tests++;

var severityClient = SampleClient();
severityClient.Issue("evt_issue_alias", "2026-06-02T10:00:02Z", IssueAttributes.Create("Checkout timeout", "fatal"));
severityClient.Log("evt_log_debug", "2026-06-02T10:00:03Z", LogAttributes.Create("verbose runtime detail", "debug"));
severityClient.Log("evt_log_warn", "2026-06-02T10:00:04Z", LogAttributes.Create("legacy warning alias", "warn"));
var severityPreview = severityClient.PreviewJson();
AssertTrue(severityPreview.Contains("\"level\": \"critical\"", StringComparison.Ordinal), "expected fatal alias to normalize");
AssertTrue(severityPreview.Contains("\"level\": \"info\"", StringComparison.Ordinal), "expected debug alias to normalize");
AssertTrue(severityPreview.Contains("\"level\": \"warning\"", StringComparison.Ordinal), "expected warn alias to normalize");
tests++;

ExpectSdkError("validation_error", "span durationMs must be non-negative", () =>
    SampleClient().Span("evt_span_001", "2026-06-02T10:00:04Z", SpanAttributes.Create("GET /health", "trace_001", "span_001", "ok").WithDurationMs(-1)));
tests++;

var spanEventClient = SampleClient();
spanEventClient.Span(
    "evt_span_event_summary",
    "2026-06-02T10:00:04Z",
    SpanAttributes.Create("GET /health", "trace_001", "span_001", "ok")
        .WithEvent(SpanEventSummary.Create("retry")
            .WithTimestamp("2026-06-02T10:00:04Z")
            .WithMetadata(new Dictionary<string, object?> { ["attempt"] = 2, ["retryable"] = true })));
var spanEventPreview = spanEventClient.PreviewJson();
AssertTrue(spanEventPreview.Contains("\"events\"", StringComparison.Ordinal), "expected span events array");
AssertTrue(spanEventPreview.Contains("\"name\": \"retry\"", StringComparison.Ordinal), "expected span event name");
AssertTrue(spanEventPreview.Contains("\"attempt\": 2", StringComparison.Ordinal), "expected span event metadata");
AssertTrue(spanEventPreview.Contains("\"retryable\": true", StringComparison.Ordinal), "expected span event bool metadata");
var spanLinkClient = SampleClient();
spanLinkClient.Span(
    "evt_span_link_summary",
    "2026-06-02T10:00:04Z",
    SpanAttributes.Create("queue process", "trace_001", "span_001", "ok")
        .WithLink(SpanLinkSummary.FromTraceparent("00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00")
            .WithMetadata(new Dictionary<string, object?> { ["relation"] = "message", ["attempt"] = 1 })));
var spanLinkPreview = spanLinkClient.PreviewJson();
AssertTrue(spanLinkPreview.Contains("\"links\"", StringComparison.Ordinal), "expected span links array");
AssertTrue(spanLinkPreview.Contains("\"traceId\": \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"", StringComparison.Ordinal), "expected linked trace id");
AssertTrue(spanLinkPreview.Contains("\"spanId\": \"bbbbbbbbbbbbbbbb\"", StringComparison.Ordinal), "expected linked span id");
AssertTrue(spanLinkPreview.Contains("\"sampled\": false", StringComparison.Ordinal), "expected linked sampled flag");
AssertTrue(spanLinkPreview.Contains("\"relation\": \"message\"", StringComparison.Ordinal), "expected linked metadata");
ExpectSdkError("validation_error", "span event summaries must contain at most 8 entries", () =>
{
    var summaries = new List<SpanEventSummary>();
    for (var index = 0; index < 9; index++)
    {
        summaries.Add(SpanEventSummary.Create("event_" + index.ToString(CultureInfo.InvariantCulture)));
    }

    SpanAttributes.Create("GET /health", "trace_001", "span_001", "ok").WithEvents(summaries);
});
ExpectSdkError("validation_error", "span event metadata value for nested must be a string", () =>
    SpanEventSummary.Create("retry").WithMetadata(new Dictionary<string, object?> { ["nested"] = new object() }));
ExpectSdkError("validation_error", "span link summaries must contain at most 8 entries", () =>
{
    var summaries = new List<SpanLinkSummary>();
    for (var index = 0; index < 9; index++)
    {
        summaries.Add(SpanLinkSummary.FromTraceparent("00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-" + (index + 1).ToString("x16", CultureInfo.InvariantCulture) + "-01"));
    }

    SpanAttributes.Create("queue process", "trace_001", "span_001", "ok").WithLinks(summaries);
});
ExpectSdkError("validation_error", "span link metadata value for nested must be a string", () =>
    SpanLinkSummary.FromTraceparent("00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01")
        .WithMetadata(new Dictionary<string, object?> { ["nested"] = new object() }));
ExpectSdkError("validation_error", "timestamp must include a timezone offset", () =>
    SampleClient().Span(
        "evt_span_bad_event_timestamp",
        "2026-06-02T10:00:04Z",
        SpanAttributes.Create("GET /health", "trace_001", "span_001", "ok")
            .WithEvent(SpanEventSummary.Create("retry").WithTimestamp("2026-06-02T10:00:04"))));
tests++;

var incomingTraceparent = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01";
var traceContext = Traceparent.Parse(incomingTraceparent);
AssertTrue(traceContext.Version == "00", "expected traceparent version");
AssertTrue(traceContext.TraceId == "4bf92f3577b34da6a3ce929d0e0e4736", "expected normalized trace id");
AssertTrue(traceContext.ParentSpanId == "00f067aa0ba902b7", "expected normalized parent span id");
AssertTrue(traceContext.TraceFlags == "01", "expected normalized trace flags");
AssertTrue(traceContext.Sampled, "expected sampled traceparent");
var createdTraceparent = Traceparent.Create(traceContext.TraceId, "B7AD6B7169203331", traceContext.TraceFlags);
AssertTrue(createdTraceparent == "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01", "expected created traceparent");
var traceHeaders = Traceparent.CreateHeaders(traceContext.TraceId, "b7ad6b7169203331");
AssertTrue(traceHeaders["traceparent"] == createdTraceparent, "expected traceparent header");
var traceparentClient = SampleClient();
traceparentClient.Span(
    "evt_traceparent_span",
    "2026-06-02T10:00:04Z",
    Traceparent.SpanAttributesFromTraceparent(
        incomingTraceparent,
        TraceparentSpanInput.Create("POST /checkout/:cart_id", "b7ad6b7169203331", "ok")
            .WithDurationMs(183.4)
            .WithMetadata(new Dictionary<string, object?>
            {
                ["routeTemplate"] = "/checkout/:cart_id",
                ["sampled"] = traceContext.Sampled
            })));
var traceparentPreview = traceparentClient.PreviewJson();
AssertTrue(traceparentPreview.Contains("\"traceId\": \"4bf92f3577b34da6a3ce929d0e0e4736\"", StringComparison.Ordinal), "expected traceparent trace id");
AssertTrue(traceparentPreview.Contains("\"spanId\": \"b7ad6b7169203331\"", StringComparison.Ordinal), "expected traceparent child span id");
AssertTrue(traceparentPreview.Contains("\"parentSpanId\": \"00f067aa0ba902b7\"", StringComparison.Ordinal), "expected traceparent parent span id");
AssertTrue(traceparentPreview.Contains("\"durationMs\": 183.4", StringComparison.Ordinal), "expected traceparent duration");
AssertTrue(traceparentPreview.Contains("\"sampled\": true", StringComparison.Ordinal), "expected traceparent sampled metadata");
ExpectSdkError("validation_error", "traceparent version ff is forbidden", () =>
    Traceparent.Parse("ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"));
ExpectSdkError("validation_error", "traceparent traceId must not be all zeros", () =>
    Traceparent.Parse("00-00000000000000000000000000000000-00f067aa0ba902b7-01"));
ExpectSdkError("validation_error", "traceparent parent span id must not be all zeros", () =>
    Traceparent.Parse("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01"));
ExpectSdkError("validation_error", "spanId must be 16 hex characters", () =>
    Traceparent.Create(traceContext.TraceId, "bad"));
ExpectSdkError("validation_error", "metadata value for nested must be a string, number, boolean, or null", () =>
    TraceparentSpanInput.Create("POST /checkout/:cart_id", "b7ad6b7169203331", "ok")
        .WithMetadata(new Dictionary<string, object?> { ["nested"] = new object() }));
tests++;

var metricClient = SampleClient();
metricClient.Metric(
    "evt_metric_001",
    "2026-06-02T10:00:06Z",
    MetricAttributes.Create("queue.depth", "gauge", -2.0, "{items}", "instant")
        .WithMetadata(new Dictionary<string, object?> { ["service"] = "worker", ["queue"] = "default" }));
var metricPreview = metricClient.PreviewJson();
AssertTrue(metricClient.PendingEvents() == 1, "expected metric to queue one event");
AssertTrue(metricPreview.Contains("\"type\": \"metric\"", StringComparison.Ordinal), "expected metric event type");
AssertTrue(metricPreview.Contains("\"name\": \"queue.depth\"", StringComparison.Ordinal), "expected metric name");
AssertTrue(metricPreview.Contains("\"kind\": \"gauge\"", StringComparison.Ordinal), "expected metric kind");
AssertTrue(metricPreview.Contains("\"value\": -2", StringComparison.Ordinal), "expected gauge value");
AssertTrue(metricPreview.Contains("\"unit\": \"{items}\"", StringComparison.Ordinal), "expected metric unit");
AssertTrue(metricPreview.Contains("\"temporality\": \"instant\"", StringComparison.Ordinal), "expected metric temporality");
AssertTrue(metricPreview.Contains("\"service\": \"worker\"", StringComparison.Ordinal), "expected metric metadata");
AssertTrue(metricPreview.Contains("\"queue\": \"default\"", StringComparison.Ordinal), "expected metric metadata label");
tests++;

ExpectSdkError("validation_error", "metric value must be a finite number", () =>
    SampleClient().Metric("evt_metric_001", "2026-06-02T10:00:06Z", MetricAttributes.Create("queue.depth", "gauge", double.NaN, "{items}", "instant")));
ExpectSdkError("validation_error", "metric counter value must be non-negative", () =>
    SampleClient().Metric("evt_metric_001", "2026-06-02T10:00:06Z", MetricAttributes.Create("jobs.completed", "counter", -1.0, "1", "delta")));
ExpectSdkError("validation_error", "metric temporality for gauge must be one of", () =>
    SampleClient().Metric("evt_metric_001", "2026-06-02T10:00:06Z", MetricAttributes.Create("queue.depth", "gauge", 2.0, "{items}", "delta")));
tests++;

var productTimelineMetadata = new Dictionary<string, object?>
{
    ["cartTier"] = "gold",
    ["attempt"] = 2,
    ["routeTemplate"] = "/raw?debug=sample"
};
var productTimelineClient = SampleClient();
productTimelineClient.Action(
    "evt_product_timeline",
    "2026-06-02T10:00:05Z",
    ProductTimeline.ProductAction("checkout.submit")
        .WithRouteTemplate("https://shop.example/checkout/:step?cart=sample#review")
        .WithSessionId("session_123")
        .WithTraceId("trace_abc")
        .WithScreen("Checkout")
        .WithFunnel("checkout")
        .WithStep("submit")
        .WithMetadata(productTimelineMetadata)
        .ToActionAttributes());
productTimelineMetadata["cartTier"] = "platinum";
var productTimelinePreview = productTimelineClient.PreviewJson();
AssertTrue(productTimelineClient.PendingEvents() == 1, "expected product timeline event");
AssertTrue(productTimelinePreview.Contains("\"name\": \"checkout.submit\"", StringComparison.Ordinal), "expected product action name");
AssertTrue(productTimelinePreview.Contains("\"status\": \"success\"", StringComparison.Ordinal), "expected product action status");
AssertTrue(productTimelinePreview.Contains("\"source\": \"product_timeline\"", StringComparison.Ordinal), "expected product timeline source");
AssertTrue(productTimelinePreview.Contains("\"routeTemplate\": \"/checkout/:step\"", StringComparison.Ordinal), "expected sanitized product route template");
AssertTrue(productTimelinePreview.Contains("\"sessionId\": \"session_123\"", StringComparison.Ordinal), "expected product session id");
AssertTrue(productTimelinePreview.Contains("\"traceId\": \"trace_abc\"", StringComparison.Ordinal), "expected product trace id");
AssertTrue(productTimelinePreview.Contains("\"screen\": \"Checkout\"", StringComparison.Ordinal), "expected product screen");
AssertTrue(productTimelinePreview.Contains("\"funnel\": \"checkout\"", StringComparison.Ordinal), "expected product funnel");
AssertTrue(productTimelinePreview.Contains("\"step\": \"submit\"", StringComparison.Ordinal), "expected product step");
AssertTrue(productTimelinePreview.Contains("\"cartTier\": \"gold\"", StringComparison.Ordinal), "expected product metadata copy");
AssertTrue(productTimelinePreview.Contains("\"attempt\": 2", StringComparison.Ordinal), "expected product primitive metadata");
AssertTrue(!productTimelinePreview.Contains("cart=sample", StringComparison.Ordinal), "expected product query text to be omitted");
AssertTrue(!productTimelinePreview.Contains("debug=sample", StringComparison.Ordinal), "expected product metadata route override");
AssertTrue(!productTimelinePreview.Contains("platinum", StringComparison.Ordinal), "expected product metadata to be copied");
tests++;

var networkTimelineClient = SampleClient();
networkTimelineClient.Action(
    "evt_network_timeline",
    "2026-06-02T10:00:06Z",
    ProductTimeline.NetworkMilestone("https://api.example/v1/payments/:id?debug=sample#fragment")
        .WithMethod("post")
        .WithStatusCode(503)
        .WithDurationMs(183.4)
        .WithSessionId("session_123")
        .WithTraceId("trace_abc")
        .WithMetadata(new Dictionary<string, object?> { ["api"] = "payments" })
        .ToActionAttributes());
networkTimelineClient.Action(
    "evt_network_timeline_default",
    "2026-06-02T10:00:07Z",
    ProductTimeline.NetworkMilestone("/health").ToActionAttributes());
var networkTimelinePreview = networkTimelineClient.PreviewJson();
AssertTrue(networkTimelineClient.PendingEvents() == 2, "expected network timeline events");
AssertTrue(networkTimelinePreview.Contains("\"name\": \"network.post /v1/payments/:id\"", StringComparison.Ordinal), "expected network action name");
AssertTrue(networkTimelinePreview.Contains("\"status\": \"failure\"", StringComparison.Ordinal), "expected network failure status");
AssertTrue(networkTimelinePreview.Contains("\"source\": \"network_timeline\"", StringComparison.Ordinal), "expected network timeline source");
AssertTrue(networkTimelinePreview.Contains("\"routeTemplate\": \"/v1/payments/:id\"", StringComparison.Ordinal), "expected sanitized network route");
AssertTrue(networkTimelinePreview.Contains("\"method\": \"POST\"", StringComparison.Ordinal), "expected normalized network method");
AssertTrue(networkTimelinePreview.Contains("\"statusCode\": 503", StringComparison.Ordinal), "expected network status code");
AssertTrue(networkTimelinePreview.Contains("\"durationMs\": 183.4", StringComparison.Ordinal), "expected network duration");
AssertTrue(networkTimelinePreview.Contains("\"api\": \"payments\"", StringComparison.Ordinal), "expected network primitive metadata");
AssertTrue(networkTimelinePreview.Contains("\"name\": \"network.get /health\"", StringComparison.Ordinal), "expected default network method name");
AssertTrue(networkTimelinePreview.Contains("\"status\": \"success\"", StringComparison.Ordinal), "expected default network status");
AssertTrue(!networkTimelinePreview.Contains("debug=sample", StringComparison.Ordinal), "expected network query text to be omitted");
ExpectSdkError("validation_error", "network milestone method must be a valid HTTP method", () =>
    ProductTimeline.NetworkMilestone("/orders/:id").WithMethod("GET /bad").ToActionAttributes());
ExpectSdkError("validation_error", "network milestone statusCode must be between 100 and 599", () =>
    ProductTimeline.NetworkMilestone("/orders/:id").WithStatusCode(700).ToActionAttributes());
ExpectSdkError("validation_error", "network milestone durationMs must be non-negative", () =>
    ProductTimeline.NetworkMilestone("/orders/:id").WithDurationMs(-1).ToActionAttributes());
ExpectSdkError("validation_error", "network milestone routeTemplate must be non-empty", () =>
    ProductTimeline.NetworkMilestone("   ").ToActionAttributes());
tests++;

var unauthorizedClient = SampleClient();
EnqueueAll(unauthorizedClient);
ExpectSdkError("unauthenticated", "transport rejected the API key", () =>
    unauthorizedClient.Flush(new RecordingTransport(new object[] { 401 })));
AssertTrue(unauthorizedClient.PendingEvents() == 6, "expected unauthenticated failure to preserve queue");
tests++;

var retryClient = SampleClient();
EnqueueAll(retryClient);
var retryTransport = new RecordingTransport(new object[] { TransportException.Network("temporary outage"), 202 });
var retryResponse = retryClient.Flush(retryTransport);
AssertTrue(retryResponse.Attempts == 2, "expected retry before success");
AssertTrue(retryTransport.SentBodies.Count == 2, "expected two sent bodies");
var guidedResponse = new RecordingTransport(new object[]
{
    new TransportResponse(503, 1, TimeSpan.FromSeconds(2))
}).Send("LOGBREW_API_KEY", "{}");
AssertTrue(guidedResponse.RetryAfter == TimeSpan.FromSeconds(2), "expected recording transport to preserve retry guidance");
tests++;

var retryBudgetClient = SampleClient(maxRetries: 1);
EnqueueAll(retryBudgetClient);
ExpectSdkError("network_failure", "still down", () =>
    retryBudgetClient.Flush(new RecordingTransport(new object[]
    {
        TransportException.Network("temporary outage"),
        TransportException.Network("still down")
    })));
AssertTrue(retryBudgetClient.PendingEvents() == 6, "expected retry-budget failure to preserve queue");
tests++;

var statusClient = SampleClient();
EnqueueAll(statusClient);
ExpectSdkError("transport_error", "unexpected transport status 400", () =>
    statusClient.Flush(new RecordingTransport(new object[] { 400 })));
AssertTrue(statusClient.PendingEvents() == 6, "expected status failure to preserve queue");
tests++;

using (var httpIntake = new LocalHttpIntake(HttpStatusCode.Accepted))
using (var httpClient = new HttpClient())
using (var httpTransport = new HttpTransport(new HttpTransportOptions
{
    Endpoint = httpIntake.Endpoint,
    Headers = new Dictionary<string, string> { ["x-logbrew-source"] = "dotnet-test" },
    HttpClient = httpClient,
    Timeout = TimeSpan.FromSeconds(5)
}))
{
    var httpResponse = httpTransport.Send("LOGBREW_API_KEY", "{\"events\":[{\"id\":\"evt_dotnet_http\"}]}");
    AssertTrue(httpResponse.StatusCode == 202, "expected HTTP transport status");
    AssertTrue(httpResponse.Attempts == 1, "expected HTTP transport attempt");
    AssertTrue(httpTransport.Endpoint == httpIntake.Endpoint, "expected HTTP transport endpoint");
    AssertTrue(httpTransport.Timeout == TimeSpan.FromSeconds(5), "expected HTTP transport timeout");
    AssertTrue(httpTransport.Headers.Count == 1, "expected HTTP transport headers");
    AssertTrue(httpIntake.RequestCount == 1, "expected one HTTP request");
    AssertTrue(httpIntake.LastMethod == "POST", "expected HTTP POST");
    AssertTrue(httpIntake.LastPath == "/v1/events", "expected HTTP path");
    AssertTrue(httpIntake.LastBody.Contains("evt_dotnet_http", StringComparison.Ordinal), "expected HTTP request body");
    AssertTrue(httpIntake.LastAuthorization == "Bearer LOGBREW_API_KEY", "expected HTTP authorization header");
    AssertTrue(httpIntake.LastContentType.StartsWith("application/json", StringComparison.Ordinal), "expected HTTP content type");
    AssertTrue(httpIntake.LastSource == "dotnet-test", "expected HTTP custom header");
}

tests++;

using (var retryHttpIntake = new LocalHttpIntake(HttpStatusCode.ServiceUnavailable, HttpStatusCode.Accepted))
using (var retryHttpClient = new HttpClient())
using (var retryHttpTransport = new HttpTransport(new HttpTransportOptions
{
    Endpoint = retryHttpIntake.Endpoint,
    HttpClient = retryHttpClient
}))
{
    var httpRetryClient = SampleClient(maxRetries: 1);
    httpRetryClient.Log("evt_dotnet_http_retry", "2026-06-02T10:00:03Z", LogAttributes.Create("retry me", "info"));
    var httpRetryResponse = httpRetryClient.Flush(retryHttpTransport);
    AssertTrue(httpRetryResponse.StatusCode == 202, "expected HTTP retry status");
    AssertTrue(httpRetryResponse.Attempts == 2, "expected HTTP retry attempts");
    AssertTrue(retryHttpIntake.RequestCount == 2, "expected two HTTP requests");
    AssertTrue(retryHttpIntake.Bodies.Count == 2, "expected two HTTP bodies");
    AssertTrue(retryHttpIntake.Bodies[0] == retryHttpIntake.Bodies[1], "expected retry body to stay unchanged");
    AssertTrue(httpRetryClient.PendingEvents() == 0, "expected HTTP retry to clear queue");
}

tests++;

using (var failingHttpTransport = new HttpTransport(new HttpTransportOptions
{
    Endpoint = new Uri("http://127.0.0.1:1/v1/events"),
    Timeout = TimeSpan.FromSeconds(1)
}))
{
    var sawHttpFailure = false;
    try
    {
        failingHttpTransport.Send("LOGBREW_API_KEY", "{}");
    }
    catch (TransportException error)
    {
        AssertTrue(error.Code == "network_failure", "expected HTTP network code");
        AssertTrue(error.Retryable, "expected HTTP network retryable");
        AssertTrue(error.Message.Contains("http transport failed", StringComparison.Ordinal), "expected HTTP failure prefix");
        sawHttpFailure = true;
    }

    AssertTrue(sawHttpFailure, "expected HTTP transport exception");
}

tests++;

ExpectSdkError("configuration_error", "endpoint must be absolute", () =>
    CreateAndDisposeHttpTransport(new HttpTransportOptions { Endpoint = new Uri("/v1/events", UriKind.Relative) }));
ExpectSdkError("configuration_error", "header name must be non-empty", () =>
    CreateAndDisposeHttpTransport(new HttpTransportOptions { Headers = new Dictionary<string, string> { [" "] = "bad" } }));
ExpectSdkError("configuration_error", "timeout must be positive", () =>
    CreateAndDisposeHttpTransport(new HttpTransportOptions { Timeout = TimeSpan.Zero }));
tests++;

var shutdownClient = SampleClient();
EnqueueAll(shutdownClient);
var shutdownResponse = shutdownClient.Shutdown(RecordingTransport.AlwaysAccept());
AssertTrue(shutdownResponse.StatusCode == 202, "expected shutdown flush");
ExpectSdkError("shutdown_error", "client is already shut down", () =>
    shutdownClient.Action("evt_action_002", "2026-06-02T10:00:06Z", ActionAttributes.Create("deploy", "success")));
tests++;

var loggingClient = SampleClient();
var loggingTransport = RecordingTransport.AlwaysAccept();
var providerErrors = 0;
using (var factory = LoggerFactory.Create(builder =>
{
    builder.SetMinimumLevel(LogLevel.Debug);
    builder.AddLogBrew(loggingClient, new LogBrewLoggerOptions
    {
        MinimumLevel = LogLevel.Debug,
        Metadata = new Dictionary<string, object?> { ["service"] = "checkout", ["ignoredBase"] = new object() },
        EventIdPrefix = "dotnet_test",
        TimestampProvider = () => DateTimeOffset.Parse("2026-06-02T10:00:06Z", System.Globalization.CultureInfo.InvariantCulture),
        OnError = _ => providerErrors++
    });
}))
{
    var logger = factory.CreateLogger("CheckoutWorker");
    AssertTrue(logger.IsEnabled(LogLevel.Warning), "expected warning to be enabled");
    using (logger.BeginScope(new Dictionary<string, object?> { ["requestId"] = "req_123", ["ignoredScope"] = new object() }))
    {
        if (logger.IsEnabled(LogLevel.Debug))
        {
            logger.Log(
                LogLevel.Debug,
                new EventId(40, "CheckoutDebug"),
                new Dictionary<string, object?> { ["debugValue"] = 7 },
                null,
                static (_, _) => "debug detail");
        }

        if (logger.IsEnabled(LogLevel.Warning))
        {
            logger.Log(
                LogLevel.Warning,
                new EventId(42, "CheckoutSlow"),
                new Dictionary<string, object?> { ["region"] = "global", ["ignoredState"] = new object(), ["{OriginalFormat}"] = "Checkout slow for {region}" },
                null,
                static (_, _) => "checkout slow");
        }

        if (logger.IsEnabled(LogLevel.Error))
        {
            logger.Log(
                LogLevel.Error,
                new EventId(43, "CheckoutFailed"),
                new Dictionary<string, object?> { ["region"] = "global" },
                new InvalidOperationException("payment failed"),
                static (_, error) => "checkout failed: " + error?.Message);
        }

        if (logger.IsEnabled(LogLevel.Critical))
        {
            logger.Log(
                LogLevel.Critical,
                new EventId(44, "CheckoutDown"),
                new Dictionary<string, object?> { ["region"] = "global" },
                new InvalidOperationException("checkout down"),
                static (_, error) => "checkout down: " + error?.Message);
        }
    }
}

AssertTrue(providerErrors == 0, "expected logging provider not to report errors");
AssertTrue(loggingClient.PendingEvents() == 4, "expected logger provider to queue events");
var loggingPreview = loggingClient.PreviewJson();
AssertTrue(loggingPreview.Contains("\"id\": \"dotnet_test_1\"", StringComparison.Ordinal), "expected deterministic logger event id");
AssertTrue(loggingPreview.Contains("\"timestamp\": \"2026-06-02T10:00:06.0000000+00:00\"", StringComparison.Ordinal), "expected deterministic logger timestamp");
AssertTrue(loggingPreview.Contains("\"logger\": \"CheckoutWorker\"", StringComparison.Ordinal), "expected logger category");
AssertTrue(loggingPreview.Contains("\"level\": \"info\"", StringComparison.Ordinal), "expected debug level alias mapping");
AssertTrue(loggingPreview.Contains("\"level\": \"warning\"", StringComparison.Ordinal), "expected warning level mapping");
AssertTrue(loggingPreview.Contains("\"level\": \"error\"", StringComparison.Ordinal), "expected error level mapping");
AssertTrue(loggingPreview.Contains("\"level\": \"critical\"", StringComparison.Ordinal), "expected critical level mapping");
AssertTrue(loggingPreview.Contains("\"dotnetLogLevel\": \"Warning\"", StringComparison.Ordinal), "expected native warning level metadata");
AssertTrue(loggingPreview.Contains("\"dotnetEventId\": 42", StringComparison.Ordinal), "expected event id metadata");
AssertTrue(loggingPreview.Contains("\"dotnetEventName\": \"CheckoutSlow\"", StringComparison.Ordinal), "expected event name metadata");
AssertTrue(loggingPreview.Contains("\"messageTemplate\": \"Checkout slow for {region}\"", StringComparison.Ordinal), "expected message template metadata");
AssertTrue(loggingPreview.Contains("\"scope.requestId\": \"req_123\"", StringComparison.Ordinal), "expected scope metadata");
AssertTrue(loggingPreview.Contains("\"exceptionType\": \"System.InvalidOperationException\"", StringComparison.Ordinal), "expected exception type metadata");
AssertTrue(loggingPreview.Contains("\"exceptionMessage\": \"payment failed\"", StringComparison.Ordinal), "expected exception message metadata");
AssertTrue(!loggingPreview.Contains("exceptionStackTrace", StringComparison.Ordinal), "expected stack trace to be opt-in");
AssertTrue(!loggingPreview.Contains("ignoredBase", StringComparison.Ordinal), "expected non-primitive base metadata to be skipped");
AssertTrue(!loggingPreview.Contains("ignoredState", StringComparison.Ordinal), "expected non-primitive state metadata to be skipped");
AssertTrue(!loggingPreview.Contains("ignoredScope", StringComparison.Ordinal), "expected non-primitive scope metadata to be skipped");
var loggingResponse = loggingClient.Flush(loggingTransport);
AssertTrue(loggingResponse.StatusCode == 202, "expected logger provider flush");
AssertTrue(loggingTransport.SentBodies.Count == 1, "expected one logger provider body");
tests++;

var boundedDrops = new List<DroppedEvent>();
var boundedClient = LogBrewClient.Create(
    "LOGBREW_API_KEY",
    "logbrew-dotnet",
    "0.1.0",
    maxRetries: 2,
    maxQueueSize: 2,
    onEventDropped: boundedDrops.Add);
boundedClient.Release("evt_dotnet_bounded_release", "2026-06-02T10:00:00Z", ReleaseAttributes.Create("1.2.3"));
boundedClient.Environment("evt_dotnet_bounded_environment", "2026-06-02T10:00:01Z", EnvironmentAttributes.Create("production"));
boundedClient.Log("evt_dotnet_bounded_dropped", "2026-06-02T10:00:02Z", LogAttributes.Create("queue pressure", "warning"));
AssertTrue(boundedClient.PendingEvents() == 2, "expected bounded queue to preserve existing events");
AssertTrue(boundedClient.DroppedEvents() == 1, "expected bounded queue to count drops");
AssertTrue(boundedDrops.Count == 1, "expected bounded queue drop callback");
AssertTrue(boundedDrops[0].EventId == "evt_dotnet_bounded_dropped", "expected dropped event id");
AssertTrue(boundedDrops[0].EventType == "log", "expected dropped event type");
AssertTrue(boundedDrops[0].Reason == "queue_overflow", "expected dropped event reason");
AssertTrue(boundedDrops[0].DroppedEvents == 1, "expected dropped event count");
var boundedPreview = boundedClient.PreviewJson();
AssertTrue(boundedPreview.Contains("evt_dotnet_bounded_release", StringComparison.Ordinal), "expected release context to stay queued");
AssertTrue(boundedPreview.Contains("evt_dotnet_bounded_environment", StringComparison.Ordinal), "expected environment context to stay queued");
AssertTrue(!boundedPreview.Contains("evt_dotnet_bounded_dropped", StringComparison.Ordinal), "expected overflow event to be dropped");

var advisoryDropClient = LogBrewClient.Create(
    "LOGBREW_API_KEY",
    "logbrew-dotnet",
    "0.1.0",
    maxRetries: 2,
    maxQueueSize: 1,
    onEventDropped: _ => throw new InvalidOperationException("drop callback failed"));
advisoryDropClient.Log("evt_dotnet_advisory_1", "2026-06-02T10:00:01Z", LogAttributes.Create("kept", "info"));
advisoryDropClient.Log("evt_dotnet_advisory_2", "2026-06-02T10:00:02Z", LogAttributes.Create("dropped", "info"));
AssertTrue(advisoryDropClient.PendingEvents() == 1, "expected advisory drop callback failure not to interrupt capture");
AssertTrue(advisoryDropClient.DroppedEvents() == 1, "expected advisory dropped event count");
ExpectSdkError("validation_error", "max_queue_size must be positive", () =>
    LogBrewClient.Create("LOGBREW_API_KEY", "logbrew-dotnet", "0.1.0", maxRetries: 2, maxQueueSize: 0));
tests++;

var heavyLoggingClient = SampleClient();
var heavyLoggingTransport = RecordingTransport.AlwaysAccept();
var heavyLoggingErrors = 0;
const int heavyLoggingWorkers = 8;
const int heavyLoggingEventsPerWorker = 1250;
var heavyLoggingTotal = heavyLoggingWorkers * heavyLoggingEventsPerWorker;
using (var factory = LoggerFactory.Create(builder =>
{
    builder.SetMinimumLevel(LogLevel.Information);
    builder.AddLogBrew(heavyLoggingClient, new LogBrewLoggerOptions
    {
        MinimumLevel = LogLevel.Information,
        Metadata = new Dictionary<string, object?> { ["service"] = "checkout", ["loadTest"] = true },
        EventIdPrefix = "dotnet_load",
        TimestampProvider = () => DateTimeOffset.Parse("2026-06-02T10:01:00Z", System.Globalization.CultureInfo.InvariantCulture),
        OnError = _ => Interlocked.Increment(ref heavyLoggingErrors)
    });
}))
{
    var logger = factory.CreateLogger("HeavyLoadWorker");
    Parallel.For(0, heavyLoggingWorkers, worker =>
    {
        for (var index = 0; index < heavyLoggingEventsPerWorker; index++)
        {
            if (logger.IsEnabled(LogLevel.Information))
            {
                logger.Log(
                    LogLevel.Information,
                    new EventId(index + 1, "HeavyLoad"),
                    new Dictionary<string, object?> { ["worker"] = worker, ["eventIndex"] = index, ["phase"] = "load" },
                    null,
                    static (_, _) => "heavy logging event");
            }
        }
    });
}

AssertTrue(heavyLoggingErrors == 0, "expected heavy logging load not to report provider errors");
AssertTrue(heavyLoggingClient.PendingEvents() == 1000, "expected heavy logging load to keep bounded queue");
AssertTrue(heavyLoggingClient.DroppedEvents() == heavyLoggingTotal - 1000, "expected heavy logging load to count dropped events");
var heavyPreview = heavyLoggingClient.PreviewJson();
AssertTrue(CountOccurrences(heavyPreview, "\"type\": \"log\"") == 1000, "expected heavy logging preview to include accepted log events");
AssertTrue(!heavyPreview.Contains("exceptionStackTrace", StringComparison.Ordinal), "expected heavy logging load not to add stack traces");
var heavyResponse = heavyLoggingClient.Flush(heavyLoggingTransport);
AssertTrue(heavyResponse.StatusCode == 202, "expected heavy logging flush");
AssertTrue(heavyResponse.Attempts == 10, "expected heavy logging flush to aggregate bounded requests");
AssertTrue(heavyLoggingClient.PendingEvents() == 0, "expected heavy logging flush to clear queue");
AssertTrue(heavyLoggingTransport.SentBodies.Count == 10, "expected ten bounded heavy logging requests");
var heavyAcceptedLogs = 0;
foreach (var body in heavyLoggingTransport.SentBodies)
{
    AssertTrue(Encoding.UTF8.GetByteCount(body) <= 256 * 1024, "expected heavy logging request byte bound");
    var bodyLogs = CountOccurrences(body, "\"type\": \"log\"");
    AssertTrue(bodyLogs <= 100, "expected heavy logging request event bound");
    heavyAcceptedLogs += bodyLogs;
}

AssertTrue(heavyAcceptedLogs == 1000, "expected heavy logging requests to include accepted log events");
tests++;

var flushOnLogClient = SampleClient();
var flushOnLogTransport = RecordingTransport.AlwaysAccept();
using (var factory = LoggerFactory.Create(builder => builder.AddLogBrew(flushOnLogClient, new LogBrewLoggerOptions
{
    FlushOnLog = true,
    Transport = flushOnLogTransport,
    TimestampProvider = () => DateTimeOffset.Parse("2026-06-02T10:00:07Z", System.Globalization.CultureInfo.InvariantCulture)
})))
{
    var flushLogger = factory.CreateLogger("FlushWorker");
    if (flushLogger.IsEnabled(LogLevel.Warning))
    {
        flushLogger.Log(
            LogLevel.Warning,
            new EventId(7, "FlushNow"),
            new Dictionary<string, object?> { ["kind"] = "flush" },
            null,
            static (_, _) => "flush now");
    }
}

AssertTrue(flushOnLogClient.PendingEvents() == 0, "expected flush-on-log to clear queued event");
AssertTrue(flushOnLogTransport.SentBodies.Count == 1, "expected flush-on-log transport body");
tests++;

tests += TraceCorrelationTests.Run();
tests += OperationTracingTests.Run();
tests += DbCommandTelemetryTests.Run();
tests += SupportTicketDraftTests.Run();
tests += ServerRequestTelemetryTests.Run();
tests += HttpClientTelemetryTests.Run();
tests += ActivitySpanTelemetryTests.Run();
tests += ActivitySourceListenerTests.Run();
tests += AutomaticDeliveryTests.Run();

Console.WriteLine("dotnet package tests ok (" + tests.ToString(CultureInfo.InvariantCulture) + " tests)");

internal sealed class LocalHttpIntake : IDisposable
{
    private readonly TcpListener listener;
    private readonly Queue<HttpStatusCode> statuses;
    private readonly Task acceptTask;
    private bool disposed;

    internal LocalHttpIntake(params HttpStatusCode[] statuses)
    {
        listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        Endpoint = new Uri("http://127.0.0.1:" + port.ToString(CultureInfo.InvariantCulture) + "/v1/events");
        this.statuses = new Queue<HttpStatusCode>(statuses.Length == 0 ? new[] { HttpStatusCode.Accepted } : statuses);
        acceptTask = Task.Run(AcceptLoop);
    }

    internal Uri Endpoint { get; }

    internal int RequestCount
    {
        get { return Volatile.Read(ref requestCount); }
    }

    internal string LastMethod { get; private set; } = string.Empty;

    internal string LastPath { get; private set; } = string.Empty;

    internal string LastAuthorization { get; private set; } = string.Empty;

    internal string LastContentType { get; private set; } = string.Empty;

    internal string LastSource { get; private set; } = string.Empty;

    internal string LastBody { get; private set; } = string.Empty;

    internal List<string> Bodies { get; } = new List<string>();

    private int requestCount;

    public void Dispose()
    {
        Volatile.Write(ref disposed, true);
        listener.Stop();
        listener.Dispose();
        try
        {
            acceptTask.Wait(TimeSpan.FromSeconds(2));
        }
        catch (AggregateException)
        {
        }
    }

    private async Task AcceptLoop()
    {
        while (!Volatile.Read(ref disposed))
        {
            TcpClient? socket = null;
            try
            {
                socket = await listener.AcceptTcpClientAsync().ConfigureAwait(false);
                await HandleClient(socket).ConfigureAwait(false);
            }
            catch (ObjectDisposedException) when (Volatile.Read(ref disposed))
            {
                return;
            }
            catch (SocketException) when (Volatile.Read(ref disposed))
            {
                return;
            }
            finally
            {
                socket?.Dispose();
            }
        }
    }

    private async Task HandleClient(TcpClient socket)
    {
        using var stream = socket.GetStream();
        using var reader = new StreamReader(stream, Encoding.ASCII, detectEncodingFromByteOrderMarks: false, bufferSize: 1024, leaveOpen: true);
        var requestLine = await reader.ReadLineAsync().ConfigureAwait(false) ?? string.Empty;
        var parts = requestLine.Split(' ');
        LastMethod = parts.Length > 0 ? parts[0] : string.Empty;
        LastPath = parts.Length > 1 ? parts[1] : string.Empty;

        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        while (true)
        {
            var line = await reader.ReadLineAsync().ConfigureAwait(false);
            if (line == null || line.Length == 0)
            {
                break;
            }

            var separator = line.IndexOf(':', StringComparison.Ordinal);
            if (separator > 0)
            {
                headers[line.Substring(0, separator).Trim()] = line.Substring(separator + 1).Trim();
            }
        }

        var contentLength = 0;
        if (headers.TryGetValue("content-length", out var contentLengthValue))
        {
            int.TryParse(contentLengthValue, NumberStyles.None, CultureInfo.InvariantCulture, out contentLength);
        }

        var body = new StringBuilder();
        if (contentLength > 0)
        {
            var buffer = new char[contentLength];
            while (body.Length < contentLength)
            {
                var read = await reader.ReadAsync(buffer, 0, Math.Min(buffer.Length, contentLength - body.Length)).ConfigureAwait(false);
                if (read == 0)
                {
                    break;
                }

                body.Append(buffer, 0, read);
            }
        }

        LastBody = body.ToString();
        Bodies.Add(LastBody);
        LastAuthorization = headers.TryGetValue("authorization", out var authorization) ? authorization : string.Empty;
        LastContentType = headers.TryGetValue("content-type", out var contentType) ? contentType : string.Empty;
        LastSource = headers.TryGetValue("x-logbrew-source", out var source) ? source : string.Empty;

        Interlocked.Increment(ref requestCount);
        var status = statuses.Count == 0 ? HttpStatusCode.Accepted : statuses.Dequeue();
        var code = ((int)status).ToString(CultureInfo.InvariantCulture);
        var reason = status == HttpStatusCode.ServiceUnavailable ? "Service Unavailable" : "Accepted";
        var response = "HTTP/1.1 " + code + " " + reason + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        var bytes = Encoding.ASCII.GetBytes(response);

        await stream.WriteAsync(bytes.AsMemory(0, bytes.Length)).ConfigureAwait(false);
    }
}
