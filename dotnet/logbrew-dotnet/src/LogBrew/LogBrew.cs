using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;

namespace LogBrew
{
    public sealed class SdkException : Exception
    {
        public SdkException(string code, string message)
            : base(code + ": " + message)
        {
            Code = code;
            DetailMessage = message;
        }

        public string Code { get; }

        public string DetailMessage { get; }
    }

    public sealed class TransportException : Exception
    {
        public TransportException(string code, string message, bool retryable = false)
            : base(message)
        {
            Code = code;
            Retryable = retryable;
        }

        public string Code { get; }

        public bool Retryable { get; }

        public static TransportException Network(string message)
        {
            return new TransportException("network_failure", message, retryable: true);
        }
    }

    public sealed class TransportResponse
    {
        public TransportResponse(int statusCode, int attempts)
            : this(statusCode, attempts, null)
        {
        }

        public TransportResponse(int statusCode, int attempts, TimeSpan? retryAfter)
        {
            if (attempts < 0)
            {
                throw new SdkException("validation_error", "transport attempts must be non-negative");
            }

            if (retryAfter < TimeSpan.Zero)
            {
                throw new SdkException("validation_error", "transport retry_after must be non-negative");
            }

            StatusCode = statusCode;
            Attempts = attempts;
            RetryAfter = retryAfter;
        }

        public int StatusCode { get; }

        public int Attempts { get; }

        public TimeSpan? RetryAfter { get; }
    }

    public interface ITransport
    {
        TransportResponse Send(string apiKey, string body);
    }

    public sealed class DroppedEvent
    {
        internal DroppedEvent(string eventId, string eventType, string reason, int droppedEvents)
        {
            EventId = eventId;
            EventType = eventType;
            Reason = reason;
            DroppedEvents = droppedEvents;
        }

        public string EventId { get; }

        public string EventType { get; }

        public string Reason { get; }

        public int DroppedEvents { get; }
    }

    public sealed class HttpTransportOptions
    {
        public Uri? Endpoint { get; set; }

        public IDictionary<string, string>? Headers { get; set; }

        public HttpClient? HttpClient { get; set; }

        public TimeSpan? Timeout { get; set; }
    }

    public sealed class HttpTransport : ITransport, IDisposable
    {
        public static readonly Uri DefaultEndpoint = new Uri("https://api.logbrew.co/v1/events", UriKind.Absolute);

        public static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(10);

        private static readonly HttpClient SharedHttpClient = new HttpClient
        {
            Timeout = DefaultTimeout
        };

        private readonly IReadOnlyDictionary<string, string> headers;
        private readonly bool ownsHttpClient;
        private bool disposed;

        public HttpTransport()
            : this(new HttpTransportOptions())
        {
        }

        public HttpTransport(Uri endpoint)
            : this(new HttpTransportOptions { Endpoint = endpoint })
        {
        }

        public HttpTransport(Uri endpoint, IDictionary<string, string> headers)
            : this(new HttpTransportOptions { Endpoint = endpoint, Headers = headers })
        {
        }

        public HttpTransport(HttpTransportOptions? options)
        {
            options ??= new HttpTransportOptions();
            Endpoint = ValidateEndpoint(options.Endpoint ?? DefaultEndpoint);
            Timeout = ValidateTimeout(options.Timeout ?? DefaultTimeout);
            HttpClient = options.HttpClient ?? DefaultClient(Timeout, out ownsHttpClient);
            headers = CopyHeaders(options.Headers);
        }

        public Uri Endpoint { get; }

        public IReadOnlyDictionary<string, string> Headers
        {
            get { return headers; }
        }

        public HttpClient HttpClient { get; }

        public TimeSpan Timeout { get; }

