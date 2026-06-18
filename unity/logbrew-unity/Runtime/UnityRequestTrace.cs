#nullable enable

using System;
using System.Collections.Generic;

namespace LogBrew.Unity
{
    public sealed class UnityRequestSpan
    {
        internal UnityRequestSpan(LogBrewTraceContext traceContext, string method, string routeTemplate)
        {
            TraceContext = traceContext;
            Method = method;
            RouteTemplate = routeTemplate;
        }

        public LogBrewTraceContext TraceContext { get; }

        public string Method { get; }

        public string RouteTemplate { get; }

        public IReadOnlyDictionary<string, string> Headers
        {
            get { return TraceContext.Headers; }
        }
    }

    public sealed class UnityTrackedRequest
    {
        internal UnityTrackedRequest(UnityRequestSpan requestSpan, double startedAtMs)
        {
            RequestSpan = requestSpan;
            StartedAtMs = startedAtMs;
        }

        public UnityRequestSpan RequestSpan { get; }

        public double StartedAtMs { get; }

        public IReadOnlyDictionary<string, string> Headers
        {
            get { return RequestSpan.Headers; }
        }
    }

    public sealed class UnityRequestTimings
    {
        private readonly Dictionary<string, object?> values = new Dictionary<string, object?>();

        private UnityRequestTimings()
        {
        }

        public static UnityRequestTimings Create()
        {
            return new UnityRequestTimings();
        }

        public UnityRequestTimings WithQueuedMs(double queuedMs)
        {
            return WithDuration("requestQueuedMs", queuedMs);
        }

        public UnityRequestTimings WithNameLookupMs(double nameLookupMs)
        {
            return WithDuration("requestNameLookupMs", nameLookupMs);
        }

        public UnityRequestTimings WithConnectMs(double connectMs)
        {
            return WithDuration("requestConnectMs", connectMs);
        }

        public UnityRequestTimings WithTlsMs(double tlsMs)
        {
            return WithDuration("requestTlsMs", tlsMs);
        }

        public UnityRequestTimings WithSendMs(double sendMs)
        {
            return WithDuration("requestSendMs", sendMs);
        }

        public UnityRequestTimings WithWaitMs(double waitMs)
        {
            return WithDuration("requestWaitMs", waitMs);
        }

        public UnityRequestTimings WithReceiveMs(double receiveMs)
        {
            return WithDuration("requestReceiveMs", receiveMs);
        }

        public UnityRequestTimings WithResponseBodyBytes(long responseBodyBytes)
        {
            if (responseBodyBytes < 0)
            {
                throw new SdkException("validation_error", "unity request responseBodyBytes must be non-negative");
            }

            values["responseBodyBytes"] = responseBodyBytes;
            return this;
        }

        internal IDictionary<string, object?> ToMetadata()
        {
            return new Dictionary<string, object?>(values);
        }

        private UnityRequestTimings WithDuration(string key, double value)
        {
            if (value < 0 || double.IsNaN(value) || double.IsInfinity(value))
            {
                throw new SdkException("validation_error", "unity request timing values must be non-negative");
            }

            values[key] = value;
            return this;
        }
    }

    public sealed class UnityRequestTracker
    {
        private readonly LogBrewClient client;
        private readonly Func<string> idFactory;
        private readonly Func<string> timestampFactory;
        private readonly Func<double> realtimeMilliseconds;
        private readonly UnityContext? context;

        public UnityRequestTracker(
            LogBrewClient client,
            Func<string> idFactory,
            Func<string> timestampFactory,
            Func<double> realtimeMilliseconds,
            UnityContext? context = null)
        {
            this.client = client ?? throw new ArgumentNullException(nameof(client));
            this.idFactory = idFactory ?? throw new ArgumentNullException(nameof(idFactory));
            this.timestampFactory = timestampFactory ?? throw new ArgumentNullException(nameof(timestampFactory));
            this.realtimeMilliseconds = realtimeMilliseconds ?? throw new ArgumentNullException(nameof(realtimeMilliseconds));
            this.context = context;
            ValidateRequestClock(this.realtimeMilliseconds());
        }

