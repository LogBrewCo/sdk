using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using LogBrew;
using LogBrew.HttpClient;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Http;

const string IncomingTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const string CallerTraceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";

var tests = 0;
await SelectedNamedAndTypedClientsAreScopedAndDeduplicated().ConfigureAwait(false);
tests++;
await NoParentIsLiteralPassThrough().ConfigureAwait(false);
tests++;
await CallerTraceparentIsResetOnResponseAndError().ConfigureAwait(false);
tests++;
await MetadataIsFixedAndHostIsPrivacyBounded().ConfigureAwait(false);
tests++;
SdkDeliveryIsNeverCorrelated();
tests++;
await ResponseAndStreamingContentRemainAppOwned().ConfigureAwait(false);
tests++;
await OriginalErrorAndCancellationRemainExact().ConfigureAwait(false);
tests++;
await ActiveParentSetupFailureSendsOnceUntraced().ConfigureAwait(false);
tests++;
await ConcurrentOutOfOrderRequestsStayIsolated().ConfigureAwait(false);
tests++;
await RetryMiddlewareCreatesOneChildPerExecution().ConfigureAwait(false);
tests++;
Console.WriteLine("dotnet HttpClient correlation tests ok (" + tests.ToString(CultureInfo.InvariantCulture) + " tests)");

static async Task SelectedNamedAndTypedClientsAreScopedAndDeduplicated()
{
    var telemetry = NewTelemetryClient();
    var root = NewRoot();
    var selectedTraceparents = new List<string>();
    var typedTraceparents = new List<string>();
    var plainHeaders = new List<string>();
    using var directClient = new HttpClient();
    var directTyped = new TypedApi(directClient);
    GC.KeepAlive(directTyped);
    var services = new ServiceCollection();
    var selected = services
        .AddHttpClient("selected")
        .ConfigurePrimaryHttpMessageHandler(() => new RecordingHandler(request =>
        {
            selectedTraceparents.AddRange(Traceparents(request));
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK));
        }));
    selected.AddLogBrewCorrelation(telemetry);
    selected.AddLogBrewCorrelation(telemetry);
    Require(
        !services.Any(descriptor =>
            descriptor.ServiceType == typeof(IHttpMessageHandlerBuilderFilter)
            && descriptor.ImplementationType?.Assembly == typeof(LogBrewHttpClientBuilderExtensions).Assembly),
        "selected registration must not install a factory-wide builder filter");
    services
        .AddHttpClient<TypedApi>()
        .ConfigurePrimaryHttpMessageHandler(() => new RecordingHandler(request =>
        {
            typedTraceparents.AddRange(Traceparents(request));
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Accepted));
        }))
        .AddLogBrewCorrelation(telemetry);
    services
        .AddHttpClient("plain")
        .ConfigurePrimaryHttpMessageHandler(() => new RecordingHandler(request =>
        {
            plainHeaders.AddRange(Traceparents(request));
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NoContent));
        }));

    using var provider = services.BuildServiceProvider();
    var factory = provider.GetRequiredService<IHttpClientFactory>();
    using (LogBrewTrace.Activate(root))
    {
        using var selectedClient = factory.CreateClient("selected");
        using var selectedResponse = await selectedClient.GetAsync(new Uri("https://selected.example.test/resource", UriKind.Absolute)).ConfigureAwait(false);
        var typed = provider.GetRequiredService<TypedApi>();
        using var typedResponse = await typed.GetAsync().ConfigureAwait(false);
        using var plainClient = factory.CreateClient("plain");
        using var plainResponse = await plainClient.GetAsync(new Uri("https://plain.example.test/resource", UriKind.Absolute)).ConfigureAwait(false);
    }

    Require(selectedTraceparents.Count == 1, "selected named client must inject once after duplicate registration");
    Require(typedTraceparents.Count == 1, "selected typed client must inject once");
    Require(plainHeaders.Count == 0, "unselected client must stay untouched");
    Require(Count(telemetry.PreviewJson(), "\"type\": \"span\"") == 2, "selected clients must capture exactly two spans");
}

