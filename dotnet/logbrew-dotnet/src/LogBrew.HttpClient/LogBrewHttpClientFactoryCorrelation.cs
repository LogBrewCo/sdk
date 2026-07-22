using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;

namespace LogBrew.HttpClient
{
    /// <summary>
    /// Configures privacy-bounded correlation for one selected <see cref="IHttpClientBuilder"/>.
    /// </summary>
    public sealed class LogBrewHttpClientFactoryOptions
    {
        internal string EventIdPrefix { get; private set; } = "dotnet_http_client_factory";

        internal Func<HttpRequestMessage, bool>? RequestFilter { get; private set; }

        internal Func<string> TimestampProvider { get; private set; } = DefaultTimestamp;

        internal Action<SdkException>? OnErrorCallback { get; private set; }

        /// <summary>
        /// Creates options with the fixed default event identifier prefix and no request filter.
        /// </summary>
        /// <returns>A new mutable options instance for one registration.</returns>
        public static LogBrewHttpClientFactoryOptions Create()
        {
            return new LogBrewHttpClientFactoryOptions();
        }

        /// <summary>
        /// Sets the bounded prefix used to create completion event identifiers.
        /// </summary>
        /// <param name="value">A non-empty prefix. Leading and trailing whitespace is removed.</param>
        /// <returns>This options instance.</returns>
        /// <exception cref="SdkException">Thrown when <paramref name="value"/> is empty.</exception>
        public LogBrewHttpClientFactoryOptions WithEventIdPrefix(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                throw new SdkException("validation_error", "HttpClient correlation eventIdPrefix must be non-empty");
            }

            EventIdPrefix = value.Trim();
            return this;
        }

        /// <summary>
        /// Sets an advisory predicate that selects requests for correlation.
        /// </summary>
        /// <param name="value">The predicate evaluated immediately before an actual send.</param>
        /// <returns>This options instance.</returns>
        /// <exception cref="ArgumentNullException">Thrown when <paramref name="value"/> is null.</exception>
        public LogBrewHttpClientFactoryOptions WithRequestFilter(Func<HttpRequestMessage, bool> value)
        {
            RequestFilter = value ?? throw new ArgumentNullException(nameof(value));
            return this;
        }

        /// <summary>
        /// Sets the timestamp provider used when a completion event is retained.
        /// </summary>
        /// <param name="value">A provider that returns an SDK timestamp string.</param>
        /// <returns>This options instance.</returns>
        /// <exception cref="ArgumentNullException">Thrown when <paramref name="value"/> is null.</exception>
        public LogBrewHttpClientFactoryOptions WithTimestampProvider(Func<string> value)
        {
            TimestampProvider = value ?? throw new ArgumentNullException(nameof(value));
            return this;
        }

        /// <summary>
        /// Sets an advisory callback for fixed SDK correlation failures.
        /// </summary>
        /// <param name="value">The callback. Callback failures never replace application HTTP behavior.</param>
        /// <returns>This options instance.</returns>
        /// <exception cref="ArgumentNullException">Thrown when <paramref name="value"/> is null.</exception>
        public LogBrewHttpClientFactoryOptions OnError(Action<SdkException> value)
        {
            OnErrorCallback = value ?? throw new ArgumentNullException(nameof(value));
            return this;
        }