        public TransportResponse Send(string apiKey, string body)
        {
            if (disposed)
            {
                throw new SdkException("transport_error", "HTTP transport is disposed");
            }

            Validation.RequireNonEmpty("api_key", apiKey);
            if (body == null)
            {
                throw new SdkException("validation_error", "body must be non-empty");
            }

            using var request = new HttpRequestMessage(HttpMethod.Post, Endpoint);
            using var content = new StringContent(body, Encoding.UTF8, "application/json");
            request.Content = content;
            request.Headers.TryAddWithoutValidation("authorization", "Bearer " + apiKey);
            AddHeaders(request);

            try
            {
                var responseTask = HttpClient.SendAsync(request);
                if (!responseTask.Wait(Timeout))
                {
                    throw TransportException.Network("http transport failed: request timed out");
                }

                using var response = responseTask.GetAwaiter().GetResult();
                return new TransportResponse(
                    (int)response.StatusCode,
                    1,
                    ParseRetryAfter(response, DateTimeOffset.UtcNow));
            }
            catch (AggregateException error) when (error.InnerException is HttpRequestException || error.InnerException is TaskCanceledException)
            {
                throw TransportException.Network("http transport failed: " + error.InnerException.Message);
            }
            catch (HttpRequestException error)
            {
                throw TransportException.Network("http transport failed: " + error.Message);
            }
            catch (TaskCanceledException error)
            {
                throw TransportException.Network("http transport failed: " + error.Message);
            }
            catch (InvalidOperationException error)
            {
                throw new SdkException("configuration_error", "invalid HTTP transport request: " + error.Message);
            }
        }

        public void Dispose()
        {
            if (!disposed && ownsHttpClient)
            {
                HttpClient.Dispose();
            }

            disposed = true;
        }

        private static HttpClient DefaultClient(TimeSpan timeout, out bool ownsClient)
        {
            if (timeout == DefaultTimeout)
            {
                ownsClient = false;
                return SharedHttpClient;
            }

            ownsClient = true;
            return new HttpClient { Timeout = timeout };
        }

        private static Uri ValidateEndpoint(Uri endpoint)
        {
            if (!endpoint.IsAbsoluteUri)
            {
                throw new SdkException("configuration_error", "HTTP transport endpoint must be absolute");
            }

            if (!string.Equals(endpoint.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)
                && !string.Equals(endpoint.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
            {
                throw new SdkException("configuration_error", "HTTP transport endpoint must use http or https");
            }

            return endpoint;
        }

        private static TimeSpan ValidateTimeout(TimeSpan timeout)
        {
            if (timeout <= TimeSpan.Zero)
            {
                throw new SdkException("configuration_error", "HTTP transport timeout must be positive");
            }

            return timeout;
        }

        private static Dictionary<string, string> CopyHeaders(IDictionary<string, string>? source)
        {
            var copied = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (source == null)
            {
                return copied;
            }

            foreach (var pair in source)
            {
                if (string.IsNullOrWhiteSpace(pair.Key))
                {
                    throw new SdkException("configuration_error", "HTTP transport header name must be non-empty");
                }

                if (pair.Value == null)
                {
                    throw new SdkException("configuration_error", "HTTP transport header value must be non-null");
                }

                copied[pair.Key] = pair.Value;
            }

            return copied;
        }

        private void AddHeaders(HttpRequestMessage request)
        {
            foreach (var pair in headers)
            {
                if (string.Equals(pair.Key, "content-type", StringComparison.OrdinalIgnoreCase))
                {
                    request.Content?.Headers.Remove("content-type");
                    if (request.Content?.Headers.TryAddWithoutValidation(pair.Key, pair.Value) != true)
                    {
                        throw new SdkException("configuration_error", "invalid HTTP transport header: " + pair.Key);
                    }

                    continue;
                }

                request.Headers.Remove(pair.Key);
                if (!request.Headers.TryAddWithoutValidation(pair.Key, pair.Value))
                {
                    throw new SdkException("configuration_error", "invalid HTTP transport header: " + pair.Key);
                }
            }
        }

        private static TimeSpan? ParseRetryAfter(HttpResponseMessage response, DateTimeOffset now)
        {
            if (!response.Headers.TryGetValues("Retry-After", out var rawValues))
            {
                return null;
            }

            var values = rawValues.ToList();
            if (values.Count != 1)
            {
                return null;
            }

            var value = values[0].Trim();
            if (long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var seconds))
            {
                if (seconds < 0 || seconds > int.MaxValue)
                {
                    return null;
                }

                return TimeSpan.FromSeconds(seconds);
            }

            if (!DateTimeOffset.TryParseExact(
                value,
                "r",
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                out var retryAt))
            {
                return null;
            }

            var delay = retryAt - now;
            return delay > TimeSpan.Zero ? delay : null;
        }
    }