static async Task NoParentIsLiteralPassThrough()
{
    var telemetry = NewTelemetryClient();
    var filterCalls = 0;
    var callbackCalls = 0;
    var observedHeaders = new List<string>();
    using var responseHolder = new ResponseHolder(new HttpResponseMessage(HttpStatusCode.PartialContent));
    var services = new ServiceCollection();
    services
        .AddHttpClient("no-parent")
        .ConfigurePrimaryHttpMessageHandler(() => new RecordingHandler(request =>
        {
            observedHeaders.AddRange(Traceparents(request));
            return Task.FromResult(responseHolder.Response);
        }))
        .AddLogBrewCorrelation(telemetry, options => options
            .WithRequestFilter(_ =>
            {
                filterCalls++;
                throw new InvalidOperationException("tracing-only failure");
            })
            .OnError(_ => callbackCalls++));

    using var provider = services.BuildServiceProvider();
    using var client = provider.GetRequiredService<IHttpClientFactory>().CreateClient("no-parent");
    using var request = new HttpRequestMessage(HttpMethod.Get, "https://no-parent.example.test/private");
    request.Headers.TryAddWithoutValidation("traceparent", CallerTraceparent);
    var actual = await client.SendAsync(request).ConfigureAwait(false);

    Require(ReferenceEquals(actual, responseHolder.Response), "no-parent pass-through must preserve response identity");
    Require(filterCalls == 0, "no-parent pass-through must not inspect tracing filter state");
    Require(callbackCalls == 0, "no-parent pass-through must not invoke advisory callback");
    Require(observedHeaders.SequenceEqual(new[] { CallerTraceparent }), "no-parent pass-through must preserve caller header");
    Require(telemetry.PendingEvents() == 0, "no-parent pass-through must not capture");
}

static async Task CallerTraceparentIsResetOnResponseAndError()
{
    var telemetry = NewTelemetryClient();
    var root = NewRoot();
    var sentHeaders = new List<string>();
    var original = new HttpRequestException("app-owned failure");
    var calls = 0;
    var services = new ServiceCollection();
    services
        .AddHttpClient("header-reset")
        .ConfigurePrimaryHttpMessageHandler(() => new RecordingHandler(request =>
        {
            calls++;
            sentHeaders.AddRange(Traceparents(request));
            return calls == 1
                ? Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK))
                : Task.FromException<HttpResponseMessage>(original);
        }))
        .AddLogBrewCorrelation(telemetry);

    using var provider = services.BuildServiceProvider();
    using var client = provider.GetRequiredService<IHttpClientFactory>().CreateClient("header-reset");
    using var request = new HttpRequestMessage(HttpMethod.Get, "https://headers.example.test/private");
    request.Headers.TryAddWithoutValidation("traceparent", CallerTraceparent);
    using (LogBrewTrace.Activate(root))
    {
        using var response = await client.SendAsync(request).ConfigureAwait(false);
    }

    Require(Traceparents(request).SequenceEqual(new[] { CallerTraceparent }), "successful send must reset caller header");
    using var failedRequest = new HttpRequestMessage(HttpMethod.Get, "https://headers.example.test/failure");
    failedRequest.Headers.TryAddWithoutValidation("traceparent", CallerTraceparent);
    using (LogBrewTrace.Activate(root))
    {
        try
        {
            await client.SendAsync(failedRequest).ConfigureAwait(false);
            throw new InvalidOperationException("expected app-owned failure");
        }
        catch (HttpRequestException error)
        {
            Require(ReferenceEquals(error, original), "must preserve exact app exception");
        }
    }

    Require(Traceparents(failedRequest).SequenceEqual(new[] { CallerTraceparent }), "failed send must reset caller header");
    Require(sentHeaders.Count == 2, "each execution must inject one header");
    Require(sentHeaders.All(value => value != CallerTraceparent), "send must use child traceparents");
    Require(sentHeaders.Distinct(StringComparer.Ordinal).Count() == 2, "repeated executions must use distinct children");
}

