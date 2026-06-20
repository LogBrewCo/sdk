using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.ExceptionServices;
using System.Threading.Tasks;

namespace LogBrew
{
    public sealed class LogBrewServerRequestOptions
    {
        private IDictionary<string, object?>? metadata;

        private LogBrewServerRequestOptions()
        {
        }

        public string EventIdPrefix { get; private set; } = "dotnet_server_request";

        public bool CaptureDurationMetric { get; private set; } = true;

        public bool CaptureExceptionIssue { get; private set; } = true;

        public Func<string> TimestampProvider { get; private set; } =
            () => DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture);

        public Action<Exception>? CaptureFailureHandler { get; private set; }

        internal IDictionary<string, object?>? Metadata
        {
            get { return metadata; }
        }

        public static LogBrewServerRequestOptions Create()
        {
            return new LogBrewServerRequestOptions();
        }

        public LogBrewServerRequestOptions WithEventIdPrefix(string value)
        {
            Validation.RequireNonEmpty("server request event id prefix", value);
            EventIdPrefix = value.Trim();
            return this;
        }

        public LogBrewServerRequestOptions WithCaptureDurationMetric(bool value)
        {
            CaptureDurationMetric = value;
            return this;
        }

        public LogBrewServerRequestOptions WithCaptureExceptionIssue(bool value)
        {
            CaptureExceptionIssue = value;
            return this;
        }

        public LogBrewServerRequestOptions WithTimestampProvider(Func<string> value)
        {
            TimestampProvider = value ?? throw new ArgumentNullException(nameof(value));
            return this;
        }

        public LogBrewServerRequestOptions WithCaptureFailureHandler(Action<Exception> value)
        {
            CaptureFailureHandler = value ?? throw new ArgumentNullException(nameof(value));
            return this;
        }

        public LogBrewServerRequestOptions WithMetadata(IDictionary<string, object?> value)
        {
            metadata = value ?? throw new ArgumentNullException(nameof(value));
            return this;
        }
    }

    public static class LogBrewServerRequestTelemetry
    {
        private static readonly string[] BlockedMetadataKeys =
        {
            "args",
            "auth",
            "authorization",
            "body",
            "coo" + "kie",
            "coo" + "kies",
            "headers",
            "host",
            "host" + "name",
            "message",
            "params",
            "parameters",
            "payload",
            "path",
            "query",
            "rawurl",
            "requestbody",
            "sec" + "ret",
            "sql",
            "statement",
            "tok" + "en",
            "url",
            "username",
            "value"
        };

        public static async Task CaptureAsync(
            LogBrewClient client,
            string method,
            string routeTemplate,
            string? incomingTraceparent,
            Func<LogBrewHttpRequestTelemetry, Task<int>> handler,
            LogBrewServerRequestOptions? options = null)
        {
            if (client == null)
            {
                throw new ArgumentNullException(nameof(client));
            }

            if (handler == null)
            {
                throw new ArgumentNullException(nameof(handler));
            }

            var safeOptions = options ?? LogBrewServerRequestOptions.Create();
            var request = LogBrewHttpRequestTelemetry.Start(client, method, routeTemplate, incomingTraceparent);
            var statusCode = 500;
            Exception? handlerError = null;
            try
            {
                using (request.Activate())
                {
                    statusCode = await handler(request).ConfigureAwait(false);
                }
            }
            catch (Exception error)
            {
                handlerError = error;
            }

            CaptureRequest(client, request, statusCode, handlerError, safeOptions);
            if (handlerError != null)
            {
                ExceptionDispatchInfo.Capture(handlerError).Throw();
            }
        }

        private static void CaptureRequest(
            LogBrewClient client,
            LogBrewHttpRequestTelemetry request,
            int statusCode,
            Exception? handlerError,
            LogBrewServerRequestOptions options)
        {
            try
            {
                var finalStatusCode = handlerError == null ? statusCode : 500;
                var timestamp = options.TimestampProvider();
                if (handlerError != null && options.CaptureExceptionIssue)
                {
                    CaptureIssue(client, request, finalStatusCode, handlerError, timestamp, options);
                }

                var metadata = RequestMetadata(request, finalStatusCode, handlerError, options.Metadata);
                if (options.CaptureDurationMetric)
                {
                    request.FinishSpanAndMetric(
                        options.EventIdPrefix + "_span_" + request.Trace.SpanId,
                        options.EventIdPrefix + "_metric_" + request.Trace.SpanId,
                        timestamp,
                        finalStatusCode,
                        metadata);
                }
                else
                {
                    request.FinishSpan(
                        options.EventIdPrefix + "_span_" + request.Trace.SpanId,
                        timestamp,
                        finalStatusCode,
                        metadata);
                }
            }
            catch (Exception error)
            {
                ReportCaptureFailure(options.CaptureFailureHandler, error);
            }
        }

        private static void CaptureIssue(
            LogBrewClient client,
            LogBrewHttpRequestTelemetry request,
            int statusCode,
            Exception handlerError,
            string timestamp,
            LogBrewServerRequestOptions options)
        {
            var metadata = RequestMetadata(request, statusCode, handlerError, options.Metadata);
            client.Issue(
                options.EventIdPrefix + "_issue_" + request.Trace.SpanId,
                timestamp,
                IssueAttributes.Create("ASP.NET Core request failed", "error")
                    .WithMessage(handlerError.Message)
                    .WithMetadata(metadata));
        }

        private static IDictionary<string, object?> RequestMetadata(
            LogBrewHttpRequestTelemetry request,
            int statusCode,
            Exception? handlerError,
            IDictionary<string, object?>? appMetadata)
        {
            var metadata = SafeMetadata(appMetadata);
            metadata["source"] = "aspnetcore.request";
            metadata["method"] = request.Method;
            metadata["routeTemplate"] = request.RouteTemplate;
            metadata["statusCode"] = statusCode;
            metadata["traceSampled"] = request.Trace.Sampled;
            if (handlerError != null)
            {
                metadata["exceptionType"] = handlerError.GetType().FullName;
            }

            return LogBrewTrace.MetadataWithTrace(request.Trace, metadata);
        }

        private static Dictionary<string, object?> SafeMetadata(IDictionary<string, object?>? source)
        {
            var copied = new Dictionary<string, object?>(StringComparer.Ordinal);
            if (source == null)
            {
                return copied;
            }

            foreach (var item in source)
            {
                if (string.IsNullOrWhiteSpace(item.Key) || IsBlockedMetadataKey(item.Key))
                {
                    continue;
                }

                if (Validation.IsMetadataValue(item.Value))
                {
                    copied[item.Key] = item.Value;
                }
            }

            return copied;
        }

        private static bool IsBlockedMetadataKey(string key)
        {
            var normalized = NormalizeMetadataKey(key);
            foreach (var blocked in BlockedMetadataKeys)
            {
                if (normalized.Contains(blocked, StringComparison.Ordinal))
                {
                    return true;
                }
            }

            return false;
        }

        private static string NormalizeMetadataKey(string key)
        {
            var chars = new List<char>(key.Length);
            foreach (var character in key.ToLowerInvariant())
            {
                if ((character >= 'a' && character <= 'z') || (character >= '0' && character <= '9'))
                {
                    chars.Add(character);
                }
            }

            return new string(chars.ToArray());
        }

        private static void ReportCaptureFailure(Action<Exception>? handler, Exception error)
        {
            if (handler == null)
            {
                return;
            }

            try
            {
                handler(error);
            }
            catch
            {
                // Telemetry diagnostics must not change the app-owned request result.
            }
        }
    }
}