    public sealed class RecordingTransport : ITransport
    {
        private readonly Queue<object> scriptedResponses;
        private readonly List<string> sentBodies;

        public RecordingTransport(IEnumerable<object>? scriptedResponses = null)
        {
            var responses = scriptedResponses == null ? new List<object> { 202 } : scriptedResponses.ToList();
            this.scriptedResponses = new Queue<object>(responses.Count == 0 ? new List<object> { 202 } : responses);
            sentBodies = new List<string>();
        }

        public IReadOnlyList<string> SentBodies
        {
            get { return sentBodies.AsReadOnly(); }
        }

        public string? LastBody
        {
            get { return sentBodies.Count == 0 ? null : sentBodies[sentBodies.Count - 1]; }
        }

        public static RecordingTransport AlwaysAccept()
        {
            return new RecordingTransport(new object[] { 202 });
        }

        public TransportResponse Send(string apiKey, string body)
        {
            Validation.RequireNonEmpty("api_key", apiKey);
            if (body == null)
            {
                throw new SdkException("validation_error", "body must be non-empty");
            }

            sentBodies.Add(body);
            var next = scriptedResponses.Count == 0 ? 202 : scriptedResponses.Dequeue();
            if (next is TransportException transportException)
            {
                throw transportException;
            }

            if (next is SdkException sdkException)
            {
                throw sdkException;
            }

            if (next is TransportResponse response)
            {
                return new TransportResponse(response.StatusCode, 1, response.RetryAfter);
            }

            if (next is int statusCode)
            {
                return new TransportResponse(statusCode, 1);
            }

            throw new SdkException("transport_error", "invalid scripted transport response");
        }
    }

    public sealed class ReleaseAttributes
    {
        private ReleaseAttributes(string version)
        {
            Version = version;
        }

        public string Version { get; }

        public string? Commit { get; private set; }

        public string? Notes { get; private set; }

        public IDictionary<string, object?>? Metadata { get; private set; }

        public static ReleaseAttributes Create(string version)
        {
            return new ReleaseAttributes(version);
        }

        public ReleaseAttributes WithCommit(string commit)
        {
            Commit = commit;
            return this;
        }

        public ReleaseAttributes WithNotes(string notes)
        {
            Notes = notes;
            return this;
        }

        public ReleaseAttributes WithMetadata(IDictionary<string, object?> metadata)
        {
            Metadata = metadata;
            return this;
        }

        internal OrderedJsonObject ToJsonObject()
        {
            Validation.RequireNonEmpty("release version", Version);
            if (Commit != null)
            {
                Validation.RequireNonEmpty("release commit", Commit);
            }

            var payload = new OrderedJsonObject().Add("version", Version);
            payload.AddIfNotNull("commit", Commit);
            payload.AddIfNotNull("notes", Notes);
            payload.AddMetadata(Metadata);
            return payload;
        }
    }

    public sealed class EnvironmentAttributes
    {
        private EnvironmentAttributes(string name)
        {
            Name = name;
        }

        public string Name { get; }

        public string? Region { get; private set; }

        public IDictionary<string, object?>? Metadata { get; private set; }

        public static EnvironmentAttributes Create(string name)
        {
            return new EnvironmentAttributes(name);
        }