static async Task MetadataIsFixedAndHostIsPrivacyBounded()
{
    var telemetry = NewTelemetryClient();
    var root = NewRoot();
    var services = new ServiceCollection();
    services
        .AddHttpClient("sensitive-client-name")
        .ConfigurePrimaryHttpMessageHandler(() => new RecordingHandler(_ =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.ServiceUnavailable))))
        .AddLogBrewCorrelation(telemetry, options => options
            .WithEventIdPrefix("dotnet_factory")
            .WithTimestampProvider(() => "2026-07-20T10:00:00Z"));

    using var provider = services.BuildServiceProvider();
    using var client = provider.GetRequiredService<IHttpClientFactory>().CreateClient("sensitive-client-name");
    using (LogBrewTrace.Activate(root))
    {
        using var dnsResponse = await client.GetAsync(new Uri("https://API.Example.TEST:8443/private/order?code=sample#fragment", UriKind.Absolute)).ConfigureAwait(false);
        foreach (var address in new[] { "127.0.0.1", "[2001:db8::1]", "127.1", "2130706433" })
        {
            using var ipResponse = await client.GetAsync(new Uri("http://" + address + "/private", UriKind.Absolute)).ConfigureAwait(false);
        }
    }

    var payload = telemetry.PreviewJson();
    foreach (var expected in new[]
    {
        "\"name\": \"HTTP GET\"",
        "\"source\": \"http.client.factory\"",
        "\"method\": \"GET\"",
        "\"host\": \"api.example.test\"",
        "\"statusCode\": 503",
        "\"sampled\": true"
    })
    {
        Require(payload.Contains(expected, StringComparison.Ordinal), "missing fixed metadata: " + expected);
    }

    foreach (var blocked in new[]
    {
        "sensitive-client-name",
        "8443",
        "/private",
        "order",
        "code=sample",
        "fragment",
        "https://",
        "http://",
        "127.1",
        "127.0.0.1",
        "2001:db8::1",
        "2130706433",
        "traceparent"
    })
    {
        Require(!payload.Contains(blocked, StringComparison.OrdinalIgnoreCase), "fixed metadata leaked: " + blocked);
    }
}

static void SdkDeliveryIsNeverCorrelated()
{
    var telemetry = NewTelemetryClient();
    var root = NewRoot();
    var deliveryTraceparents = new List<string>();
    var services = new ServiceCollection();
    services
        .AddHttpClient("sdk-delivery")
        .ConfigurePrimaryHttpMessageHandler(() => new RecordingHandler(request =>
        {
            deliveryTraceparents.AddRange(Traceparents(request));
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Accepted));
        }))
        .AddLogBrewCorrelation(telemetry);

    using var provider = services.BuildServiceProvider();
    using var httpClient = provider.GetRequiredService<IHttpClientFactory>().CreateClient("sdk-delivery");
    using var transport = new HttpTransport(new HttpTransportOptions
    {
        Endpoint = new Uri("https://intake.example.test/v1/events", UriKind.Absolute),
        HttpClient = httpClient
    });
    telemetry.Log("evt_self_delivery", "2026-07-20T10:00:00Z", LogAttributes.Create("delivery", "info"));
    using (LogBrewTrace.Activate(root))
    {
        var response = telemetry.Flush(transport);
        Require(response.StatusCode == 202, "expected SDK delivery response");
    }

    Require(deliveryTraceparents.Count == 0, "SDK delivery must not receive correlation header");
    Require(telemetry.PendingEvents() == 0, "SDK delivery must not enqueue a self span");
}

static async Task ResponseAndStreamingContentRemainAppOwned()
{
    var telemetry = NewTelemetryClient();
    var root = NewRoot();
    var content = new RecordingContent();
    using var responseHolder = new ResponseHolder(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
    var services = new ServiceCollection();
    services
        .AddHttpClient("streaming")
        .ConfigurePrimaryHttpMessageHandler(() => new RecordingHandler(_ => Task.FromResult(responseHolder.Response)))
        .AddLogBrewCorrelation(telemetry);

    using var provider = services.BuildServiceProvider();
    using var client = provider.GetRequiredService<IHttpClientFactory>().CreateClient("streaming");
    HttpResponseMessage actual;
    using var request = new HttpRequestMessage(HttpMethod.Get, "https://stream.example.test/value");
    using (LogBrewTrace.Activate(root))
    {
        actual = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false);
    }

    Require(ReferenceEquals(actual, responseHolder.Response), "handler boundary must preserve response identity");
    Require(!content.WasSerialized, "handler boundary must not read streaming content");
    Require(!content.WasDisposed, "handler boundary must not dispose app response content");
}

