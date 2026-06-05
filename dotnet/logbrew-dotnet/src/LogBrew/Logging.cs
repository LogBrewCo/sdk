using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;
using Microsoft.Extensions.Logging;

namespace LogBrew
{
    public sealed class LogBrewLoggerOptions
    {
        private string eventIdPrefix = "dotnet_log";

        public LogLevel MinimumLevel { get; set; } = LogLevel.Information;

        public IDictionary<string, object?>? Metadata { get; set; }

        public ITransport? Transport { get; set; }

        public bool FlushOnLog { get; set; }

        public bool IncludeExceptionStackTrace { get; set; }

        public Func<DateTimeOffset>? TimestampProvider { get; set; }

        public Action<Exception>? OnError { get; set; }

        public string EventIdPrefix
        {
            get
            {
                return eventIdPrefix;
            }

            set
            {
                Validation.RequireNonEmpty("event id prefix", value);
                eventIdPrefix = value;
            }
        }

        internal LogBrewLoggerOptions Snapshot()
        {
            return new LogBrewLoggerOptions
            {
                MinimumLevel = MinimumLevel,
                Metadata = LogBrewLoggingMetadata.CopyPrimitiveMetadata(Metadata),
                Transport = Transport,
                FlushOnLog = FlushOnLog,
                IncludeExceptionStackTrace = IncludeExceptionStackTrace,
                TimestampProvider = TimestampProvider,
                OnError = OnError,
                EventIdPrefix = EventIdPrefix
            };
        }
    }

    public sealed class LogBrewLoggerProvider : ILoggerProvider, ISupportExternalScope
    {
        private readonly LogBrewClient client;
        private readonly LogBrewLoggerOptions options;
        private readonly object gate = new object();
        private IExternalScopeProvider? scopeProvider;
        private long nextEventNumber;
        private bool disposed;

        public LogBrewLoggerProvider(LogBrewClient client, LogBrewLoggerOptions? options = null)
        {
            this.client = client ?? throw new ArgumentNullException(nameof(client));
            this.options = (options ?? new LogBrewLoggerOptions()).Snapshot();
        }

        public ILogger CreateLogger(string categoryName)
        {
            ThrowIfDisposed();
            Validation.RequireNonEmpty("logger category", categoryName);
            return new LogBrewLogger(this, categoryName);
        }

        public void SetScopeProvider(IExternalScopeProvider scopeProvider)
        {
            this.scopeProvider = scopeProvider ?? throw new ArgumentNullException(nameof(scopeProvider));
        }

        public void Dispose()
        {
            disposed = true;
        }

        internal bool IsEnabled(LogLevel logLevel)
        {
            return !disposed && logLevel != LogLevel.None && logLevel >= options.MinimumLevel;
        }

        internal IDisposable? BeginScope<TState>(TState state)
            where TState : notnull
        {
            return scopeProvider?.Push(state);
        }

        internal void Write<TState>(
            string categoryName,
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel))
            {
                return;
            }

            var message = formatter(state, exception);
            if (string.IsNullOrWhiteSpace(message))
            {
                message = exception?.Message ?? logLevel.ToString();
            }

            var metadata = LogBrewLoggingMetadata.Create(
                categoryName,
                logLevel,
                eventId,
                state,
                exception,
                options,
                scopeProvider);

            var eventNumber = Interlocked.Increment(ref nextEventNumber);
            var timestamp = Timestamp();

