#nullable enable

using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace LogBrew.Unity
{
    public sealed class SdkException : Exception
    {
        public SdkException()
            : this("sdk_error", "SDK error")
        {
        }

        public SdkException(string message)
            : this("sdk_error", message)
        {
        }

        public SdkException(string message, Exception innerException)
            : base("sdk_error: " + message, innerException)
        {
            Code = "sdk_error";
            DetailMessage = message;
        }

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
        public TransportException()
            : this("transport_error", "Transport error")
        {
        }

        public TransportException(string message)
            : this("transport_error", message)
        {
        }

        public TransportException(string message, Exception innerException)
            : base(message, innerException)
        {
            Code = "transport_error";
            Retryable = false;
        }

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
        {
            StatusCode = statusCode;
            Attempts = attempts;
        }

        public int StatusCode { get; }

        public int Attempts { get; }
    }

    public interface ITransport
    {
        TransportResponse Send(string apiKey, string body);
    }

    public delegate int HttpTransportRequester(HttpTransportRequest request);

    public sealed class HttpTransportRequest
    {
        internal HttpTransportRequest(Uri endpoint, IReadOnlyDictionary<string, string> headers, string body, TimeSpan timeout)
        {
            Endpoint = endpoint;
            Headers = headers;
            Body = body;
            Timeout = timeout;
        }

        public Uri Endpoint { get; }

        public IReadOnlyDictionary<string, string> Headers { get; }

        public string Body { get; }

        public TimeSpan Timeout { get; }
    }

    public sealed class HttpTransport : ITransport, IDisposable
    {
        public static readonly Uri DefaultEndpoint = new Uri("https://api.logbrew.com/v1/events", UriKind.Absolute);

        public static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(10);

        private static readonly HttpClient SharedHttpClient = new HttpClient
        {
            Timeout = DefaultTimeout
        };

        private readonly IReadOnlyDictionary<string, string> headers;
        private readonly HttpTransportRequester? requester;
        private readonly bool ownsHttpClient;
        private bool disposed;

        public HttpTransport()
            : this(DefaultEndpoint)
        {
        }

        public HttpTransport(Uri endpoint)
            : this(endpoint, null)
        {
        }

        public HttpTransport(Uri endpoint, IDictionary<string, string>? headers)
            : this(endpoint, headers, DefaultTimeout, null, null)
        {
        }

        public HttpTransport(
            Uri endpoint,
            IDictionary<string, string>? headers,
            TimeSpan timeout,
            HttpClient? httpClient = null,
            HttpTransportRequester? requester = null)
        {
            Endpoint = ValidateEndpoint(endpoint);
            Timeout = ValidateTimeout(timeout);
            HttpClient = httpClient ?? DefaultClient(Timeout, out ownsHttpClient);
            this.headers = CopyHeaders(headers);
            this.requester = requester;
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

            var request = new HttpTransportRequest(Endpoint, RequestHeaders(apiKey), body, Timeout);
            if (requester != null)
            {
                return new TransportResponse(requester(request), 1);
            }

            return new TransportResponse(SendWithHttpClient(request), 1);
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
            if (endpoint == null)
            {
                throw new SdkException("configuration_error", "HTTP transport endpoint must be non-null");
            }

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

        private Dictionary<string, string> RequestHeaders(string apiKey)
        {
            var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["content-type"] = "application/json",
                ["authorization"] = "Bearer " + apiKey
            };
            foreach (var pair in headers)
            {
                values[pair.Key] = pair.Value;
            }

            return values;
        }

        private int SendWithHttpClient(HttpTransportRequest request)
        {
            try
            {
                return SendWithHttpClientAsync(request).GetAwaiter().GetResult();
            }
            catch (HttpRequestException error)
            {
                throw TransportException.Network("http transport failed: " + error.Message);
            }
            catch (TaskCanceledException error)
            {
                throw TransportException.Network("http transport failed: " + error.Message);
            }
            catch (OperationCanceledException error)
            {
                throw TransportException.Network("http transport failed: " + error.Message);
            }
            catch (InvalidOperationException error)
            {
                throw new SdkException("configuration_error", "invalid HTTP transport request: " + error.Message);
            }
        }

        private async Task<int> SendWithHttpClientAsync(HttpTransportRequest request)
        {
            using var httpRequest = new HttpRequestMessage(HttpMethod.Post, request.Endpoint);
            using var content = new StringContent(request.Body, Encoding.UTF8, "application/json");
            using var cancellation = new CancellationTokenSource();
            httpRequest.Content = content;
            AddHeaders(httpRequest, request.Headers);
            cancellation.CancelAfter(request.Timeout);
            using var response = await HttpClient.SendAsync(httpRequest, cancellation.Token).ConfigureAwait(false);
            return (int)response.StatusCode;
        }

        private static void AddHeaders(HttpRequestMessage request, IReadOnlyDictionary<string, string> requestHeaders)
        {
            foreach (var pair in requestHeaders)
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
                return new TransportResponse(response.StatusCode, 1);
            }

            if (next is int statusCode)
            {
                return new TransportResponse(statusCode, 1);
            }

            throw new SdkException("transport_error", "invalid scripted transport response");
        }
    }

    public sealed class UnityContext
    {
        private readonly Dictionary<string, object?> metadata;

        private UnityContext()
        {
            metadata = new Dictionary<string, object?>();
        }

        public static UnityContext Create()
        {
            return new UnityContext();
        }

        public UnityContext WithPlatform(string platform)
        {
            Validation.RequireNonEmpty("unity platform", platform);
            metadata["platform"] = platform;
            return this;
        }

        public UnityContext WithSceneName(string sceneName)
        {
            Validation.RequireNonEmpty("unity sceneName", sceneName);
            metadata["sceneName"] = sceneName;
            return this;
        }

        public UnityContext WithGameObjectName(string gameObjectName)
        {
            Validation.RequireNonEmpty("unity gameObjectName", gameObjectName);
            metadata["gameObjectName"] = gameObjectName;
            return this;
        }

        public UnityContext WithSessionId(string sessionId)
        {
            Validation.RequireNonEmpty("unity sessionId", sessionId);
            metadata["sessionId"] = sessionId;
            return this;
        }

        public UnityContext WithFrame(int frame)
        {
            if (frame < 0)
            {
                throw new SdkException("validation_error", "unity frame must be non-negative");
            }

            metadata["frame"] = frame;
            return this;
        }

        public UnityContext WithMetadata(string key, object? value)
        {
            Validation.RequireNonEmpty("unity metadata key", key);
            metadata[key] = Validation.RequireMetadataValue(key, value);
            return this;
        }

        internal IDictionary<string, object?> ToMetadata()
        {
            return new Dictionary<string, object?>(metadata);
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
            Validation.RequireAllowedValue("issue level", Level, LogBrewClient.IssueLevels);
            var payload = new OrderedJsonObject().Add("title", Title).Add("level", Level);
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
            Validation.RequireAllowedValue("log level", Level, LogBrewClient.LogLevels);
            var payload = new OrderedJsonObject().Add("message", Message).Add("level", Level);
            payload.AddIfNotNull("logger", Logger);
            payload.AddMetadata(Metadata);
            return payload;
        }
    }

    public sealed class SpanAttributes
    {
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
}