static async Task OriginalErrorAndCancellationRemainExact()
{
    var telemetry = NewTelemetryClient();
    var root = NewRoot();
    using var cancellationSource = new CancellationTokenSource();
    await cancellationSource.CancelAsync().ConfigureAwait(false);
    var originalError = new InvalidOperationException("app-owned error");
    var originalCancellation = new OperationCanceledException("app-owned cancellation", cancellationSource.Token);
    var calls = 0;
    var services = new ServiceCollection();
    services
        .AddHttpClient("identity")
        .ConfigurePrimaryHttpMessageHandler(() => new RecordingHandler(_ =>
        {
            calls++;
            return calls == 1
                ? Task.FromException<HttpResponseMessage>(originalError)
                : Task.FromException<HttpResponseMessage>(originalCancellation);
        }))
        .AddLogBrewCorrelation(telemetry);

    using var provider = services.BuildServiceProvider();
    using var client = provider.GetRequiredService<IHttpClientFactory>().CreateClient("identity");
    using (LogBrewTrace.Activate(root))
    {
        await RequireExactException(client, CancellationToken.None, originalError).ConfigureAwait(false);
        await RequireExactException(client, cancellationSource.Token, originalCancellation).ConfigureAwait(false);
    }

    var payload = telemetry.PreviewJson();
    Require(payload.Contains("\"errorType\": \"System.InvalidOperationException\"", StringComparison.Ordinal), "expected type-only error");
    Require(payload.Contains("\"errorType\": \"System.OperationCanceledException\"", StringComparison.Ordinal), "expected type-only cancellation");
    Require(payload.Contains("\"cancelled\": true", StringComparison.Ordinal), "expected real cancellation marker");
    Require(!payload.Contains("app-owned", StringComparison.Ordinal), "exception text must remain private");
}

static async Task ActiveParentSetupFailureSendsOnceUntraced()
{
    var telemetry = NewTelemetryClient();
    var root = NewRoot();
    var sendCalls = 0;
    var callbackCalls = 0;
    var observedHeaders = new List<string>();
    var services = new ServiceCollection();
    services
        .AddHttpClient("setup-failure")
        .ConfigurePrimaryHttpMessageHandler(() => new RecordingHandler(request =>
        {
            sendCalls++;
            observedHeaders.AddRange(Traceparents(request));
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK));
        }))
        .AddLogBrewCorrelation(telemetry, options => options
            .WithRequestFilter(_ => throw new InvalidOperationException("tracing-only setup value"))
            .OnError(error =>
            {
                Require(error.Code == "capture_error", "setup failure must use fixed capture class");
                Require(!error.Message.Contains("tracing-only", StringComparison.Ordinal), "setup callback must redact app error");
                callbackCalls++;
            }));

    using var provider = services.BuildServiceProvider();
    using var client = provider.GetRequiredService<IHttpClientFactory>().CreateClient("setup-failure");
    using var request = new HttpRequestMessage(HttpMethod.Get, "https://setup.example.test/private");
    request.Headers.TryAddWithoutValidation("traceparent", CallerTraceparent);
    using (LogBrewTrace.Activate(root))
    using (var response = await client.SendAsync(request).ConfigureAwait(false))
    {
        Require(response.StatusCode == HttpStatusCode.OK, "setup failure must preserve app response");
    }

    Require(sendCalls == 1, "setup failure must send exactly once");
    Require(callbackCalls == 1, "setup failure must report once");
    Require(observedHeaders.SequenceEqual(new[] { CallerTraceparent }), "setup failure must not inject a child header");
    Require(telemetry.PendingEvents() == 0, "setup failure must not emit a partial span");
}