        public EnvironmentAttributes WithRegion(string region)
        {
            Region = region;
            return this;
        }

        public EnvironmentAttributes WithMetadata(IDictionary<string, object?> metadata)
        {
            Metadata = metadata;
            return this;
        }

        internal OrderedJsonObject ToJsonObject()
        {
            Validation.RequireNonEmpty("environment name", Name);
            var payload = new OrderedJsonObject().Add("name", Name);
            payload.AddIfNotNull("region", Region);
            payload.AddMetadata(Metadata);
            return payload;
        }
    }

    public sealed class IssueAttributes
    {
        private IssueAttributes(string title, string level)
        {
            Title = title;
            Level = level;
        }

        public string Title { get; }

        public string Level { get; }

        public string? Message { get; private set; }

        public IDictionary<string, object?>? Metadata { get; private set; }

        public static IssueAttributes Create(string title, string level)
        {
            return new IssueAttributes(title, level);
        }

        public IssueAttributes WithMessage(string message)
        {
            Message = message;
            return this;
        }

        public IssueAttributes WithMetadata(IDictionary<string, object?> metadata)
        {
            Metadata = metadata;
            return this;
        }

        internal OrderedJsonObject ToJsonObject()
        {
            Validation.RequireNonEmpty("issue title", Title);
            var level = Validation.NormalizeSeverity("issue level", Level);
            var payload = new OrderedJsonObject().Add("title", Title).Add("level", level);
            payload.AddIfNotNull("message", Message);
            payload.AddMetadata(Metadata);
            return payload;
        }
    }

    public sealed class LogAttributes
    {
        private LogAttributes(string message, string level)
        {
            Message = message;
            Level = level;
        }

        public string Message { get; }

        public string Level { get; }

        public string? Logger { get; private set; }

        public IDictionary<string, object?>? Metadata { get; private set; }

        public static LogAttributes Create(string message, string level)
        {
            return new LogAttributes(message, level);
        }

        public LogAttributes WithLogger(string logger)
        {
            Logger = logger;
            return this;
        }

        public LogAttributes WithMetadata(IDictionary<string, object?> metadata)
        {
            Metadata = metadata;
            return this;
        }

        internal OrderedJsonObject ToJsonObject()
        {
            Validation.RequireNonEmpty("log message", Message);
            var level = Validation.NormalizeSeverity("log level", Level);
            var payload = new OrderedJsonObject().Add("message", Message).Add("level", level);
            payload.AddIfNotNull("logger", Logger);
            payload.AddMetadata(Metadata);
            return payload;
        }
    }

    public sealed class ActionAttributes
    {
        private ActionAttributes(string name, string status)
        {
            Name = name;
            Status = status;
        }

        public string Name { get; }

        public string Status { get; }

        public IDictionary<string, object?>? Metadata { get; private set; }

        public static ActionAttributes Create(string name, string status)
        {
            return new ActionAttributes(name, status);
        }

        public ActionAttributes WithMetadata(IDictionary<string, object?> metadata)
        {
            Metadata = metadata;
            return this;
        }

        internal OrderedJsonObject ToJsonObject()
        {
            Validation.RequireNonEmpty("action name", Name);
            Validation.RequireAllowedValue("action status", Status, LogBrewClient.ActionStatuses);
            var payload = new OrderedJsonObject().Add("name", Name).Add("status", Status);
            payload.AddMetadata(Metadata);
            return payload;
        }
    }

    public sealed class LogBrewClient
    {
        private const int DefaultMaxQueueSize = 1000;
        private const int DefaultMaxQueueBytes = 4 * 1024 * 1024;
        private readonly DeliveryEngine delivery;

        internal static readonly string[] SeverityValues = { "trace", "debug", "info", "warn", "warning", "error", "fatal", "critical" };
        internal static readonly string[] SpanStatuses = { "ok", "error" };
        internal static readonly string[] ActionStatuses = { "queued", "running", "success", "failure" };
        internal static readonly string[] MetricKinds = { "counter", "gauge", "histogram" };
        internal static readonly string[] DeltaCumulativeTemporalities = { "delta", "cumulative" };
        internal static readonly string[] InstantTemporality = { "instant" };

