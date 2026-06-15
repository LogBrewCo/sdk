using System;
using System.Collections.Generic;

namespace LogBrew
{
    public sealed class TraceparentContext
    {
        internal TraceparentContext(string version, string traceId, string parentSpanId, string traceFlags)
        {
            Version = version;
            TraceId = traceId;
            ParentSpanId = parentSpanId;
            TraceFlags = traceFlags;
            Sampled = (Convert.ToInt32(traceFlags, 16) & 1) == 1;
        }

        public string Version { get; }

        public string TraceId { get; }

        public string ParentSpanId { get; }

        public string TraceFlags { get; }

        public bool Sampled { get; }
    }

    public sealed class TraceparentSpanInput
    {
        private Dictionary<string, object?>? metadata;

        private TraceparentSpanInput(string name, string spanId, string status)
        {
            Name = name;
            SpanId = spanId;
            Status = status;
        }

        public string Name { get; }

        public string SpanId { get; }

        public string Status { get; }

        public double? DurationMs { get; private set; }

        public IReadOnlyDictionary<string, object?>? Metadata
        {
            get { return metadata; }
        }

        public static TraceparentSpanInput Create(string name, string spanId, string status)
        {
            return new TraceparentSpanInput(name, spanId, status);
        }

        public TraceparentSpanInput WithDurationMs(double durationMs)
        {
            DurationMs = durationMs;
            return this;
        }

        public TraceparentSpanInput WithMetadata(IDictionary<string, object?> value)
        {
            metadata = CopyMetadata(value);
            return this;
        }

        internal IDictionary<string, object?>? MetadataForSpan()
        {
            return metadata;
        }

        private static Dictionary<string, object?> CopyMetadata(IDictionary<string, object?> value)
        {
            var copied = Validation.CopyMetadata(value);
            var primitiveMetadata = new Dictionary<string, object?>();
            if (copied == null)
            {
                return primitiveMetadata;
            }

            foreach (var item in copied.Values)
            {
                primitiveMetadata[item.Key] = item.Value;
            }

            return primitiveMetadata;
        }
    }

    public static class Traceparent
    {
        private const string ZeroTraceId = "00000000000000000000000000000000";
        private const string ZeroSpanId = "0000000000000000";

        public static TraceparentContext Parse(string traceparent)
        {
            Validation.RequireNonEmpty("traceparent", traceparent);
            var normalized = traceparent.Trim().ToLowerInvariant();
            if (normalized.Length != 55 || normalized[2] != '-' || normalized[35] != '-' || normalized[52] != '-')
            {
                throw TraceparentShapeError();
            }

            var version = normalized.Substring(0, 2);
            var traceId = normalized.Substring(3, 32);
            var parentSpanId = normalized.Substring(36, 16);
            var traceFlags = normalized.Substring(53, 2);
            if (!IsLowerHex(version) || !IsLowerHex(traceId) || !IsLowerHex(parentSpanId) || !IsLowerHex(traceFlags))
            {
                throw TraceparentShapeError();
            }

            if (string.Equals(version, "ff", StringComparison.Ordinal))
            {
                throw new SdkException("validation_error", "traceparent version ff is forbidden");
            }

            RequireTraceId(traceId);
            RequireSpanId("traceparent parent span id", parentSpanId);
            RequireTraceFlags(traceFlags);
            return new TraceparentContext(version, traceId, parentSpanId, traceFlags);
        }

        public static string Create(string traceId, string spanId)
        {
            return Create(traceId, spanId, "01");
        }

        public static string Create(string traceId, string spanId, string? traceFlags)
        {
            var normalizedTraceId = NormalizeRequired("traceId", traceId);
            var normalizedSpanId = NormalizeRequired("spanId", spanId);
            var normalizedTraceFlags = NormalizeTraceFlags(traceFlags);
            RequireTraceId(normalizedTraceId);
            RequireSpanId("spanId", normalizedSpanId);
            RequireTraceFlags(normalizedTraceFlags);
            return "00-" + normalizedTraceId + "-" + normalizedSpanId + "-" + normalizedTraceFlags;
        }

        public static IReadOnlyDictionary<string, string> CreateHeaders(string traceId, string spanId)
        {
            return CreateHeaders(traceId, spanId, "01");
        }

        public static IReadOnlyDictionary<string, string> CreateHeaders(string traceId, string spanId, string? traceFlags)
        {
            return new Dictionary<string, string>
            {
                ["traceparent"] = Create(traceId, spanId, traceFlags)
            };
        }

        public static SpanAttributes SpanAttributesFromTraceparent(string traceparent, TraceparentSpanInput input)
        {
            if (input == null)
            {
                throw new SdkException("validation_error", "traceparent span input must be provided");
            }

            var context = Parse(traceparent);
            var spanId = NormalizeRequired("spanId", input.SpanId);
            RequireSpanId("spanId", spanId);
            var attributes = SpanAttributes.Create(input.Name, context.TraceId, spanId, input.Status)
                .WithParentSpanId(context.ParentSpanId);
            if (input.DurationMs.HasValue)
            {
                attributes.WithDurationMs(input.DurationMs.Value);
            }

            var metadata = input.MetadataForSpan();
            if (metadata != null)
            {
                attributes.WithMetadata(metadata);
            }

            return attributes;
        }

        private static string NormalizeRequired(string label, string value)
        {
            Validation.RequireNonEmpty(label, value);
            return value.Trim().ToLowerInvariant();
        }

        private static string NormalizeTraceFlags(string? traceFlags)
        {
            if (string.IsNullOrWhiteSpace(traceFlags))
            {
                return "01";
            }

            var providedTraceFlags = traceFlags ?? "01";
            return providedTraceFlags.Trim().ToLowerInvariant();
        }

        private static void RequireTraceId(string traceId)
        {
            if (traceId.Length != 32 || !IsLowerHex(traceId))
            {
                throw new SdkException("validation_error", "traceparent traceId must be 32 hex characters");
            }

            if (string.Equals(traceId, ZeroTraceId, StringComparison.Ordinal))
            {
                throw new SdkException("validation_error", "traceparent traceId must not be all zeros");
            }
        }

        private static void RequireSpanId(string label, string spanId)
        {
            if (spanId.Length != 16 || !IsLowerHex(spanId))
            {
                throw new SdkException("validation_error", label + " must be 16 hex characters");
            }

            if (string.Equals(spanId, ZeroSpanId, StringComparison.Ordinal))
            {
                throw new SdkException("validation_error", label + " must not be all zeros");
            }
        }

        private static void RequireTraceFlags(string traceFlags)
        {
            if (traceFlags.Length != 2 || !IsLowerHex(traceFlags))
            {
                throw new SdkException("validation_error", "traceparent traceFlags must be 2 hex characters");
            }
        }

        private static bool IsLowerHex(string value)
        {
            foreach (var character in value)
            {
                if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')))
                {
                    return false;
                }
            }

            return true;
        }

        private static SdkException TraceparentShapeError()
        {
            return new SdkException(
                "validation_error",
                "traceparent must match W3C version-traceid-parentid-flags shape");
        }
    }
}
