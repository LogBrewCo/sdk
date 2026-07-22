using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace LogBrew
{
    public sealed class SpanAttributes
    {
        private List<SpanEventSummary>? events;
        private List<SpanLinkSummary>? links;

        private SpanAttributes(string name, string traceId, string spanId, string status)
        {
            Name = name;
            TraceId = traceId;
            SpanId = spanId;
            Status = status;
        }

        public string Name { get; }

        public string TraceId { get; }

        public string SpanId { get; }

        public string Status { get; }

        public string? ParentSpanId { get; private set; }

        public double? DurationMs { get; private set; }

        public IDictionary<string, object?>? Metadata { get; private set; }

        public IReadOnlyList<SpanEventSummary>? Events
        {
            get { return events?.AsReadOnly(); }
        }

        public IReadOnlyList<SpanLinkSummary>? Links
        {
            get { return links?.AsReadOnly(); }
        }

        public static SpanAttributes Create(string name, string traceId, string spanId, string status)
        {
            return new SpanAttributes(name, traceId, spanId, status);
        }

        public SpanAttributes WithParentSpanId(string parentSpanId)
        {
            ParentSpanId = parentSpanId;
            return this;
        }

        public SpanAttributes WithDurationMs(double durationMs)
        {
            DurationMs = durationMs;
            return this;
        }

        public SpanAttributes WithMetadata(IDictionary<string, object?> metadata)
        {
            Metadata = metadata;
            return this;
        }

        public SpanAttributes WithEvents(IEnumerable<SpanEventSummary> summaries)
        {
            ExceptionContract.ThrowIfNull(summaries, nameof(summaries));

            var copied = new List<SpanEventSummary>();
            foreach (var summary in summaries)
            {
                if (summary == null)
                {
                    throw new SdkException("validation_error", "span event summary must be provided");
                }

                copied.Add(summary);
                if (copied.Count > SpanEventSummary.MaxEvents)
                {
                    throw new SdkException("validation_error", "span event summaries must contain at most " + SpanEventSummary.MaxEvents.ToString(CultureInfo.InvariantCulture) + " entries");
                }
            }

            events = copied;
            return this;
        }

        public SpanAttributes WithLinks(IEnumerable<SpanLinkSummary> summaries)
        {
            ExceptionContract.ThrowIfNull(summaries, nameof(summaries));

            var copied = new List<SpanLinkSummary>();
            foreach (var summary in summaries)
            {
                if (summary == null)
                {
                    throw new SdkException("validation_error", "span link summary must be provided");
                }

                copied.Add(summary);
                if (copied.Count > SpanLinkSummary.MaxLinks)
                {
                    throw new SdkException("validation_error", "span link summaries must contain at most " + SpanLinkSummary.MaxLinks.ToString(CultureInfo.InvariantCulture) + " entries");
                }
            }

            links = copied;
            return this;
        }

        public SpanAttributes WithLink(SpanLinkSummary summary)
        {
            ExceptionContract.ThrowIfNull(summary, nameof(summary));

            var copied = links == null ? new List<SpanLinkSummary>() : new List<SpanLinkSummary>(links);
            copied.Add(summary);
            if (copied.Count > SpanLinkSummary.MaxLinks)
            {
                throw new SdkException("validation_error", "span link summaries must contain at most " + SpanLinkSummary.MaxLinks.ToString(CultureInfo.InvariantCulture) + " entries");
            }

            links = copied;
            return this;
        }

        public SpanAttributes WithEvent(SpanEventSummary summary)
        {
            ExceptionContract.ThrowIfNull(summary, nameof(summary));

            var copied = events == null ? new List<SpanEventSummary>() : new List<SpanEventSummary>(events);
            copied.Add(summary);
            if (copied.Count > SpanEventSummary.MaxEvents)
            {
                throw new SdkException("validation_error", "span event summaries must contain at most " + SpanEventSummary.MaxEvents.ToString(CultureInfo.InvariantCulture) + " entries");
            }

            events = copied;
            return this;
        }

        internal OrderedJsonObject ToJsonObject()
        {
            Validation.RequireNonEmpty("span name", Name);
            Validation.RequireNonEmpty("span traceId", TraceId);
            Validation.RequireNonEmpty("span spanId", SpanId);
            Validation.RequireAllowedValue("span status", Status, LogBrewClient.SpanStatuses);
            if (ParentSpanId != null)
            {
                Validation.RequireNonEmpty("span parentSpanId", ParentSpanId);
            }

            if (DurationMs.HasValue && (DurationMs.Value < 0 || double.IsNaN(DurationMs.Value) || double.IsInfinity(DurationMs.Value)))
            {
                throw new SdkException("validation_error", "span durationMs must be non-negative");
            }

            var payload = new OrderedJsonObject()
                .Add("name", Name)
                .Add("traceId", TraceId)
                .Add("spanId", SpanId);
            payload.AddIfNotNull("parentSpanId", ParentSpanId);
            payload.Add("status", Status);
            if (DurationMs.HasValue)
            {
                payload.Add("durationMs", DurationMs.Value);
            }

            payload.AddMetadata(Metadata);
            if (events != null && events.Count > 0)
            {
                payload.Add("events", events.Select(summary => summary.ToJsonObject()).ToList());
            }

            if (links != null && links.Count > 0)
            {
                payload.Add("links", links.Select(summary => summary.ToJsonObject()).ToList());
            }

            return payload;
        }
    }

    public sealed class SpanLinkSummary
    {
        internal const int MaxLinks = 8;

        private SpanLinkSummary(string traceId, string spanId, string traceFlags)
        {
            TraceId = traceId;
            SpanId = spanId;
            TraceFlags = traceFlags;
            Sampled = (Convert.ToInt32(traceFlags, 16) & 1) == 1;
        }

        public string TraceId { get; }

        public string SpanId { get; }

        public string TraceFlags { get; }

        public bool Sampled { get; }

        public IDictionary<string, object?>? Metadata { get; private set; }

        public static SpanLinkSummary FromTraceparent(string traceparent)
        {
            var context = Traceparent.Parse(traceparent);
            return new SpanLinkSummary(context.TraceId, context.ParentSpanId, context.TraceFlags);
        }

        public static SpanLinkSummary Create(string traceId, string spanId, string traceFlags)
        {
            var normalizedTraceparent = Traceparent.Parse(Traceparent.Create(traceId, spanId, traceFlags));
            return new SpanLinkSummary(normalizedTraceparent.TraceId, normalizedTraceparent.ParentSpanId, normalizedTraceparent.TraceFlags);
        }

        public SpanLinkSummary WithMetadata(IDictionary<string, object?> metadata)
        {
            Metadata = SpanSummaryMetadata.CopyMetadata(metadata, "span link");
            return this;
        }

        internal OrderedJsonObject ToJsonObject()
        {
            var payload = new OrderedJsonObject()
                .Add("traceId", TraceId)
                .Add("spanId", SpanId)
                .Add("sampled", Sampled);
            payload.AddMetadata(Metadata);
            return payload;
        }

        internal SpanLinkSummary WithSafeMetadata(IDictionary<string, object?> metadata)
        {
            Metadata = metadata;
            return this;
        }
    }

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
            Metadata = CopyMetadata(metadata);
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

        private static Dictionary<string, object?> CopyMetadata(IDictionary<string, object?> metadata)
        {
            return SpanSummaryMetadata.CopyMetadata(metadata, "span event");
        }
    }

    internal static class SpanSummaryMetadata
    {
        internal static Dictionary<string, object?> CopyMetadata(IDictionary<string, object?> metadata, string label)
        {
            ExceptionContract.ThrowIfNull(metadata, nameof(metadata));

            var copied = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var item in metadata)
            {
                Validation.RequireNonEmpty(label + " metadata key", item.Key);
                if (!Validation.IsMetadataValue(item.Value))
                {
                    throw new SdkException("validation_error", label + " metadata value for " + item.Key + " must be a string, number, boolean, or null");
                }

                copied[item.Key] = item.Value;
            }

            return copied;
        }
    }
}