        private LogBrewClient(
            string apiKey,
            string sdkName,
            string sdkVersion,
            int maxRetries,
            int maxQueueSize,
            int maxQueueBytes,
            Action<DroppedEvent>? onEventDropped,
            ITransport? automaticTransport,
            AutomaticDeliverySettings? automaticSettings,
            IDurableDeliverySession? durableSession = null)
        {
            var sdk = new OrderedJsonObject()
                .Add("name", sdkName)
                .Add("language", "dotnet")
                .Add("version", sdkVersion);
            delivery = new DeliveryEngine(
                apiKey,
                sdk,
                maxRetries,
                maxQueueSize,
                maxQueueBytes,
                onEventDropped,
                automaticTransport,
                automaticSettings,
                durableSession);
            delivery.StartOwnedDelivery();
        }

        public static LogBrewClient Create(
            string apiKey,
            string sdkName,
            string sdkVersion,
            int maxRetries = 2,
            int maxQueueSize = DefaultMaxQueueSize,
            Action<DroppedEvent>? onEventDropped = null,
            int maxQueueBytes = DefaultMaxQueueBytes)
        {
            ValidateClientOptions(apiKey, sdkName, sdkVersion, maxRetries, maxQueueSize, maxQueueBytes);
            return new LogBrewClient(
                apiKey,
                sdkName,
                sdkVersion,
                maxRetries,
                maxQueueSize,
                maxQueueBytes,
                onEventDropped,
                null,
                null);
        }

        public static LogBrewClient CreateAutomatic(
            string apiKey,
            string sdkName,
            string sdkVersion,
            ITransport transport,
            AutomaticDeliveryOptions? options = null,
            Action<DroppedEvent>? onEventDropped = null)
        {
            if (transport == null)
            {
                throw new SdkException("validation_error", "automatic transport must be non-null");
            }

            var settings = (options ?? new AutomaticDeliveryOptions()).ValidateAndCopy();
            ValidateClientOptions(
                apiKey,
                sdkName,
                sdkVersion,
                settings.MaxRetries,
                settings.MaxQueueSize,
                settings.MaxQueueBytes);
            return new LogBrewClient(
                apiKey,
                sdkName,
                sdkVersion,
                settings.MaxRetries,
                settings.MaxQueueSize,
                settings.MaxQueueBytes,
                onEventDropped,
                transport,
                settings);
        }

#if NET8_0_OR_GREATER
        public static LogBrewClient CreateAutomaticDurable(
            string apiKey,
            string sdkName,
            string sdkVersion,
            ITransport transport,
            DurableDeliveryOptions storage,
            AutomaticDeliveryOptions? options = null,
            Action<DroppedEvent>? onEventDropped = null)
        {
            if (transport == null)
            {
                throw new SdkException("validation_error", "automatic transport must be non-null");
            }

            if (storage == null)
            {
                throw new SdkException("validation_error", "durable delivery options must be non-null");
            }

            var settings = (options ?? new AutomaticDeliveryOptions()).ValidateAndCopy();
            ValidateClientOptions(
                apiKey,
                sdkName,
                sdkVersion,
                settings.MaxRetries,
                settings.MaxQueueSize,
                settings.MaxQueueBytes);
            var durableStore = DurableEventStore.Open(
                storage,
                settings.MaxQueueSize,
                settings.MaxQueueBytes);
            var durableSession = new DurableDeliverySession(durableStore);
            try
            {
                return new LogBrewClient(
                    apiKey,
                    sdkName,
                    sdkVersion,
                    settings.MaxRetries,
                    settings.MaxQueueSize,
                    settings.MaxQueueBytes,
                    onEventDropped,
                    transport,
                    settings,
                    durableSession);
            }
            catch
            {
                durableSession.Dispose();
                throw;
            }
        }
#endif