        public UnityTrackedRequest Start(
            string method,
            string routeTemplate,
            Action<string, string>? setRequestHeader = null,
            LogBrewTraceContext? traceContext = null)
        {
            var requestSpan = LogBrewUnity.StartRequestSpan(method, routeTemplate, traceContext);
            if (setRequestHeader != null)
            {
                foreach (var header in requestSpan.Headers)
                {
                    setRequestHeader(header.Key, header.Value);
                }
            }

            return new UnityTrackedRequest(requestSpan, ValidateRequestClock(realtimeMilliseconds()));
        }

        public void Capture(
            UnityTrackedRequest request,
            int? statusCode = null,
            string? errorType = null,
            UnityContext? context = null,
            UnityRequestTimings? timings = null)
        {
            if (request == null)
            {
                throw new ArgumentNullException(nameof(request));
            }

            var elapsedMs = Math.Max(0, ValidateRequestClock(realtimeMilliseconds()) - request.StartedAtMs);
            LogBrewUnity.CaptureRequestSpanWithMetadata(
                client,
                idFactory(),
                timestampFactory(),
                request.RequestSpan,
                statusCode,
                elapsedMs,
                errorType,
                MetadataFor(context, timings));
        }

        private Dictionary<string, object?> MetadataFor(UnityContext? currentContext, UnityRequestTimings? timings)
        {
            var metadata = LogBrewUnity.MetadataFromContext(context);
            if (currentContext != null)
            {
                foreach (var item in currentContext.ToMetadata())
                {
                    metadata[item.Key] = item.Value;
                }
            }

            LogBrewUnity.AddRequestTimings(metadata, timings);
            return metadata;
        }

        private static double ValidateRequestClock(double value)
        {
            if (double.IsNaN(value) || double.IsInfinity(value))
            {
                throw new SdkException("validation_error", "unity request realtimeMilliseconds must be finite");
            }

            return value;
        }
    }

    public static partial class LogBrewUnity
    {
        public static UnityRequestSpan StartRequestSpan(
            string method,
            string routeTemplate,
            LogBrewTraceContext? context = null)
        {
            if (method == null)
            {
                throw new ArgumentNullException(nameof(method));
            }

            if (routeTemplate == null)
            {
                throw new ArgumentNullException(nameof(routeTemplate));
            }

            var normalizedMethod = NormalizeRequestMethod(method);
            var normalizedRouteTemplate = NormalizeRouteTemplate(routeTemplate);
            var parentContext = context ?? LogBrewTrace.Current;
            var requestContext = parentContext == null
                ? LogBrewTraceContext.CreateRoot()
                : LogBrewTraceContext.CreateChild(parentContext);
            return new UnityRequestSpan(requestContext, normalizedMethod, normalizedRouteTemplate);
        }

        public static void CaptureRequestSpan(
            LogBrewClient client,
            string id,
            string timestamp,
            UnityRequestSpan requestSpan,
            int? statusCode = null,
            double? durationMs = null,
            string? errorType = null,
            UnityContext? context = null,
            UnityRequestTimings? timings = null)
        {
            if (client == null)
            {
                throw new ArgumentNullException(nameof(client));
            }

            if (requestSpan == null)
            {
                throw new ArgumentNullException(nameof(requestSpan));
            }

            CaptureRequestSpanWithMetadata(
                client,
                id,
                timestamp,
                requestSpan,
                statusCode,
                durationMs,
                errorType,
                MetadataWithTimings(context, timings));
        }

