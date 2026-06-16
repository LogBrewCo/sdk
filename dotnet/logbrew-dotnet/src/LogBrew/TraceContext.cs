using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Threading;

namespace LogBrew
{
    public sealed class LogBrewTraceContext
    {
        private const string ZeroTraceId = "00000000000000000000000000000000";
        private const string ZeroSpanId = "0000000000000000";
        private static readonly char[] LowerHex = "0123456789abcdef".ToCharArray();

        private LogBrewTraceContext(string traceId, string spanId, string? parentSpanId, string traceFlags)
        {
            TraceId = NormalizeTraceId(traceId);
            SpanId = NormalizeSpanId("spanId", spanId);
            ParentSpanId = parentSpanId == null ? null : NormalizeSpanId("parentSpanId", parentSpanId);
            TraceFlags = NormalizeTraceFlags(traceFlags);
            Sampled = (Convert.ToInt32(TraceFlags, 16) & 1) == 1;
        }

        public string TraceId { get; }

        public string SpanId { get; }

        public string? ParentSpanId { get; }

        public string TraceFlags { get; }

        public bool Sampled { get; }

        public string Traceparent
        {
            get { return global::LogBrew.Traceparent.Create(TraceId, SpanId, TraceFlags); }
        }

        public IReadOnlyDictionary<string, string> Headers
        {
            get { return global::LogBrew.Traceparent.CreateHeaders(TraceId, SpanId, TraceFlags); }
        }

        public static LogBrewTraceContext CreateRoot()
        {
            return new LogBrewTraceContext(GenerateTraceId(), GenerateSpanId(), null, "01");
        }

        public static LogBrewTraceContext CreateRoot(string traceFlags)
        {
            return new LogBrewTraceContext(GenerateTraceId(), GenerateSpanId(), null, traceFlags);
        }

        public static LogBrewTraceContext FromTraceparent(string traceparent)
        {
            var context = global::LogBrew.Traceparent.Parse(traceparent);
            return new LogBrewTraceContext(context.TraceId, GenerateSpanId(), context.ParentSpanId, context.TraceFlags);
        }

        public static LogBrewTraceContext FromTraceparent(string traceparent, string spanId)
        {
            var context = global::LogBrew.Traceparent.Parse(traceparent);
            return new LogBrewTraceContext(context.TraceId, spanId, context.ParentSpanId, context.TraceFlags);
        }

        public static LogBrewTraceContext CreateChild(LogBrewTraceContext parent)
        {
            if (parent == null)
            {
                throw new ArgumentNullException(nameof(parent));
            }

            return new LogBrewTraceContext(parent.TraceId, GenerateSpanId(), parent.SpanId, parent.TraceFlags);
        }

        public static bool TryFromTraceparent(string? traceparent, out LogBrewTraceContext? context)
        {
            context = null;
            if (string.IsNullOrWhiteSpace(traceparent))
            {
                return false;
            }

            try
            {
                context = FromTraceparent(traceparent!);
                return true;
            }
            catch (SdkException)
            {
                return false;
            }
        }

        public IReadOnlyDictionary<string, object?> ToMetadata()
        {
            var metadata = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["traceId"] = TraceId,
                ["spanId"] = SpanId,
                ["traceFlags"] = TraceFlags,
                ["traceSampled"] = Sampled
            };
            if (ParentSpanId != null)
            {
                metadata["parentSpanId"] = ParentSpanId;
            }

            return metadata;
        }

        internal static LogBrewTraceContext FromIncomingTraceparentOrCreateRoot(string? traceparent)
        {
            return TryFromTraceparent(traceparent, out var context) && context != null ? context : CreateRoot();
        }

        private static string GenerateTraceId()
        {
            return GenerateNonZeroHex(16, ZeroTraceId);
        }

        private static string GenerateSpanId()
        {
            return GenerateNonZeroHex(8, ZeroSpanId);
        }

        private static string GenerateNonZeroHex(int byteCount, string zeroValue)
        {
            var bytes = new byte[byteCount];
            string value;
            using (var random = RandomNumberGenerator.Create())
            {
                do
                {
                    random.GetBytes(bytes);
                    value = ToLowerHex(bytes);
                }
                while (string.Equals(value, zeroValue, StringComparison.Ordinal));
            }

            return value;
        }

        private static string ToLowerHex(byte[] bytes)
        {
            var chars = new char[bytes.Length * 2];
            for (var index = 0; index < bytes.Length; index++)
            {
                var value = bytes[index];
                chars[index * 2] = LowerHex[value >> 4];
                chars[(index * 2) + 1] = LowerHex[value & 0x0f];
            }

            return new string(chars);
        }