        public int PendingEvents()
        {
            return delivery.PendingEvents();
        }

        public int DroppedEvents()
        {
            return delivery.DroppedEvents();
        }

        public DeliveryHealthSnapshot DeliveryHealth()
        {
            return delivery.Health();
        }

        public string PreviewJson()
        {
            return delivery.PreviewJson();
        }

        public void Release(string id, string timestamp, ReleaseAttributes attributes)
        {
            PushEvent("release", id, timestamp, attributes.ToJsonObject());
        }

        public void Environment(string id, string timestamp, EnvironmentAttributes attributes)
        {
            PushEvent("environment", id, timestamp, attributes.ToJsonObject());
        }

        public void Issue(string id, string timestamp, IssueAttributes attributes)
        {
            PushEvent("issue", id, timestamp, attributes.ToJsonObject());
        }

        public void Log(string id, string timestamp, LogAttributes attributes)
        {
            PushEvent("log", id, timestamp, attributes.ToJsonObject());
        }

        public void Span(string id, string timestamp, SpanAttributes attributes)
        {
            PushEvent("span", id, timestamp, attributes.ToJsonObject());
        }

        public void Metric(string id, string timestamp, MetricAttributes attributes)
        {
            PushEvent("metric", id, timestamp, attributes.ToJsonObject());
        }

        public void Action(string id, string timestamp, ActionAttributes attributes)
        {
            PushEvent("action", id, timestamp, attributes.ToJsonObject());
        }

        public TransportResponse Flush(ITransport transport)
        {
            return delivery.Flush(transport);
        }

        public TransportResponse Flush()
        {
            return delivery.Flush();
        }

        public TransportResponse Shutdown(ITransport transport)
        {
            return delivery.Shutdown(transport);
        }

        public TransportResponse Shutdown()
        {
            return delivery.Shutdown();
        }

        public void RecoverAutomaticDelivery()
        {
            delivery.RecoverAutomaticDelivery();
        }

#if NET8_0_OR_GREATER
        public void PurgeDurableDelivery()
        {
            delivery.PurgeDurableDelivery();
        }
#endif

        private void PushEvent(string type, string id, string timestamp, OrderedJsonObject attributes)
        {
            Validation.RequireNonEmpty("event id", id);
            Validation.RequireTimestamp(timestamp);
            delivery.Enqueue(new Event(type, timestamp, id, attributes));
        }

        private static void ValidateClientOptions(
            string apiKey,
            string sdkName,
            string sdkVersion,
            int maxRetries,
            int maxQueueSize,
            int maxQueueBytes)
        {
            Validation.RequireNonEmpty("api_key", apiKey);
            Validation.RequireNonEmpty("sdk_name", sdkName);
            Validation.RequireNonEmpty("sdk_version", sdkVersion);
            if (maxRetries < 0)
            {
                throw new SdkException("validation_error", "max_retries must be non-negative");
            }

            if (maxQueueSize <= 0)
            {
                throw new SdkException("validation_error", "max_queue_size must be positive");
            }

            if (maxQueueBytes <= 0)
            {
                throw new SdkException("validation_error", "max_queue_bytes must be positive");
            }
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
            SerializedByteCount = Encoding.UTF8.GetByteCount(JsonWriter.Write(ToJsonObject()));
        }

        internal int SerializedByteCount { get; }

        internal string Type
        {
            get { return type; }
        }

        internal string Id
        {
            get { return id; }
        }

        internal string Timestamp
        {
            get { return timestamp; }
        }