        private static string DefaultTimestamp()
        {
            return DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture);
        }
    }

    /// <summary>
    /// Adds explicit LogBrew correlation to selected named or typed HTTP clients.
    /// </summary>
    public static class LogBrewHttpClientBuilderExtensions
    {
        /// <summary>
        /// Adds one correlation handler at the caller-selected handler position.
        /// </summary>
        /// <param name="builder">The selected named or typed HTTP client builder.</param>
        /// <param name="client">The LogBrew client that retains completion spans.</param>
        /// <param name="configure">An optional options callback evaluated once during registration.</param>
        /// <returns>The original builder so additional handlers retain caller-defined order.</returns>
        /// <exception cref="ArgumentNullException">
        /// Thrown when <paramref name="builder"/> or <paramref name="client"/> is null.
        /// </exception>
        /// <remarks>Repeated registration for the same client name is idempotent; the first registration wins.</remarks>
        public static IHttpClientBuilder AddLogBrewCorrelation(
            this IHttpClientBuilder builder,
            LogBrewClient client,
            Action<LogBrewHttpClientFactoryOptions>? configure = null)
        {
            ThrowIfNull(builder, nameof(builder));
            ThrowIfNull(client, nameof(client));
            var clientName = builder.Name ?? string.Empty;

            foreach (var descriptor in builder.Services)
            {
                if (descriptor.ServiceType == typeof(LogBrewHttpClientRegistration)
                    && descriptor.ImplementationInstance is LogBrewHttpClientRegistration registration
                    && string.Equals(registration.ClientName, clientName, StringComparison.Ordinal))
                {
                    return builder;
                }
            }

            var options = LogBrewHttpClientFactoryOptions.Create();
            configure?.Invoke(options);
            builder.Services.AddSingleton(new LogBrewHttpClientRegistration(clientName));
            return builder.AddHttpMessageHandler(() => new LogBrewHttpClientCorrelationHandler(client, options));
        }

        private static void ThrowIfNull(object? value, string parameterName)
        {
#if NET8_0_OR_GREATER
            ArgumentNullException.ThrowIfNull(value, parameterName);
#else
            if (value == null)
            {
                throw new ArgumentNullException(parameterName);
            }
#endif
        }
    }

    internal sealed class LogBrewHttpClientRegistration
    {
        internal LogBrewHttpClientRegistration(string clientName)
        {
            ClientName = clientName;
        }

        internal string ClientName { get; }
    }

    internal sealed class LogBrewHttpClientCorrelationHandler : DelegatingHandler
    {
        private const string SdkDeliveryMarker = "LogBrew.HttpClientFactory.SdkDelivery";
        private readonly LogBrewClient client;
        private readonly LogBrewHttpClientFactoryOptions options;

        internal LogBrewHttpClientCorrelationHandler(
            LogBrewClient client,
            LogBrewHttpClientFactoryOptions options)
        {
            this.client = client;
            this.options = options;
        }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            ThrowIfNull(request, nameof(request));

            var parent = LogBrewTrace.Current;
            if (parent == null || IsSdkDelivery(request))
            {
                return await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
            }

            CorrelationOperation? operation;
            try
            {
                if (options.RequestFilter != null && !options.RequestFilter(request))
                {
                    return await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
                }

                operation = CorrelationOperation.Create(client, options, request, parent, cancellationToken);
            }
            catch (Exception error) when (!IsFatal(error))
            {
                ReportError(FixedError("HttpClient correlation setup failed"));
                return await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
            }

            if (!operation.TryInject())
            {
                ReportError(FixedError("HttpClient correlation header setup failed"));
                return await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
            }

            HttpResponseMessage? response = null;
            Exception? requestError = null;
            using (LogBrewTrace.Activate(operation.Trace))
            {
                try
                {
                    response = await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
                    return response;
                }
                catch (Exception error)
                {
                    requestError = error;
                    throw;
                }
                finally
                {
                    if (!operation.TryResetHeader())
                    {
                        ReportError(FixedError("HttpClient correlation header reset failed"));
                    }

                    try
                    {
                        operation.Capture(response, requestError);
                    }
                    catch (SdkException error)
                    {
                        ReportError(error);
                    }
                    catch (Exception error) when (!IsFatal(error))
                    {
                        ReportError(FixedError("HttpClient correlation capture failed"));
                    }
                }
            }
        }

        private static bool IsSdkDelivery(HttpRequestMessage request)
        {
#if NET8_0_OR_GREATER
            return request.Options.TryGetValue(new HttpRequestOptionsKey<bool>(SdkDeliveryMarker), out var marked) && marked;
#else
            return request.Properties.TryGetValue(SdkDeliveryMarker, out var value) && value is bool marked && marked;
#endif
        }

        private static bool IsFatal(Exception error)
        {
            return error is OutOfMemoryException
                || error is StackOverflowException
                || error is AccessViolationException
                || error is AppDomainUnloadedException
                || error is BadImageFormatException;
        }

        private static void ThrowIfNull(object? value, string parameterName)
        {
#if NET8_0_OR_GREATER
            ArgumentNullException.ThrowIfNull(value, parameterName);
#else
            if (value == null)
            {
                throw new ArgumentNullException(parameterName);
            }
#endif
        }

        private static SdkException FixedError(string message)
        {
            return new SdkException("capture_error", message);
        }

        private void ReportError(SdkException error)
        {
            if (options.OnErrorCallback == null)
            {
                return;
            }

            try
            {
                options.OnErrorCallback(error);
            }
            catch (Exception callbackError) when (!IsFatal(callbackError))
            {
            }
        }

        private sealed class CorrelationOperation
        {
            private readonly LogBrewClient client;
            private readonly LogBrewHttpClientFactoryOptions options;
            private readonly HttpRequestMessage request;
            private readonly string method;
            private readonly string? host;
            private readonly string[] originalTraceparents;
            private readonly bool hadTraceparent;
            private readonly CancellationToken cancellationToken;
            private readonly long startedAt;

            private CorrelationOperation(
                LogBrewClient client,
                LogBrewHttpClientFactoryOptions options,
                HttpRequestMessage request,
                string method,
                string? host,
                string[] originalTraceparents,
                bool hadTraceparent,
                LogBrewTraceContext trace,
                CancellationToken cancellationToken)
            {
                this.client = client;
                this.options = options;
                this.request = request;
                this.method = method;
                this.host = host;
                this.originalTraceparents = originalTraceparents;
                this.hadTraceparent = hadTraceparent;
                this.cancellationToken = cancellationToken;
                Trace = trace;
                startedAt = Stopwatch.GetTimestamp();
            }

            internal LogBrewTraceContext Trace { get; }

            internal static CorrelationOperation Create(
                LogBrewClient client,
                LogBrewHttpClientFactoryOptions options,
                HttpRequestMessage request,
                LogBrewTraceContext parent,
                CancellationToken cancellationToken)
            {
                var method = NormalizeMethod(request.Method.Method);
                var host = NormalizeHost(request.RequestUri);
                var hadTraceparent = request.Headers.TryGetValues("traceparent", out var values);
                var originalTraceparents = hadTraceparent ? values!.ToArray() : Array.Empty<string>();
                return new CorrelationOperation(
                    client,
                    options,
                    request,
                    method,
                    host,
                    originalTraceparents,
                    hadTraceparent,
                    LogBrewTraceContext.CreateChild(parent),
                    cancellationToken);
            }

            internal bool TryInject()
            {
                try
                {
                    request.Headers.Remove("traceparent");
                    if (request.Headers.TryAddWithoutValidation("traceparent", Trace.Traceparent))
                    {
                        return true;
                    }

                    TryResetHeader();
                    return false;
                }
                catch (Exception error) when (!IsFatal(error))
                {
                    TryResetHeader();
                    return false;
                }
            }

            internal bool TryResetHeader()
            {
                try
                {
                    request.Headers.Remove("traceparent");
                    return !hadTraceparent || request.Headers.TryAddWithoutValidation("traceparent", originalTraceparents);
                }
                catch (Exception error) when (!IsFatal(error))
                {
                    return false;
                }
            }

            internal void Capture(HttpResponseMessage? response, Exception? requestError)
            {
                var metadata = new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["source"] = "http.client.factory",
                    ["method"] = method,
                    ["sampled"] = Trace.Sampled
                };
                if (host != null)
                {
                    metadata["host"] = host;
                }

                if (response != null)
                {
                    metadata["statusCode"] = (int)response.StatusCode;
                }

                if (requestError != null)
                {
                    metadata["errorType"] = requestError.GetType().FullName;
                    if (requestError is OperationCanceledException && cancellationToken.IsCancellationRequested)
                    {
                        metadata["cancelled"] = true;
                    }
                }

                var status = requestError == null && (response == null || (int)response.StatusCode < 500) ? "ok" : "error";
                var attributes = SpanAttributes.Create("HTTP " + method, Trace.TraceId, Trace.SpanId, status)
                    .WithDurationMs(ElapsedMilliseconds(startedAt))
                    .WithMetadata(metadata);
                if (Trace.ParentSpanId != null)
                {
                    attributes.WithParentSpanId(Trace.ParentSpanId);
                }

                client.Span(
                    options.EventIdPrefix + "_span_" + Trace.SpanId,
                    options.TimestampProvider(),
                    attributes);
            }

            private static string NormalizeMethod(string method)
            {
                if (string.IsNullOrWhiteSpace(method))
                {
                    throw FixedError("HttpClient correlation method is unavailable");
                }

                var normalized = method.Trim().ToUpperInvariant();
                for (var index = 0; index < normalized.Length; index++)
                {
                    var character = normalized[index];
                    if (!((character >= 'A' && character <= 'Z')
                        || (character >= '0' && character <= '9')
                        || character == '-'
                        || character == '_'))
                    {
                        throw FixedError("HttpClient correlation method is unavailable");
                    }
                }

                return normalized;
            }

            private static string? NormalizeHost(Uri? requestUri)
            {
                if (requestUri == null || !requestUri.IsAbsoluteUri || requestUri.HostNameType != UriHostNameType.Dns)
                {
                    return null;
                }

                var normalized = requestUri.IdnHost.TrimEnd('.').ToLowerInvariant();
                if (normalized.Length == 0 || normalized.All(character => (character >= '0' && character <= '9') || character == '.'))
                {
                    return null;
                }

                return normalized;
            }

            private static double ElapsedMilliseconds(long startedAt)
            {
                return (Stopwatch.GetTimestamp() - startedAt) * 1000.0 / Stopwatch.Frequency;
            }
        }
    }
}