        private static string NormalizeTraceId(string traceId)
        {
            Validation.RequireNonEmpty("traceId", traceId);
            var normalized = traceId.Trim().ToLowerInvariant();
            global::LogBrew.Traceparent.Create(normalized, "1111111111111111", "01");
            return normalized;
        }

        private static string NormalizeSpanId(string label, string spanId)
        {
            Validation.RequireNonEmpty(label, spanId);
            var normalized = spanId.Trim().ToLowerInvariant();
            global::LogBrew.Traceparent.Create("11111111111111111111111111111111", normalized, "01");
            return normalized;
        }

        private static string NormalizeTraceFlags(string traceFlags)
        {
            var normalized = string.IsNullOrWhiteSpace(traceFlags) ? "01" : traceFlags.Trim().ToLowerInvariant();
            global::LogBrew.Traceparent.Create("11111111111111111111111111111111", "1111111111111111", normalized);
            return normalized;
        }
    }

    public static class LogBrewTrace
    {
        private static readonly AsyncLocal<LogBrewTraceContext?> ActiveTrace = new AsyncLocal<LogBrewTraceContext?>();

        public static LogBrewTraceContext? Current
        {
            get { return ActiveTrace.Value; }
        }

        public static IDisposable Activate(LogBrewTraceContext context)
        {
            if (context == null)
            {
                throw new ArgumentNullException(nameof(context));
            }

            var previous = ActiveTrace.Value;
            ActiveTrace.Value = context;
            return new ActiveTraceScope(previous);
        }

        public static IDictionary<string, object?> MetadataWithCurrentTrace(IDictionary<string, object?>? metadata)
        {
            return MetadataWithTrace(Current, metadata);
        }

        public static IDictionary<string, object?> MetadataWithTrace(LogBrewTraceContext? context, IDictionary<string, object?>? metadata)
        {
            var result = CopyValidatedMetadata(metadata);
            AddTraceMetadata(result, context);
            return result;
        }

        internal static void AddActiveTraceMetadata(IDictionary<string, object?> metadata)
        {
            AddTraceMetadata(metadata, Current);
        }

        private static Dictionary<string, object?> CopyValidatedMetadata(IDictionary<string, object?>? metadata)
        {
            return Validation.CopyPrimitiveMetadata(metadata);
        }

        private static void AddTraceMetadata(IDictionary<string, object?> metadata, LogBrewTraceContext? context)
        {
            if (context == null)
            {
                return;
            }

            metadata["traceId"] = context.TraceId;
            metadata["spanId"] = context.SpanId;
            if (context.ParentSpanId != null)
            {
                metadata["parentSpanId"] = context.ParentSpanId;
            }

            metadata["traceFlags"] = context.TraceFlags;
            metadata["traceSampled"] = context.Sampled;
        }

        private sealed class ActiveTraceScope : IDisposable
        {
            private readonly LogBrewTraceContext? previous;
            private bool disposed;

            internal ActiveTraceScope(LogBrewTraceContext? previous)
            {
                this.previous = previous;
            }

            public void Dispose()
            {
                if (disposed)
                {
                    return;
                }

                ActiveTrace.Value = previous;
                disposed = true;
            }
        }
    }

    public sealed class LogBrewHttpRequestTelemetry
    {
        private readonly LogBrewClient client;
        private readonly long startedAt;
        private readonly object gate = new object();
        private bool finished;

        private LogBrewHttpRequestTelemetry(
            LogBrewClient client,
            string method,
            string routeTemplate,
            LogBrewTraceContext trace)
        {
            this.client = client ?? throw new ArgumentNullException(nameof(client));
            Method = NormalizeMethod(method);
            RouteTemplate = NormalizeRouteTemplate(routeTemplate);
            Trace = trace ?? throw new ArgumentNullException(nameof(trace));
            startedAt = Stopwatch.GetTimestamp();
        }

        public string Method { get; }

        public string RouteTemplate { get; }

        public LogBrewTraceContext Trace { get; }

        public IReadOnlyDictionary<string, string> OutgoingHeaders
        {
            get { return Trace.Headers; }
        }

        public static LogBrewHttpRequestTelemetry Start(
            LogBrewClient client,
            string method,
            string routeTemplate,
            string? incomingTraceparent = null)
        {
            return new LogBrewHttpRequestTelemetry(
                client,
                method,
                routeTemplate,
                LogBrewTraceContext.FromIncomingTraceparentOrCreateRoot(incomingTraceparent));
        }

        public static LogBrewHttpRequestTelemetry StartWithTraceContext(
            LogBrewClient client,
            string method,
            string routeTemplate,
            LogBrewTraceContext trace)
        {
            return new LogBrewHttpRequestTelemetry(client, method, routeTemplate, trace);
        }

        public IDisposable Activate()
        {
            return LogBrewTrace.Activate(Trace);
        }

        public void FinishSpan(string eventId, string timestamp, int statusCode)
        {
            Finish(eventId, null, timestamp, statusCode, metadata: null);
        }

        public void FinishSpan(string eventId, string timestamp, int statusCode, IDictionary<string, object?> metadata)
        {
            Finish(eventId, null, timestamp, statusCode, metadata);
        }

        public void FinishSpanAndMetric(string spanEventId, string metricEventId, string timestamp, int statusCode)
        {
            Finish(spanEventId, metricEventId, timestamp, statusCode, metadata: null);
        }

        public void FinishSpanAndMetric(
            string spanEventId,
            string metricEventId,
            string timestamp,
            int statusCode,
            IDictionary<string, object?> metadata)
        {
            Finish(spanEventId, metricEventId, timestamp, statusCode, metadata);
        }

        private void Finish(
            string spanEventId,
            string? metricEventId,
            string timestamp,
            int statusCode,
            IDictionary<string, object?>? metadata)
        {
            lock (gate)
            {
                if (finished)
                {
                    throw new SdkException("validation_error", "HTTP request telemetry is already finished");
                }

                RequireStatusCode(statusCode);
                var durationMs = ElapsedMilliseconds();
                var span = SpanAttributes.Create(Method + " " + RouteTemplate, Trace.TraceId, Trace.SpanId, StatusFromHttpStatus(statusCode))
                    .WithDurationMs(durationMs)
                    .WithMetadata(LogBrewTrace.MetadataWithTrace(Trace, RequestMetadata(statusCode, metadata)));
                if (Trace.ParentSpanId != null)
                {
                    span.WithParentSpanId(Trace.ParentSpanId);
                }

                client.Span(spanEventId, timestamp, span);
                if (metricEventId != null)
                {
                    client.Metric(
                        metricEventId,
                        timestamp,
                        MetricAttributes.Create("http.server.duration", "histogram", durationMs, "ms", "delta")
                            .WithMetadata(LogBrewTrace.MetadataWithTrace(Trace, RequestMetadata(statusCode, metadata))));
                }

                finished = true;
            }
        }

        private double ElapsedMilliseconds()
        {
            var elapsedTicks = Stopwatch.GetTimestamp() - startedAt;
            return elapsedTicks * 1000.0 / Stopwatch.Frequency;
        }

        private IDictionary<string, object?> RequestMetadata(int statusCode, IDictionary<string, object?>? metadata)
        {
            var result = Validation.CopyPrimitiveMetadata(metadata);
            result["method"] = Method;
            result["routeTemplate"] = RouteTemplate;
            result["statusCode"] = statusCode;
            return result;
        }

        private static string NormalizeMethod(string method)
        {
            Validation.RequireNonEmpty("HTTP request method", method);
            var normalized = method.Trim().ToUpperInvariant();
            for (var index = 0; index < normalized.Length; index++)
            {
                if (normalized[index] < 'A' || normalized[index] > 'Z')
                {
                    throw new SdkException("validation_error", "HTTP request method must be a valid HTTP method");
                }
            }

            return normalized;
        }

        private static string NormalizeRouteTemplate(string routeTemplate)
        {
            Validation.RequireNonEmpty("HTTP request routeTemplate", routeTemplate);
            var value = routeTemplate.Trim();
            if (Uri.TryCreate(value, UriKind.Absolute, out var uri))
            {
                value = uri.AbsolutePath;
            }

            var queryIndex = value.IndexOf('?');
            if (queryIndex >= 0)
            {
                value = value.Substring(0, queryIndex);
            }

            var fragmentIndex = value.IndexOf('#');
            if (fragmentIndex >= 0)
            {
                value = value.Substring(0, fragmentIndex);
            }

            if (string.IsNullOrWhiteSpace(value))
            {
                throw new SdkException("validation_error", "HTTP request routeTemplate must be non-empty");
            }

            return value;
        }

        private static void RequireStatusCode(int statusCode)
        {
            if (statusCode < 100 || statusCode > 599)
            {
                throw new SdkException("validation_error", "HTTP request statusCode must be between 100 and 599");
            }
        }

        private static string StatusFromHttpStatus(int statusCode)
        {
            return statusCode >= 500 ? "error" : "ok";
        }
    }
}
