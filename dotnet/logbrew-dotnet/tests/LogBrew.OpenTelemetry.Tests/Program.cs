using System;
using System.Collections.Generic;
using System.Diagnostics;
using LogBrew;
using LogBrew.OpenTelemetry;
using OpenTelemetry;
using OpenTelemetry.Trace;

static void Require(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException(message);
    }
}

var tests = 0;

OpenTelemetryProcessorCapturesEndedActivity();
tests++;
OpenTelemetryExporterWorksWithSimpleActivityExportProcessor();
tests++;
OpenTelemetryProcessorDoesNotInterruptProviderOnCaptureFailure();
tests++;
OpenTelemetryExporterReturnsFailureWhenCaptureFails();
tests++;
OpenTelemetryProcessorHandlesHighVolumeQueuePressure();
tests++;

await Console.Error.WriteLineAsync("{\"tests\":" + tests.ToString(System.Globalization.CultureInfo.InvariantCulture) + "}").ConfigureAwait(false);

static void OpenTelemetryProcessorCapturesEndedActivity()
{
    var client = LogBrewClient.Create("LOGBREW_API_KEY", "dotnet-opentelemetry-tests", "0.1.0");
    const string sourceName = "LogBrew.Tests.OpenTelemetry";

    using var source = new ActivitySource(sourceName, "2.3.4");
    using (Sdk.CreateTracerProviderBuilder()
        .AddSource(sourceName)
        .AddLogBrew(client, options => options
            .WithEventIdPrefix("dotnet_otel")
            .WithServiceName("checkout-api")
            .WithServiceVersion("2.3.4")
            .WithDeploymentEnvironment("staging")
            .WithMetadata(new Dictionary<string, object?>
            {
                ["safe"] = true,
                ["authorization"] = "Bearer omitted",
                ["parameters"] = "coupon=omitted"
            }))
        .Build())
    {
        using var activity = source.StartActivity("GET /checkout/{id}", ActivityKind.Server);
        Require(activity != null, "expected sampled OpenTelemetry activity");
        activity!.SetTag("http.request.method", "GET");
        activity.SetTag("http.route", "/checkout/{id}");
        activity.SetTag("http.response.status_code", 503);
        activity.SetTag("url.full", "https://example.test/checkout/omitted?coupon=omitted");
        activity.AddEvent(new ActivityEvent(
            "exception",
            tags: new ActivityTagsCollection
            {
                ["exception.type"] = "System.TimeoutException",
                ["exception.message"] = "omitted timeout message"
            }));
    }

    var payload = client.PreviewJson();
    foreach (var expected in new[]
    {
        "\"id\": \"dotnet_otel_span_",
        "\"name\": \"GET /checkout/{id}\"",
        "\"source\": \"dotnet.activity\"",
        "\"activityKind\": \"server\"",
        "\"activitySourceName\": \"" + sourceName + "\"",
        "\"activitySourceVersion\": \"2.3.4\"",
        "\"traceFlags\": \"01\"",
        "\"traceSampled\": true",
        "\"httpMethod\": \"GET\"",
        "\"httpRoute\": \"/checkout/{id}\"",
        "\"httpStatusCode\": 503",
        "\"status\": \"error\"",
        "\"safe\": true",
        "\"serviceName\": \"checkout-api\"",
        "\"serviceVersion\": \"2.3.4\"",
        "\"deploymentEnvironment\": \"staging\"",
        "\"otel.exception_event_count\": 1",
        "\"otel.exception_types\": \"System.TimeoutException\"",
        "\"exceptionType\": \"System.TimeoutException\""
    })
    {
        Require(payload.Contains(expected, StringComparison.Ordinal), "missing OpenTelemetry payload: " + expected);
    }

    foreach (var blocked in new[]
    {
        "Bearer omitted",
        "coupon=omitted",
        "example.test",
        "omitted timeout message"
    })
    {
        Require(!payload.Contains(blocked, StringComparison.Ordinal), "expected OpenTelemetry detail to be omitted: " + blocked);
    }
}