        internal OrderedJsonObject Attributes
        {
            get { return attributes; }
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

    internal sealed class OrderedJsonObject
    {
        private readonly List<KeyValuePair<string, object?>> values = new List<KeyValuePair<string, object?>>();

        internal IReadOnlyList<KeyValuePair<string, object?>> Values
        {
            get { return values.AsReadOnly(); }
        }

        internal OrderedJsonObject Add(string key, object? value)
        {
            values.Add(new KeyValuePair<string, object?>(key, value));
            return this;
        }

        internal void AddIfNotNull(string key, object? value)
        {
            if (value != null)
            {
                Add(key, value);
            }
        }

        internal void AddMetadata(IDictionary<string, object?>? metadata)
        {
            var copied = Validation.CopyMetadata(metadata);
            if (copied != null)
            {
                Add("metadata", copied);
            }
        }
    }

    internal static class Validation
    {
        private static readonly char[] TimestampSeparator = { 'T' };

        internal static void RequireNonEmpty(string label, string? value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                throw new SdkException("validation_error", label + " must be non-empty");
            }
        }

        internal static void RequireAllowedValue(string label, string value, string[] allowedValues)
        {
            RequireNonEmpty(label, value);
            if (!allowedValues.Contains(value))
            {
                throw new SdkException("validation_error", label + " must be one of: " + string.Join(", ", allowedValues));
            }
        }

        internal static string NormalizeSeverity(string label, string value)
        {
            RequireAllowedValue(label, value, LogBrewClient.SeverityValues);
            return value switch
            {
                "trace" or "debug" or "info" => "info",
                "warn" or "warning" => "warning",
                "error" => "error",
                "fatal" or "critical" => "critical",
                _ => "info",
            };
        }

        internal static void RequireFiniteNumber(string label, double value)
        {
            if (double.IsNaN(value) || double.IsInfinity(value))
            {
                throw new SdkException("validation_error", label + " must be a finite number");
            }
        }

        internal static void RequireTimestamp(string timestamp)
        {
            RequireNonEmpty("timestamp", timestamp);
            if (!HasTimezoneOffset(timestamp))
            {
                throw TimestampError(timestamp);
            }

            if (!DateTimeOffset.TryParse(timestamp, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out _))
            {
                throw new SdkException("validation_error", "timestamp must be a valid ISO-8601 timestamp: " + timestamp);
            }
        }

        internal static OrderedJsonObject? CopyMetadata(IDictionary<string, object?>? metadata)
        {
            if (metadata == null)
            {
                return null;
            }

            var copied = new OrderedJsonObject();
            foreach (var item in metadata)
            {
                RequireNonEmpty("metadata key", item.Key);
                var value = item.Value;
                if (!IsMetadataValue(value))
                {
                    throw new SdkException("validation_error", "metadata value for " + item.Key + " must be a string, number, boolean, or null");
                }

                copied.Add(item.Key, value);
            }

            return copied;
        }

        internal static Dictionary<string, object?> CopyPrimitiveMetadata(IDictionary<string, object?>? metadata)
        {
            var copied = new Dictionary<string, object?>(StringComparer.Ordinal);
            if (metadata == null)
            {
                return copied;
            }

            foreach (var item in metadata)
            {
                if (!string.IsNullOrWhiteSpace(item.Key) && IsMetadataValue(item.Value))
                {
                    copied[item.Key] = item.Value;
                }
            }

            return copied;
        }

        private static SdkException TimestampError(string timestamp)
        {
            return new SdkException("validation_error", "timestamp must include a timezone offset: " + timestamp);
        }

        private static bool HasTimezoneOffset(string timestamp)
        {
            if (TextSearch.EndsWith(timestamp, 'Z'))
            {
                return true;
            }

            var parts = timestamp.Split(TimestampSeparator, 2);
            if (parts.Length < 2)
            {
                return false;
            }

            var timePortion = parts[1];
            return TextSearch.Contains(timePortion, '+') || timePortion.LastIndexOf('-') > 0;
        }

        internal static bool IsMetadataValue(object? value)
        {
            if (value == null || value is string || value is bool)
            {
                return true;
            }

            if (value is byte || value is short || value is int || value is long || value is float || value is double || value is decimal)
            {
                return !IsInvalidNumber(value);
            }

            return false;
        }

        private static bool IsInvalidNumber(object value)
        {
            if (value is double doubleValue)
            {
                return double.IsNaN(doubleValue) || double.IsInfinity(doubleValue);
            }

            if (value is float floatValue)
            {
                return float.IsNaN(floatValue) || float.IsInfinity(floatValue);
            }

            return false;
        }
    }

