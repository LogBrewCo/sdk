#nullable enable

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace LogBrew.Unity
{
    public sealed class LogBrewClient
    {
        internal static readonly string[] IssueLevels = { "info", "warning", "error", "critical" };
        internal static readonly string[] LogLevels = { "debug", "info", "warning", "error" };
        internal static readonly string[] SpanStatuses = { "ok", "error" };
        internal static readonly string[] ActionStatuses = { "queued", "running", "success", "failure" };
        internal static readonly string[] MetricKinds = { "counter", "gauge", "histogram" };
        internal static readonly string[] InstantTemporality = { "instant" };
        internal static readonly string[] DeltaCumulativeTemporalities = { "delta", "cumulative" };

        private readonly string apiKey;
        private readonly OrderedJsonObject sdk;
        private readonly int maxRetries;
        private readonly TelemetryContext? context;
        private readonly object stateLock = new object();
        private readonly List<Event> events;
        private readonly List<IssueBreadcrumb> breadcrumbs = new List<IssueBreadcrumb>();
        private bool breadcrumbsTruncated;
        private bool closed;

        private LogBrewClient(string apiKey, string sdkName, string sdkVersion, int maxRetries, TelemetryContext? context)
        {
            this.apiKey = apiKey;
            this.maxRetries = maxRetries;
            this.context = context;
            events = new List<Event>();
            sdk = new OrderedJsonObject()
                .Add("name", sdkName)
                .Add("language", "unity")
                .Add("version", sdkVersion);
        }

        public static LogBrewClient Create(
            string apiKey,
            string gameName,
            string sdkVersion,
            int maxRetries = 2,
            TelemetryContext? context = null,
            bool includeAutomaticContext = true)
        {
            Validation.RequireNonEmpty("api_key", apiKey);
            Validation.RequireNonEmpty("game_name", gameName);
            Validation.RequireNonEmpty("sdk_version", sdkVersion);
            if (maxRetries < 0)
            {
                throw new SdkException("validation_error", "max_retries must be non-negative");
            }

            var baseContext = TelemetryContext.Merge(
                includeAutomaticContext ? TelemetryContext.RuntimeDefaults() : null,
                context);
            return new LogBrewClient(apiKey, gameName, sdkVersion, maxRetries, baseContext);
        }

        public int PendingEvents()
        {
            lock (stateLock)
            {
                return events.Count;
            }
        }

        public string PreviewJson()
        {
            lock (stateLock)
            {
                return PreviewJsonLocked();
            }
        }

        public void Release(string id, string timestamp, ReleaseAttributes attributes)
        {
            if (attributes == null)
            {
                throw new ArgumentNullException(nameof(attributes));
            }

            var resolvedContext = ResolvedContext(attributes.Context);
            PushEvent("release", id, timestamp, AttributesWithContext(attributes.ToJsonObject(), resolvedContext));
        }

        public void Environment(string id, string timestamp, EnvironmentAttributes attributes)
        {
            if (attributes == null)
            {
                throw new ArgumentNullException(nameof(attributes));
            }

            var resolvedContext = ResolvedContext(attributes.Context);
            PushEvent("environment", id, timestamp, AttributesWithContext(attributes.ToJsonObject(), resolvedContext));
        }

        public void Issue(string id, string timestamp, IssueAttributes attributes)
        {
            if (attributes == null)
            {
                throw new ArgumentNullException(nameof(attributes));
            }

            List<IssueBreadcrumb> breadcrumbSnapshot;
            bool snapshotTruncated;
            lock (stateLock)
            {
                breadcrumbSnapshot = new List<IssueBreadcrumb>(breadcrumbs);
                snapshotTruncated = breadcrumbsTruncated;
            }

            var resolvedContext = ResolvedContext(attributes.Context);
            PushEvent(
                "issue",
                id,
                timestamp,
                AttributesWithContextAndTrace(attributes.ToJsonObject(breadcrumbSnapshot.AsReadOnly(), snapshotTruncated), resolvedContext));
        }

        public void Log(string id, string timestamp, LogAttributes attributes)
        {
            if (attributes == null)
            {
                throw new ArgumentNullException(nameof(attributes));
            }

            var resolvedContext = ResolvedContext(attributes.Context);
            PushEvent("log", id, timestamp, AttributesWithContextAndTrace(attributes.ToJsonObject(), resolvedContext));
        }

        public void Span(string id, string timestamp, SpanAttributes attributes)
        {
            if (attributes == null)
            {
                throw new ArgumentNullException(nameof(attributes));
            }

            var resolvedContext = ResolvedSpanContext(attributes);
            PushEvent("span", id, timestamp, AttributesWithContext(attributes.ToJsonObject(), resolvedContext));
        }

        public void Metric(string id, string timestamp, MetricAttributes attributes)
        {
            if (attributes == null)
            {
                throw new ArgumentNullException(nameof(attributes));
            }

            var resolvedContext = ResolvedContext(attributes.Context);
            PushEvent("metric", id, timestamp, AttributesWithContextAndTrace(attributes.ToJsonObject(), resolvedContext));
        }

        public void Action(string id, string timestamp, ActionAttributes attributes)
        {
            if (attributes == null)
            {
                throw new ArgumentNullException(nameof(attributes));
            }

            var resolvedContext = ResolvedContext(attributes.Context);
            PushEvent("action", id, timestamp, AttributesWithContextAndTrace(attributes.ToJsonObject(), resolvedContext));
        }

        public void AddBreadcrumb(IssueBreadcrumb breadcrumb)
        {
            if (breadcrumb == null)
            {
                throw new ArgumentNullException(nameof(breadcrumb));
            }

            breadcrumb.ToJsonObject();
            lock (stateLock)
            {
                RequireOpen();
                if (breadcrumbs.Count == IssueDiagnostics.MaxBreadcrumbs)
                {
                    breadcrumbs.RemoveAt(0);
                    breadcrumbsTruncated = true;
                }

                breadcrumbs.Add(breadcrumb);
            }
        }

        public void ClearBreadcrumbs()
        {
            lock (stateLock)
            {
                RequireOpen();
                breadcrumbs.Clear();
                breadcrumbsTruncated = false;
            }
        }

        public TransportResponse Flush(ITransport transport)
        {
            if (transport == null)
            {
                throw new ArgumentNullException(nameof(transport));
            }

            lock (stateLock)
            {
                RequireOpen();
                return FlushInternal(transport);
            }
        }

        public TransportResponse Shutdown(ITransport transport)
        {
            if (transport == null)
            {
                throw new ArgumentNullException(nameof(transport));
            }

            lock (stateLock)
            {
                RequireOpen();
                var response = FlushInternal(transport);
                closed = true;
                return response;
            }
        }

        private void PushEvent(string type, string id, string timestamp, OrderedJsonObject attributes)
        {
            Validation.RequireNonEmpty("event id", id);
            Validation.RequireTimestamp(timestamp);
            lock (stateLock)
            {
                RequireOpen();
                events.Add(new Event(type, timestamp, id, attributes));
            }
        }

        private string PreviewJsonLocked()
        {
            return JsonWriter.Write(new OrderedJsonObject()
                .Add("sdk", sdk)
                .Add("events", events.Select(item => item.ToJsonObject()).ToList()));
        }

        private TelemetryContext? ResolvedContext(TelemetryContext? eventContext)
        {
            var resolved = TelemetryContext.Merge(context, LogBrewTelemetry.CurrentContext);
            var activeTrace = LogBrewTrace.Current;
            if (activeTrace != null)
            {
                resolved = TelemetryContext.WithTrace(resolved, activeTrace);
            }

            return TelemetryContext.Merge(resolved, eventContext);
        }

        private TelemetryContext? ResolvedSpanContext(SpanAttributes attributes)
        {
            var resolved = TelemetryContext.Merge(context?.WithoutTrace(), LogBrewTelemetry.CurrentContext?.WithoutTrace());
            resolved = TelemetryContext.Merge(resolved, attributes.Context?.WithoutTrace());
            try
            {
                var activeTrace = LogBrewTrace.Current;
                var sampled = activeTrace != null
                    && string.Equals(activeTrace.TraceId, attributes.TraceId, StringComparison.OrdinalIgnoreCase)
                    && string.Equals(activeTrace.SpanId, attributes.SpanId, StringComparison.OrdinalIgnoreCase)
                    ? activeTrace.Sampled
                    : (bool?)null;
                var trace = TelemetryContext.Create()
                    .WithTrace(attributes.TraceId, attributes.SpanId, attributes.ParentSpanId, sampled)
                    .Build();
                return TelemetryContext.Merge(resolved, trace);
            }
            catch (SdkException)
            {
                return resolved;
            }
        }

        private static OrderedJsonObject AttributesWithContext(OrderedJsonObject attributes, TelemetryContext? resolvedContext)
        {
            var result = new OrderedJsonObject();
            foreach (var item in attributes.Values)
            {
                if (!string.Equals(item.Key, "context", StringComparison.Ordinal))
                {
                    result.Add(item.Key, item.Value);
                }
            }

            result.AddIfNotNull("context", resolvedContext?.ToJsonObject());
            return result;
        }

        private static OrderedJsonObject AttributesWithContextAndTrace(OrderedJsonObject attributes, TelemetryContext? resolvedContext)
        {
            return AttributesWithContext(LogBrewTrace.AddContextTraceMetadata(attributes, resolvedContext), resolvedContext);
        }

        private void RequireOpen()
        {
            if (closed)
            {
                throw new SdkException("shutdown_error", "client is already shut down");
            }
        }

        private TransportResponse FlushInternal(ITransport transport)
        {
            if (events.Count == 0)
            {
                return new TransportResponse(204, 0);
            }

            var body = PreviewJsonLocked();
            var maxAttempts = maxRetries + 1;
            for (var attempt = 1; attempt <= maxAttempts; attempt++)
            {
                try
                {
                    var response = transport.Send(apiKey, body);
                    if (response.StatusCode == 401)
                    {
                        throw new SdkException("unauthenticated", "transport rejected the API key");
                    }

                    if (response.StatusCode >= 200 && response.StatusCode < 300)
                    {
                        events.Clear();
                        return new TransportResponse(response.StatusCode, attempt);
                    }

                    if (response.StatusCode >= 500 && attempt < maxAttempts)
                    {
                        continue;
                    }

                    throw new SdkException("transport_error", "unexpected transport status " + response.StatusCode.ToString(CultureInfo.InvariantCulture));
                }
                catch (TransportException error)
                {
                    if (error.Retryable && attempt < maxAttempts)
                    {
                        continue;
                    }

                    throw new SdkException(error.Code, error.Message);
                }
            }

            throw new SdkException("transport_error", "exhausted retries");
        }
    }

    internal sealed class Event
    {
        private readonly string type;
        private readonly string timestamp;
        private readonly string id;
        private readonly OrderedJsonObject attributes;

        internal Event(string type, string timestamp, string id, OrderedJsonObject attributes)
        {
            this.type = type;
            this.timestamp = timestamp;
            this.id = id;
            this.attributes = attributes;
        }

        internal OrderedJsonObject ToJsonObject()
        {
            return new OrderedJsonObject()
                .Add("type", type)
                .Add("timestamp", timestamp)
                .Add("id", id)
                .Add("attributes", attributes);
        }
    }
}
