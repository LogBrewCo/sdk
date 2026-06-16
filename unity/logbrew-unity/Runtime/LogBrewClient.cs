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

        private readonly string apiKey;
        private readonly OrderedJsonObject sdk;
        private readonly int maxRetries;
        private readonly List<Event> events;
        private bool closed;

        private LogBrewClient(string apiKey, string sdkName, string sdkVersion, int maxRetries)
        {
            this.apiKey = apiKey;
            this.maxRetries = maxRetries;
            events = new List<Event>();
            sdk = new OrderedJsonObject()
                .Add("name", sdkName)
                .Add("language", "unity")
                .Add("version", sdkVersion);
        }

        public static LogBrewClient Create(string apiKey, string gameName, string sdkVersion, int maxRetries = 2)
        {
            Validation.RequireNonEmpty("api_key", apiKey);
            Validation.RequireNonEmpty("game_name", gameName);
            Validation.RequireNonEmpty("sdk_version", sdkVersion);
            if (maxRetries < 0)
            {
                throw new SdkException("validation_error", "max_retries must be non-negative");
            }

            return new LogBrewClient(apiKey, gameName, sdkVersion, maxRetries);
        }

        public int PendingEvents()
        {
            return events.Count;
        }

        public string PreviewJson()
        {
            return JsonWriter.Write(new OrderedJsonObject()
                .Add("sdk", sdk)
                .Add("events", events.Select(item => item.ToJsonObject()).ToList()));
        }

        public void Release(string id, string timestamp, ReleaseAttributes attributes)
        {
            if (attributes == null)
            {
                throw new ArgumentNullException(nameof(attributes));
            }

            PushEvent("release", id, timestamp, attributes.ToJsonObject());
        }

        public void Environment(string id, string timestamp, EnvironmentAttributes attributes)
        {
            if (attributes == null)
            {
                throw new ArgumentNullException(nameof(attributes));
            }

            PushEvent("environment", id, timestamp, attributes.ToJsonObject());
        }

        public void Issue(string id, string timestamp, IssueAttributes attributes)
        {
            if (attributes == null)
            {
                throw new ArgumentNullException(nameof(attributes));
            }

            PushEvent("issue", id, timestamp, LogBrewTrace.AddActiveTraceMetadata(attributes.ToJsonObject()));
        }

        public void Log(string id, string timestamp, LogAttributes attributes)
        {
            if (attributes == null)
            {
                throw new ArgumentNullException(nameof(attributes));
            }

            PushEvent("log", id, timestamp, LogBrewTrace.AddActiveTraceMetadata(attributes.ToJsonObject()));
        }

        public void Span(string id, string timestamp, SpanAttributes attributes)
        {
            if (attributes == null)
            {
                throw new ArgumentNullException(nameof(attributes));
            }

            PushEvent("span", id, timestamp, attributes.ToJsonObject());
        }

        public void Action(string id, string timestamp, ActionAttributes attributes)
        {
            if (attributes == null)
            {
                throw new ArgumentNullException(nameof(attributes));
            }

            PushEvent("action", id, timestamp, LogBrewTrace.AddActiveTraceMetadata(attributes.ToJsonObject()));
        }

        public TransportResponse Flush(ITransport transport)
        {
            if (transport == null)
            {
                throw new ArgumentNullException(nameof(transport));
            }

            if (closed)
            {
                throw new SdkException("shutdown_error", "client is already shut down");
            }

            return FlushInternal(transport);
        }

        public TransportResponse Shutdown(ITransport transport)
        {
            if (transport == null)
            {
                throw new ArgumentNullException(nameof(transport));
            }

            if (closed)
            {
                throw new SdkException("shutdown_error", "client is already shut down");
            }

            var response = FlushInternal(transport);
            closed = true;
            return response;
        }

        private void PushEvent(string type, string id, string timestamp, OrderedJsonObject attributes)
        {
            if (closed)
            {
                throw new SdkException("shutdown_error", "client is already shut down");
            }

            Validation.RequireNonEmpty("event id", id);
            Validation.RequireTimestamp(timestamp);
            events.Add(new Event(type, timestamp, id, attributes));
        }

        private TransportResponse FlushInternal(ITransport transport)
        {
            if (events.Count == 0)
            {
                return new TransportResponse(204, 0);
            }

            var body = PreviewJson();
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