        internal static void CaptureRequestSpanWithMetadata(
            LogBrewClient client,
            string id,
            string timestamp,
            UnityRequestSpan requestSpan,
            int? statusCode,
            double? durationMs,
            string? errorType,
            IDictionary<string, object?> metadata)
        {
            ValidateStatusCode(statusCode);
            ValidateRequestDuration(durationMs);
            metadata["source"] = "unity.request";
            metadata["method"] = requestSpan.Method;
            metadata["routeTemplate"] = requestSpan.RouteTemplate;
            if (statusCode.HasValue)
            {
                metadata["statusCode"] = statusCode.Value;
            }

            var normalizedErrorType = NormalizeOptionalErrorType(errorType);
            if (normalizedErrorType != null)
            {
                metadata["errorType"] = normalizedErrorType;
            }

            client.Span(
                id,
                timestamp,
                LogBrewTrace.SpanAttributes(
                    requestSpan.Method + " " + requestSpan.RouteTemplate,
                    RequestStatus(statusCode, normalizedErrorType),
                    durationMs,
                    metadata,
                    requestSpan.TraceContext));
        }

        private static Dictionary<string, object?> MetadataWithTimings(UnityContext? context, UnityRequestTimings? timings)
        {
            var metadata = MetadataFromContext(context);
            AddRequestTimings(metadata, timings);
            return metadata;
        }

        internal static void AddRequestTimings(Dictionary<string, object?> metadata, UnityRequestTimings? timings)
        {
            if (timings != null)
            {
                foreach (var item in timings.ToMetadata())
                {
                    metadata[item.Key] = item.Value;
                }
            }
        }

        private static string NormalizeRequestMethod(string method)
        {
            Validation.RequireNonEmpty("unity request method", method);
            return method.Trim().ToUpperInvariant();
        }

        private static string NormalizeRouteTemplate(string routeTemplate)
        {
            Validation.RequireNonEmpty("unity request routeTemplate", routeTemplate);
            var trimmed = routeTemplate.Trim();
            if (Uri.TryCreate(trimmed, UriKind.Absolute, out var uri)
                && (string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)
                    || string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)))
            {
                return RequireNormalizedRoute(StripQueryAndFragment(uri.AbsolutePath));
            }

            if (trimmed.Contains("://", StringComparison.Ordinal))
            {
                throw new SdkException("validation_error", "unity request routeTemplate must be a route template or HTTP(S) URL");
            }

            return RequireNormalizedRoute(StripQueryAndFragment(trimmed));
        }

        private static string StripQueryAndFragment(string value)
        {
            var end = value.Length;
            var queryIndex = value.IndexOf('?', StringComparison.Ordinal);
            if (queryIndex >= 0 && queryIndex < end)
            {
                end = queryIndex;
            }

            var fragmentIndex = value.IndexOf('#', StringComparison.Ordinal);
            if (fragmentIndex >= 0 && fragmentIndex < end)
            {
                end = fragmentIndex;
            }

            return value.Substring(0, end).Trim();
        }

        private static string RequireNormalizedRoute(string value)
        {
            Validation.RequireNonEmpty("unity request routeTemplate", value);
            return value.StartsWith('/') ? value : "/" + value;
        }

        private static void ValidateStatusCode(int? statusCode)
        {
            if (statusCode.HasValue && (statusCode.Value < 100 || statusCode.Value > 599))
            {
                throw new SdkException("validation_error", "unity request statusCode must be between 100 and 599");
            }
        }

        private static void ValidateRequestDuration(double? durationMs)
        {
            if (durationMs.HasValue && (durationMs.Value < 0 || double.IsNaN(durationMs.Value) || double.IsInfinity(durationMs.Value)))
            {
                throw new SdkException("validation_error", "unity request durationMs must be non-negative");
            }
        }

        private static string? NormalizeOptionalErrorType(string? errorType)
        {
            if (errorType == null)
            {
                return null;
            }

            Validation.RequireNonEmpty("unity request errorType", errorType);
            return errorType.Trim();
        }

        private static string RequestStatus(int? statusCode, string? errorType)
        {
            return errorType != null || (statusCode.HasValue && statusCode.Value >= 400) ? "error" : "ok";
        }
    }
}