static async Task ConcurrentOutOfOrderRequestsStayIsolated()
{
    var telemetry = NewTelemetryClient();
    var firstRoot = LogBrewTraceContext.FromTraceparent(
        "00-11111111111111111111111111111111-1111111111111111-01",
        "aaaaaaaaaaaaaaaa");
    var secondRoot = LogBrewTraceContext.FromTraceparent(
        "00-22222222222222222222222222222222-2222222222222222-01",
        "bbbbbbbbbbbbbbbb");
    using var handler = new OutOfOrderHandler();
    var services = new ServiceCollection();
    services
        .AddHttpClient("concurrent")
        .ConfigurePrimaryHttpMessageHandler(() => handler)
        .AddLogBrewCorrelation(telemetry);

    using var provider = services.BuildServiceProvider();
    var client = provider.GetRequiredService<IHttpClientFactory>().CreateClient("concurrent");
    try
    {
        var first = SendWithRoot(client, firstRoot, "first", "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1111111111111111-01");
        await handler.FirstStarted.Task.ConfigureAwait(false);
        var second = SendWithRoot(client, secondRoot, "second", "00-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-2222222222222222-01");
        await handler.SecondStarted.Task.ConfigureAwait(false);
        handler.ReleaseSecond.TrySetResult(true);
        await second.ConfigureAwait(false);
        Require(!first.IsCompleted, "first request must remain independent when second completes first");
        handler.ReleaseFirst.TrySetResult(true);
        await first.ConfigureAwait(false);
    }
    finally
    {
        client.Dispose();
    }

    Require(handler.Traceparents.Count == 2, "concurrent sends must each inject one child");
    Require(handler.Traceparents.Distinct(StringComparer.Ordinal).Count() == 2, "concurrent sends must use distinct children");
    Require(handler.Traceparents.Any(value => value.StartsWith("00-11111111111111111111111111111111-", StringComparison.Ordinal)), "first child must retain first trace");
    Require(handler.Traceparents.Any(value => value.StartsWith("00-22222222222222222222222222222222-", StringComparison.Ordinal)), "second child must retain second trace");
    var payload = telemetry.PreviewJson();
    Require(payload.Contains("\"traceId\": \"11111111111111111111111111111111\"", StringComparison.Ordinal), "first span must retain first trace");
    Require(payload.Contains("\"traceId\": \"22222222222222222222222222222222\"", StringComparison.Ordinal), "second span must retain second trace");
}

static async Task SendWithRoot(HttpClient client, LogBrewTraceContext root, string requestName, string callerTraceparent)
{
    using var request = new HttpRequestMessage(HttpMethod.Get, new Uri("https://concurrent.example.test/" + requestName, UriKind.Absolute));
    request.Headers.TryAddWithoutValidation("traceparent", callerTraceparent);
    using (LogBrewTrace.Activate(root))
    using (var response = await client.SendAsync(request).ConfigureAwait(false))
    {
        Require(response.StatusCode == HttpStatusCode.OK, "concurrent response must remain exact");
        Require(ReferenceEquals(LogBrewTrace.Current, root), "caller trace must be active after handler completion");
    }

    Require(Traceparents(request).SequenceEqual(new[] { callerTraceparent }), "concurrent request must reset its own header");
}

static async Task RetryMiddlewareCreatesOneChildPerExecution()
{
    var telemetry = NewTelemetryClient();
    var root = NewRoot();
    var attempts = 0;
    var traceparents = new List<string>();
    var services = new ServiceCollection();
    services
        .AddHttpClient("retry")
        .AddHttpMessageHandler(() => new RetryOnceHandler())
        .ConfigurePrimaryHttpMessageHandler(() => new RecordingHandler(request =>
        {
            attempts++;
            traceparents.AddRange(Traceparents(request));
            return Task.FromResult(new HttpResponseMessage(
                attempts == 1 ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.Accepted));
        }))
        .AddLogBrewCorrelation(telemetry);

    using var provider = services.BuildServiceProvider();
    using var client = provider.GetRequiredService<IHttpClientFactory>().CreateClient("retry");
    using var request = new HttpRequestMessage(HttpMethod.Post, "https://retry.example.test/value");
    request.Headers.TryAddWithoutValidation("traceparent", CallerTraceparent);
    HttpResponseMessage response;
    using (LogBrewTrace.Activate(root))
    {
        response = await client.SendAsync(request).ConfigureAwait(false);
    }

    using (response)
    {
        Require(response.StatusCode == HttpStatusCode.Accepted, "retry middleware response must remain app-owned");
    }

    Require(attempts == 2, "retry middleware must execute the primary handler twice");
    Require(traceparents.Count == 2, "each retry execution must inject exactly one child");
    Require(traceparents.Distinct(StringComparer.Ordinal).Count() == 2, "retry executions must use distinct child spans");
    Require(Traceparents(request).SequenceEqual(new[] { CallerTraceparent }), "retry completion must reset caller header");
    var payload = telemetry.PreviewJson();
    Require(Count(payload, "\"type\": \"span\"") == 2, "retry executions must capture two spans");
    Require(payload.Contains("\"statusCode\": 503", StringComparison.Ordinal), "retry first execution must capture 503");
    Require(payload.Contains("\"statusCode\": 202", StringComparison.Ordinal), "retry second execution must capture 202");
    foreach (var traceparent in traceparents)
    {
        Require(payload.Contains("\"spanId\": \"" + traceparent.Split('-')[2] + "\"", StringComparison.Ordinal), "propagated retry child must match captured span");
    }
}

