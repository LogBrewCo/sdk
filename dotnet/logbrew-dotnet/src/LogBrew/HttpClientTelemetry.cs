using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace LogBrew
{
    public sealed class LogBrewHttpClientOptions
    {
        internal string EventIdPrefix { get; private set; } = "dotnet_http_client";

        internal string? RouteTemplate { get; private set; }

        internal IDictionary<string, object?>? Metadata { get; private set; }

        internal Func<string> TimestampProvider { get; private set; } = DefaultTimestamp;

        internal Action<SdkException>? OnErrorHandler { get; private set; }

        public static LogBrewHttpClientOptions Create()
        {
            return new LogBrewHttpClientOptions();
        }

        public LogBrewHttpClientOptions WithEventIdPrefix(string value)
        {
            Validation.RequireNonEmpty("HTTP client eventIdPrefix", value);
            EventIdPrefix = value.Trim();
            return this;
        }

        public LogBrewHttpClientOptions WithRouteTemplate(string value)
        {
            RouteTemplate = NormalizeRouteTemplate(value);
            return this;
        }

        public LogBrewHttpClientOptions WithMetadata(IDictionary<string, object?> value)
        {
            Metadata = value;
            return this;
        }

        public LogBrewHttpClientOptions WithTimestampProvider(Func<string> value)
        {
            TimestampProvider = value ?? throw new ArgumentNullException(nameof(value));
            return this;
        }

        public LogBrewHttpClientOptions OnError(Action<SdkException> value)
        {
            OnErrorHandler = value;
            return this;
        }

        internal static string NormalizeRouteTemplate(string routeTemplate)
        {
            return TimelineMetadata.SanitizeRouteTemplate("HTTP client routeTemplate", routeTemplate);
        }

        private static string DefaultTimestamp()
        {
            return DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture);
        }
    }

    public static class LogBrewHttpClientTelemetry
    {
        public static async Task<HttpResponseMessage> SendAsync(
            LogBrewClient client,
            HttpClient httpClient,
            HttpRequestMessage request,
            LogBrewHttpClientOptions? options = null,
            CancellationToken cancellation = default)
        {
            if (client == null)
            {
                throw new ArgumentNullException(nameof(client));
            }

            if (httpClient == null)
            {
                throw new ArgumentNullException(nameof(httpClient));
            }

            if (request == null)
            {
                throw new ArgumentNullException(nameof(request));
            }

            var safeOptions = options ?? LogBrewHttpClientOptions.Create();
            var method = NormalizeMethod(request.Method?.Method);
            var routeTemplate = safeOptions.RouteTemplate ?? RouteTemplateFromRequest(request);
            var trace = CreateChildTrace();
            var startedAt = Stopwatch.GetTimestamp();
            HttpResponseMessage? response = null;
            Exception? requestError = null;

            using (LogBrewTrace.Activate(trace))
            {
                InjectTraceparent(request, trace);
                try
                {
                    response = await httpClient.SendAsync(request, cancellation).ConfigureAwait(false);
                    return response;
                }
                catch (Exception error)
                {
                    requestError = error;
                    throw;
                }
                finally
                {
                    CaptureSpan(client, method, routeTemplate, trace, response, requestError, startedAt, safeOptions);
                }
            }
        }

        private static LogBrewTraceContext CreateChildTrace()
        {
            var current = LogBrewTrace.Current;
            if (current != null)
            {
                return LogBrewTraceContext.CreateChild(current);
            }

            if (LogBrewTraceContext.TryCreateChildFromCurrentActivity(out var activityContext) && activityContext != null)
            {
                return activityContext;
            }

            return LogBrewTraceContext.CreateRoot();
        }

        private static void InjectTraceparent(HttpRequestMessage request, LogBrewTraceContext trace)
        {
            request.Headers.Remove("traceparent");
            if (!request.Headers.TryAddWithoutValidation("traceparent", trace.Traceparent))
            {
                throw new SdkException("configuration_error", "invalid HTTP client traceparent header");
            }
        }

        private static void CaptureSpan(
            LogBrewClient client,
            string method,
            string routeTemplate,
            LogBrewTraceContext trace,
            HttpResponseMessage? response,
            Exception? requestError,
            long startedAt,
            LogBrewHttpClientOptions options)
        {
            var metadata = TelemetryMetadata.CopySafeDependencyMetadata(options.Metadata);
            metadata["source"] = "http.client";
            metadata["method"] = method;
            metadata["routeTemplate"] = routeTemplate;
            metadata["sampled"] = trace.Sampled;
            if (response != null)
            {
                metadata["statusCode"] = (int)response.StatusCode;
            }

            if (requestError != null)
            {
                metadata["errorType"] = requestError.GetType().FullName;
            }

            var status = requestError == null && (response == null || (int)response.StatusCode < 500) ? "ok" : "error";
            var attributes = SpanAttributes.Create("HTTP " + method + " " + routeTemplate, trace.TraceId, trace.SpanId, status)
                .WithDurationMs(ElapsedMilliseconds(startedAt))
                .WithMetadata(metadata);
            if (trace.ParentSpanId != null)
            {
                attributes.WithParentSpanId(trace.ParentSpanId);
            }

            try
            {
                client.Span(
                    options.EventIdPrefix + "_span_" + trace.SpanId,
                    options.TimestampProvider(),
                    attributes);
            }
            catch (SdkException error)
            {
                ReportCaptureError(options.OnErrorHandler, error);
            }
        }

        private static void ReportCaptureError(Action<SdkException>? onError, SdkException error)
        {
            if (onError == null)
            {
                return;
            }

            try
            {
                onError(error);
            }
            catch
            {
                // Preserve the app-owned HTTP result even if diagnostics handling fails.
            }
        }

        private static double ElapsedMilliseconds(long startedAt)
        {
            return (Stopwatch.GetTimestamp() - startedAt) * 1000.0 / Stopwatch.Frequency;
        }

        private static string RouteTemplateFromRequest(HttpRequestMessage request)
        {
            var requestUri = request.RequestUri;
            if (requestUri == null)
            {
                return "/";
            }

            return LogBrewHttpClientOptions.NormalizeRouteTemplate(requestUri.IsAbsoluteUri ? requestUri.AbsolutePath : requestUri.ToString());
        }

        private static string NormalizeMethod(string? method)
        {
            Validation.RequireNonEmpty("HTTP client request method", method);
            var normalized = method!.Trim().ToUpperInvariant();
            for (var index = 0; index < normalized.Length; index++)
            {
                var character = normalized[index];
                if (!IsMethodCharacter(character))
                {
                    throw new SdkException("validation_error", "HTTP client request method must be a valid HTTP method");
                }
            }

            return normalized;
        }

        private static bool IsMethodCharacter(char character)
        {
            return (character >= 'A' && character <= 'Z')
                || (character >= '0' && character <= '9')
                || character == '-'
                || character == '_';
        }
    }
}