            lock (gate)
            {
                try
                {
                    client.Log(
                        options.EventIdPrefix + "_" + eventNumber.ToString(CultureInfo.InvariantCulture),
                        timestamp,
                        LogAttributes.Create(message, LogBrewLoggingMetadata.ToLogBrewLevel(logLevel))
                            .WithLogger(categoryName)
                            .WithMetadata(metadata));

                    if (options.FlushOnLog && options.Transport != null)
                    {
                        client.Flush(options.Transport);
                    }
                }
                catch (SdkException error)
                {
                    options.OnError?.Invoke(error);
                }
#pragma warning disable CA1031
                catch (Exception error)
                {
                    options.OnError?.Invoke(error);
                }
            }
        }

        private string Timestamp()
        {
            var provider = options.TimestampProvider;
            var timestamp = provider == null ? DateTimeOffset.UtcNow : provider();
            return timestamp.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);
        }

        private void ThrowIfDisposed()
        {
            if (disposed)
            {
                throw new ObjectDisposedException(nameof(LogBrewLoggerProvider));
            }
        }
    }

    public static class LogBrewLoggingBuilderExtensions
    {
        public static ILoggingBuilder AddLogBrew(
            this ILoggingBuilder builder,
            LogBrewClient client,
            LogBrewLoggerOptions? options = null)
        {
            if (builder == null)
            {
                throw new ArgumentNullException(nameof(builder));
            }

            builder.AddProvider(new LogBrewLoggerProvider(client, options));
            return builder;
        }
    }

    internal sealed class LogBrewLogger : ILogger
    {
        private readonly LogBrewLoggerProvider provider;
        private readonly string categoryName;

        internal LogBrewLogger(LogBrewLoggerProvider provider, string categoryName)
        {
            this.provider = provider;
            this.categoryName = categoryName;
        }

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull
        {
            return provider.BeginScope(state);
        }

        public bool IsEnabled(LogLevel logLevel)
        {
            return provider.IsEnabled(logLevel);
        }

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (formatter == null)
            {
                throw new ArgumentNullException(nameof(formatter));
            }

            provider.Write(categoryName, logLevel, eventId, state, exception, formatter);
        }
    }

    internal static class LogBrewLoggingMetadata
    {
        internal static string ToLogBrewLevel(LogLevel logLevel)
        {
            switch (logLevel)
            {
                case LogLevel.Trace:
                case LogLevel.Debug:
                    return "debug";
                case LogLevel.Information:
                    return "info";
                case LogLevel.Warning:
                    return "warning";
                case LogLevel.Error:
                case LogLevel.Critical:
                    return "error";
                default:
                    return "info";
            }
        }

        internal static IDictionary<string, object?> Create<TState>(
            string categoryName,
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            LogBrewLoggerOptions options,
            IExternalScopeProvider? scopeProvider)
        {
            var metadata = CopyPrimitiveMetadata(options.Metadata) ?? new Dictionary<string, object?>(StringComparer.Ordinal);
            AddPrimitive(metadata, "dotnetCategory", categoryName);
            AddPrimitive(metadata, "dotnetLogLevel", logLevel.ToString());
            if (eventId.Id != 0)
            {
                AddPrimitive(metadata, "dotnetEventId", eventId.Id);
            }

            if (!string.IsNullOrWhiteSpace(eventId.Name))
            {
                AddPrimitive(metadata, "dotnetEventName", eventId.Name);
            }

            AddStructuredValues(metadata, state, prefix: null);
            AddException(metadata, exception, options.IncludeExceptionStackTrace);
            scopeProvider?.ForEachScope((scope, values) => AddStructuredValues(values, scope, "scope."), metadata);
            return metadata;
        }

        internal static IDictionary<string, object?>? CopyPrimitiveMetadata(IDictionary<string, object?>? metadata)
        {
            if (metadata == null)
            {
                return null;
            }

            var copied = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var item in metadata)
            {
                AddPrimitive(copied, item.Key, item.Value);
            }

            return copied;
        }

        private static void AddStructuredValues<TState>(IDictionary<string, object?> metadata, TState state, string? prefix)
        {
            if (state == null)
            {
                return;
            }

            if (state is IEnumerable<KeyValuePair<string, object?>> pairs)
            {
                foreach (var pair in pairs)
                {
                    var key = pair.Key == "{OriginalFormat}" ? "messageTemplate" : pair.Key;
                    AddPrimitive(metadata, (prefix ?? string.Empty) + key, pair.Value);
                }

                return;
            }

            if (state is string text)
            {
                AddPrimitive(metadata, (prefix ?? string.Empty) + "state", text);
                return;
            }

            AddPrimitive(metadata, (prefix ?? string.Empty) + "state", state);
        }

        private static void AddException(IDictionary<string, object?> metadata, Exception? exception, bool includeStackTrace)
        {
            if (exception == null)
            {
                return;
            }

            AddPrimitive(metadata, "exceptionType", exception.GetType().FullName);
            AddPrimitive(metadata, "exceptionMessage", exception.Message);
            if (includeStackTrace)
            {
                AddPrimitive(metadata, "exceptionStackTrace", exception.StackTrace);
            }
        }

        private static void AddPrimitive(IDictionary<string, object?> metadata, string key, object? value)
        {
            if (string.IsNullOrWhiteSpace(key) || !IsPrimitive(value))
            {
                return;
            }

            metadata[key] = value;
        }

        private static bool IsPrimitive(object? value)
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
}