static async Task RequireExactException(HttpClient client, CancellationToken cancellationToken, Exception expected)
{
    using var request = new HttpRequestMessage(HttpMethod.Get, "https://errors.example.test/value");
    try
    {
        await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
        throw new InvalidOperationException("expected app-owned exception");
    }
    catch (Exception error) when (ReferenceEquals(error, expected))
    {
    }
}

static LogBrewClient NewTelemetryClient()
{
    return LogBrewClient.Create("LOGBREW_API_KEY", "httpclient-correlation-tests", "0.1.0");
}

static LogBrewTraceContext NewRoot()
{
    return LogBrewTraceContext.FromTraceparent(IncomingTraceparent, "b7ad6b7169203331");
}

static IReadOnlyList<string> Traceparents(HttpRequestMessage request)
{
    return request.Headers.TryGetValues("traceparent", out var values)
        ? values.ToList()
        : Array.Empty<string>();
}

static int Count(string value, string needle)
{
    var count = 0;
    var index = 0;
    while ((index = value.IndexOf(needle, index, StringComparison.Ordinal)) >= 0)
    {
        count++;
        index += needle.Length;
    }

    return count;
}

static void Require(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException(message);
    }
}

internal sealed class TypedApi
{
    private readonly HttpClient client;

    public TypedApi(HttpClient client)
    {
        this.client = client;
    }

    internal Task<HttpResponseMessage> GetAsync()
    {
        return client.GetAsync(new Uri("https://typed.example.test/resource", UriKind.Absolute));
    }
}

internal sealed class RecordingHandler : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, Task<HttpResponseMessage>> send;

    internal RecordingHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> send)
    {
        this.send = send;
    }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        return send(request);
    }
}

internal sealed class RecordingContent : HttpContent
{
    internal bool WasDisposed { get; private set; }

    internal bool WasSerialized { get; private set; }

    protected override Task SerializeToStreamAsync(System.IO.Stream stream, TransportContext? context)
    {
        WasSerialized = true;
        return Task.CompletedTask;
    }

    protected override bool TryComputeLength(out long length)
    {
        length = 0;
        return false;
    }

    protected override void Dispose(bool disposing)
    {
        WasDisposed = true;
        base.Dispose(disposing);
    }
}

internal sealed class ResponseHolder : IDisposable
{
    internal ResponseHolder(HttpResponseMessage response)
    {
        Response = response;
    }

    internal HttpResponseMessage Response { get; }

    public void Dispose()
    {
        Response.Dispose();
    }
}

internal sealed class OutOfOrderHandler : HttpMessageHandler
{
    internal TaskCompletionSource<bool> FirstStarted { get; } = NewCompletionSource();

    internal TaskCompletionSource<bool> SecondStarted { get; } = NewCompletionSource();

    internal TaskCompletionSource<bool> ReleaseFirst { get; } = NewCompletionSource();

    internal TaskCompletionSource<bool> ReleaseSecond { get; } = NewCompletionSource();

    internal List<string> Traceparents { get; } = new List<string>();

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var traceparent = request.Headers.GetValues("traceparent").Single();
        lock (Traceparents)
        {
            Traceparents.Add(traceparent);
        }

        if (request.RequestUri?.AbsolutePath == "/first")
        {
            FirstStarted.TrySetResult(true);
            await ReleaseFirst.Task.ConfigureAwait(false);
        }
        else
        {
            SecondStarted.TrySetResult(true);
            await ReleaseSecond.Task.ConfigureAwait(false);
        }

        return new HttpResponseMessage(HttpStatusCode.OK);
    }

    private static TaskCompletionSource<bool> NewCompletionSource()
    {
        return new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
    }
}

internal sealed class RetryOnceHandler : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var first = await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
        if (first.StatusCode != HttpStatusCode.ServiceUnavailable)
        {
            return first;
        }

        first.Dispose();
        return await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
    }
}
