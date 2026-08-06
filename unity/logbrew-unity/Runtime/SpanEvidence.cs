#nullable enable

using System;
using System.Collections.Generic;

namespace LogBrew.Unity
{
    public sealed class SpanEventSummary
    {
        internal const int MaxEvents = 8;

        private SpanEventSummary(string name)
        {
            Name = name;
        }

        public string Name { get; }

        public string? Timestamp { get; private set; }

        public IDictionary<string, object?>? Metadata { get; private set; }

        public static SpanEventSummary Create(string name)
        {
            return new SpanEventSummary(name);
        }

        public SpanEventSummary WithTimestamp(string timestamp)
        {
            Timestamp = timestamp;
            return this;
        }

        public SpanEventSummary WithMetadata(IDictionary<string, object?> metadata)
        {
            Metadata = SpanSummaryMetadata.Copy(metadata, "span event");
            return this;
        }

        internal OrderedJsonObject ToJsonObject()
        {
            Validation.RequireNonEmpty("span event name", Name);
            if (Timestamp != null)
            {
                Validation.RequireTimestamp(Timestamp);
            }

            var payload = new OrderedJsonObject().Add("name", Name);
            payload.AddIfNotNull("timestamp", Timestamp);
            payload.AddMetadata(Metadata);
            return payload;
        }
    }

    public sealed class SpanLinkSummary
    {
        internal const int MaxLinks = 8;

        private SpanLinkSummary(string traceId, string spanId)
        {
            TraceId = TelemetryContextValue.HexId(traceId, 32, "span link traceId");
            SpanId = TelemetryContextValue.HexId(spanId, 16, "span link spanId");
        }

        public string TraceId { get; }

        public string SpanId { get; }

        public bool? Sampled { get; private set; }

        public IDictionary<string, object?>? Metadata { get; private set; }

        public static SpanLinkSummary Create(string traceId, string spanId)
        {
            return new SpanLinkSummary(traceId, spanId);
        }

        public static SpanLinkSummary FromTraceparent(string traceparent)
        {
            var context = LogBrewTraceContext.FromTraceparent(traceparent);
            if (context.ParentSpanId == null)
            {
                throw new SdkException("validation_error", "traceparent parent span is required");
            }

            return new SpanLinkSummary(context.TraceId, context.ParentSpanId).WithSampled(context.Sampled);
        }

        public SpanLinkSummary WithSampled(bool sampled)
        {
            Sampled = sampled;
            return this;
        }

        public SpanLinkSummary WithMetadata(IDictionary<string, object?> metadata)
        {
            Metadata = SpanSummaryMetadata.Copy(metadata, "span link");
            return this;
        }

        internal OrderedJsonObject ToJsonObject()
        {
            var payload = new OrderedJsonObject().Add("traceId", TraceId).Add("spanId", SpanId);
            payload.AddIfNotNull("sampled", Sampled);
            payload.AddMetadata(Metadata);
            return payload;
        }
    }

    internal static class SpanSummaryMetadata
    {
        internal static Dictionary<string, object?> Copy(IDictionary<string, object?> metadata, string label)
        {
            if (metadata == null)
            {
                throw new ArgumentNullException(nameof(metadata));
            }

            var copied = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var item in metadata)
            {
                Validation.RequireNonEmpty(label + " metadata key", item.Key);
                copied[item.Key] = Validation.RequireMetadataValue(item.Key, item.Value);
            }

            return copied;
        }
    }
}