    internal static class JsonWriter
    {
        internal static string Write(object? value)
        {
            var builder = new StringBuilder();
            WriteValue(builder, value, 0);
            return builder.ToString();
        }

        private static void WriteValue(StringBuilder builder, object? value, int depth)
        {
            if (value == null)
            {
                builder.Append("null");
                return;
            }

            if (value is string stringValue)
            {
                WriteString(builder, stringValue);
                return;
            }

            if (value is bool boolValue)
            {
                builder.Append(boolValue ? "true" : "false");
                return;
            }

            if (value is OrderedJsonObject jsonObject)
            {
                WriteObject(builder, jsonObject, depth);
                return;
            }

            if (value is IEnumerable<OrderedJsonObject> jsonObjects)
            {
                WriteArray(builder, jsonObjects.Cast<object?>(), depth);
                return;
            }

            if (value is IEnumerable<object?> jsonValues)
            {
                WriteArray(builder, jsonValues, depth);
                return;
            }

            if (value is int || value is long || value is short || value is byte || value is double || value is float || value is decimal)
            {
                builder.Append(Convert.ToString(value, CultureInfo.InvariantCulture));
                return;
            }

            throw new SdkException("serialization_error", "unsupported JSON value: " + value.GetType().FullName);
        }

        private static void WriteObject(StringBuilder builder, OrderedJsonObject value, int depth)
        {
            builder.Append('{');
            if (value.Values.Count > 0)
            {
                builder.Append('\n');
                for (var index = 0; index < value.Values.Count; index++)
                {
                    var item = value.Values[index];
                    Indent(builder, depth + 1);
                    WriteString(builder, item.Key);
                    builder.Append(": ");
                    WriteValue(builder, item.Value, depth + 1);
                    if (index < value.Values.Count - 1)
                    {
                        builder.Append(',');
                    }

                    builder.Append('\n');
                }

                Indent(builder, depth);
            }

            builder.Append('}');
        }

        private static void WriteArray(StringBuilder builder, IEnumerable<object?> values, int depth)
        {
            var items = values.ToList();
            builder.Append('[');
            if (items.Count > 0)
            {
                builder.Append('\n');
                for (var index = 0; index < items.Count; index++)
                {
                    Indent(builder, depth + 1);
                    WriteValue(builder, items[index], depth + 1);
                    if (index < items.Count - 1)
                    {
                        builder.Append(',');
                    }

                    builder.Append('\n');
                }

                Indent(builder, depth);
            }

            builder.Append(']');
        }

        private static void WriteString(StringBuilder builder, string value)
        {
            builder.Append('"');
            foreach (var character in value)
            {
                switch (character)
                {
                    case '"':
                        builder.Append("\\\"");
                        break;
                    case '\\':
                        builder.Append("\\\\");
                        break;
                    case '\b':
                        builder.Append("\\b");
                        break;
                    case '\f':
                        builder.Append("\\f");
                        break;
                    case '\n':
                        builder.Append("\\n");
                        break;
                    case '\r':
                        builder.Append("\\r");
                        break;
                    case '\t':
                        builder.Append("\\t");
                        break;
                    default:
                        if (character < 0x20)
                        {
                            builder.Append("\\u");
                            builder.Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            builder.Append(character);
                        }

                        break;
                }
            }

            builder.Append('"');
        }

        private static void Indent(StringBuilder builder, int depth)
        {
            for (var index = 0; index < depth; index++)
            {
                builder.Append("  ");
            }
        }
    }
}