static void OpenTelemetryExporterWorksWithSimpleActivityExportProcessor()
{
    var client = LogBrewClient.Create("LOGBREW_API_KEY", "dotnet-opentelemetry-tests", "0.1.0");
    const string sourceName = "LogBrew.Tests.OpenTelemetry.Exporter";
    using var exporter = new LogBrewOpenTelemetrySpanExporter(client, options => options
        .WithEventIdPrefix("dotnet_otel_exporter")
        .WithServiceName("checkout-worker")
        .WithServiceVersion("2.3.4")
        .WithDeploymentEnvironment("staging"));
    using var processor = new SimpleActivityExportProcessor(exporter);

    using var source = new ActivitySource(sourceName, "2.3.4");
    using (Sdk.CreateTracerProviderBuilder()
        .AddSource(sourceName)
        .AddProcessor(processor)
        .Build())
    {
        using var activity = source.StartActivity("POST /jobs/{id}", ActivityKind.Producer);
        Require(activity != null, "expected sampled OpenTelemetry exporter activity");
        activity!.SetTag("messaging.system", "memory");
        activity.SetTag("messaging.operation", "publish");
        activity.SetTag("messaging.message.id", "message-id-omitted");
        activity.SetTag("url.full", "https://example.test/jobs/123?debug=omitted");
        activity.AddLink(new ActivityLink(
            new ActivityContext(
                ActivityTraceId.CreateFromString("4bf92f3577b34da6a3ce929d0e0e4736".AsSpan()),
                ActivitySpanId.CreateFromString("00f067aa0ba902b7".AsSpan()),
                ActivityTraceFlags.Recorded),
            new ActivityTagsCollection
            {
                ["messaging.system"] = "memory",
                ["messaging.message.id"] = "linked-message-id-omitted"
            }));
    }

    var payload = client.PreviewJson();
    foreach (var expected in new[]
    {
        "\"id\": \"dotnet_otel_exporter_span_",
        "\"name\": \"POST /jobs/{id}\"",
        "\"source\": \"dotnet.activity\"",
        "\"activityKind\": \"producer\"",
        "\"activitySourceName\": \"" + sourceName + "\"",
        "\"activitySourceVersion\": \"2.3.4\"",
        "\"messagingSystem\": \"memory\"",
        "\"messagingOperation\": \"publish\"",
        "\"serviceName\": \"checkout-worker\"",
        "\"serviceVersion\": \"2.3.4\"",
        "\"deploymentEnvironment\": \"staging\"",
        "\"links\":"
    })
    {
        Require(payload.Contains(expected, StringComparison.Ordinal), "missing OpenTelemetry exporter payload: " + expected);
    }

    foreach (var blocked in new[]
    {
        "message-id-omitted",
        "linked-message-id-omitted",
        "debug=omitted",
        "example.test"
    })
    {
        Require(!payload.Contains(blocked, StringComparison.Ordinal), "expected OpenTelemetry exporter detail to be omitted: " + blocked);
    }
}

static void OpenTelemetryProcessorDoesNotInterruptProviderOnCaptureFailure()
{
    var errors = new List<string>();
    var client = LogBrewClient.Create("LOGBREW_API_KEY", "dotnet-opentelemetry-tests", "0.1.0");
    client.Shutdown(new NoopTransport());

    using var source = new ActivitySource("LogBrew.Tests.OpenTelemetry.Failures");
    using (Sdk.CreateTracerProviderBuilder()
        .AddSource("LogBrew.Tests.OpenTelemetry.Failures")
        .AddLogBrew(client, options => options.OnError(error => errors.Add(error.Code)))
        .Build())
    {
        using var activity = source.StartActivity("operation after shutdown", ActivityKind.Internal);
        Require(activity != null, "expected sampled failure activity");
    }

    Require(errors.Count == 1, "expected one capture error");
    Require(errors[0] == "shutdown_error", "expected shutdown error to be reported");
}

static void OpenTelemetryExporterReturnsFailureWhenCaptureFails()
{
    var errors = new List<string>();
    var client = LogBrewClient.Create("LOGBREW_API_KEY", "dotnet-opentelemetry-tests", "0.1.0");
    client.Shutdown(new NoopTransport());
    using var exporter = new LogBrewOpenTelemetrySpanExporter(
        client,
        options => options.OnError(error => errors.Add(error.Code)));

    using var activity = new Activity("operation after shutdown");
    activity.SetIdFormat(ActivityIdFormat.W3C);
    activity.ActivityTraceFlags = ActivityTraceFlags.Recorded;
    activity.Start();
    activity.Stop();

    var result = exporter.Export(new Batch<Activity>(activity));

    Require(result == ExportResult.Failure, "expected exporter failure when LogBrew capture fails");
    Require(errors.Count == 1, "expected one exporter capture error");
    Require(errors[0] == "shutdown_error", "expected shutdown error to be reported by exporter");
}

static void OpenTelemetryProcessorHandlesHighVolumeQueuePressure()
{
    var droppedReasons = new List<string>();
    var client = LogBrewClient.Create(
        "LOGBREW_API_KEY",
        "dotnet-opentelemetry-tests",
        "0.1.0",
        maxQueueSize: 32,
        onEventDropped: drop => droppedReasons.Add(drop.Reason));
    const string sourceName = "LogBrew.Tests.OpenTelemetry.HighVolume";

    using var source = new ActivitySource(sourceName);
    using (Sdk.CreateTracerProviderBuilder()
        .AddSource(sourceName)
        .AddLogBrew(client, options => options.WithEventIdPrefix("dotnet_otel_burst"))
        .Build())
    {
        for (var index = 0; index < 128; index++)
        {
            using var activity = source.StartActivity("burst activity", ActivityKind.Internal);
            Require(activity != null, "expected sampled high-volume activity");
            activity!.SetTag("messaging.system", "in-memory");
            activity.SetTag("message", "omitted payload " + index.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }
    }

    Require(client.PendingEvents() == 32, "expected queue cap to bound OpenTelemetry spans");
    Require(client.DroppedEvents() == 96, "expected overflow count for OpenTelemetry span burst");
    Require(droppedReasons.Count == 96, "expected drop callback for each overflowed span");
    Require(droppedReasons.TrueForAll(reason => reason == "queue_overflow"), "expected queue overflow reason");
    var payload = client.PreviewJson();
    Require(payload.Contains("\"id\": \"dotnet_otel_burst_span_", StringComparison.Ordinal), "expected high-volume span id prefix");
    Require(payload.Contains("\"messagingSystem\": \"in-memory\"", StringComparison.Ordinal), "expected safe high-volume metadata");
    Require(!payload.Contains("omitted payload", StringComparison.Ordinal), "expected high-volume payload text to be omitted");
}

internal sealed class NoopTransport : ITransport
{
    public TransportResponse Send(string apiKey, string body)
    {
        return new TransportResponse(202, 1);
    }
}
