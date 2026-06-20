using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Threading.Tasks;

namespace LogBrew
{
    public static class LogBrewOperationTracing
    {
        public static T DatabaseOperation<T>(
            LogBrewClient client,
            string operationName,
            Func<T> operation,
            DatabaseOperationOptions? options = null)
        {
            var safeOptions = options ?? DatabaseOperationOptions.Create();
            var normalizedOperationName = NormalizeOperationName(operationName);
            return OperationSpan(
                client,
                normalizedOperationName,
                operation,
                safeOptions.Common,
                "database",
                "database.operation",
                safeOptions.EventIdPrefix ?? "dotnet_database",
                DatabaseMetadata(normalizedOperationName, safeOptions));
        }

        public static Task<T> DatabaseOperationAsync<T>(
            LogBrewClient client,
            string operationName,
            Func<Task<T>> operation,
            DatabaseOperationOptions? options = null)
        {
            var safeOptions = options ?? DatabaseOperationOptions.Create();
            var normalizedOperationName = NormalizeOperationName(operationName);
            return OperationSpanAsync(
                client,
                normalizedOperationName,
                operation,
                safeOptions.Common,
                "database",
                "database.operation",
                safeOptions.EventIdPrefix ?? "dotnet_database",
                DatabaseMetadata(normalizedOperationName, safeOptions));
        }

        public static T CacheOperation<T>(
            LogBrewClient client,
            string operationName,
            Func<T> operation,
            CacheOperationOptions? options = null)
        {
            var safeOptions = options ?? CacheOperationOptions.Create();
            var normalizedOperationName = NormalizeOperationName(operationName);
            return OperationSpan(
                client,
                normalizedOperationName,
                operation,
                safeOptions.Common,
                "cache",
                "cache.operation",
                safeOptions.EventIdPrefix ?? "dotnet_cache",
                CacheMetadata(normalizedOperationName, safeOptions));
        }

        public static Task<T> CacheOperationAsync<T>(
            LogBrewClient client,
            string operationName,
            Func<Task<T>> operation,
            CacheOperationOptions? options = null)
        {
            var safeOptions = options ?? CacheOperationOptions.Create();
            var normalizedOperationName = NormalizeOperationName(operationName);
            return OperationSpanAsync(
                client,
                normalizedOperationName,
                operation,
                safeOptions.Common,
                "cache",
                "cache.operation",
                safeOptions.EventIdPrefix ?? "dotnet_cache",
                CacheMetadata(normalizedOperationName, safeOptions));
        }

        public static T QueueOperation<T>(
            LogBrewClient client,
            string operationName,
            Func<T> operation,
            QueueOperationOptions? options = null)
        {
            var safeOptions = options ?? QueueOperationOptions.Create();
            var normalizedOperationName = NormalizeOperationName(operationName);
            return OperationSpan(
                client,
                normalizedOperationName,
                operation,
                safeOptions.Common,
                "queue",
                "queue.operation",
                safeOptions.EventIdPrefix ?? "dotnet_queue",
                QueueMetadata(normalizedOperationName, safeOptions));
        }

        public static Task<T> QueueOperationAsync<T>(
            LogBrewClient client,
            string operationName,
            Func<Task<T>> operation,
            QueueOperationOptions? options = null)
        {
            var safeOptions = options ?? QueueOperationOptions.Create();
            var normalizedOperationName = NormalizeOperationName(operationName);
            return OperationSpanAsync(
                client,
                normalizedOperationName,
                operation,
                safeOptions.Common,
                "queue",
                "queue.operation",
                safeOptions.EventIdPrefix ?? "dotnet_queue",
                QueueMetadata(normalizedOperationName, safeOptions));
        }

        private static T OperationSpan<T>(
            LogBrewClient client,
            string operationName,
            Func<T> operation,
            CommonOptions options,
            string spanNamePrefix,
            string source,
            string eventIdPrefix,
            IDictionary<string, object?> metadata)
        {
            if (client == null)
            {
                throw new ArgumentNullException(nameof(client));
            }

            if (operation == null)
            {
                throw new ArgumentNullException(nameof(operation));
            }

            var trace = CreateChildTrace();
            var startedAt = Stopwatch.GetTimestamp();
            Exception? operationError = null;
            using (LogBrewTrace.Activate(trace))
            {
                try
                {
                    return operation();
                }
                catch (Exception error)
                {
                    operationError = error;
                    throw;
                }
                finally
                {
                    CaptureSpan(client, eventIdPrefix, spanNamePrefix, operationName, source, trace, metadata, operationError, startedAt, options.OnError);
                }
            }
        }

        private static async Task<T> OperationSpanAsync<T>(
            LogBrewClient client,
            string operationName,
            Func<Task<T>> operation,
            CommonOptions options,
            string spanNamePrefix,
            string source,
            string eventIdPrefix,
            IDictionary<string, object?> metadata)
        {
            if (client == null)
            {
                throw new ArgumentNullException(nameof(client));
            }

            if (operation == null)
            {
                throw new ArgumentNullException(nameof(operation));
            }

            var trace = CreateChildTrace();
            var startedAt = Stopwatch.GetTimestamp();
            Exception? operationError = null;
            using (LogBrewTrace.Activate(trace))
            {
                try
                {
                    return await operation().ConfigureAwait(false);
                }
                catch (Exception error)
                {
                    operationError = error;
                    throw;
                }
                finally
                {
                    CaptureSpan(client, eventIdPrefix, spanNamePrefix, operationName, source, trace, metadata, operationError, startedAt, options.OnError);
                }
            }
        }

        private static LogBrewTraceContext CreateChildTrace()
        {
            var current = LogBrewTrace.Current;
            return current == null ? LogBrewTraceContext.CreateRoot() : LogBrewTraceContext.CreateChild(current);
        }

        private static string NormalizeOperationName(string operationName)
        {
            Validation.RequireNonEmpty("operation name", operationName);
            return operationName.Trim();
        }

        private static void CaptureSpan(
            LogBrewClient client,
            string eventIdPrefix,
            string spanNamePrefix,
            string operationName,
            string source,
            LogBrewTraceContext trace,
            IDictionary<string, object?> baseMetadata,
            Exception? operationError,
            long startedAt,
            Action<SdkException>? onError)
        {
            var finishedAt = DateTimeOffset.UtcNow;
            var metadata = new Dictionary<string, object?>(baseMetadata, StringComparer.Ordinal);
            metadata["source"] = source;
            metadata["sampled"] = trace.Sampled;
            if (operationError != null)
            {
                metadata["errorType"] = operationError.GetType().FullName;
            }

            var attributes = SpanAttributes.Create(
                    spanNamePrefix + ":" + operationName,
                    trace.TraceId,
                    trace.SpanId,
                    operationError == null ? "ok" : "error")
                .WithDurationMs(ElapsedMilliseconds(startedAt))
                .WithMetadata(metadata);
            if (trace.ParentSpanId != null)
            {
                attributes.WithParentSpanId(trace.ParentSpanId);
            }

            try
            {
                client.Span(
                    eventIdPrefix + "_span_" + trace.SpanId,
                    finishedAt.ToString("O", CultureInfo.InvariantCulture),
                    attributes);
            }
            catch (SdkException error)
            {
                ReportCaptureError(onError, error);
            }
        }

        private static void ReportCaptureError(Action<SdkException>? onError, SdkException error)
        {
            if (onError == null)
            {
                return;
            }

            try
            {
                onError(error);
            }
            catch
            {
                // Preserve the app-owned operation result even if diagnostics handling fails.
            }
        }

        private static double ElapsedMilliseconds(long startedAt)
        {
            return (Stopwatch.GetTimestamp() - startedAt) * 1000.0 / Stopwatch.Frequency;
        }

        private static IDictionary<string, object?> DatabaseMetadata(string operationName, DatabaseOperationOptions options)
        {
            var metadata = SafeMetadata(options.Common.Metadata);
            AddString(metadata, "dbSystem", options.System);
            AddString(metadata, "dbOperation", operationName);
            AddString(metadata, "dbOperationKind", options.OperationKind);
            AddString(metadata, "dbName", options.DatabaseName);
            AddString(metadata, "dbStatementTemplate", options.StatementTemplate);
            AddNonNegativeInt(metadata, "rowCount", options.RowCount);
            return metadata;
        }

        private static IDictionary<string, object?> CacheMetadata(string operationName, CacheOperationOptions options)
        {
            var metadata = SafeMetadata(options.Common.Metadata);
            AddString(metadata, "cacheSystem", options.System);
            AddString(metadata, "cacheOperation", operationName);
            AddString(metadata, "cacheOperationKind", options.OperationKind);
            AddString(metadata, "cacheName", options.CacheName);
            if (options.Hit.HasValue)
            {
                metadata["cacheHit"] = options.Hit.Value;
            }

            AddNonNegativeInt(metadata, "itemSizeBytes", options.ItemSizeBytes);
            AddNonNegativeInt(metadata, "itemCount", options.ItemCount);
            return metadata;
        }

        private static IDictionary<string, object?> QueueMetadata(string operationName, QueueOperationOptions options)
        {
            var metadata = SafeMetadata(options.Common.Metadata);
            AddString(metadata, "queueSystem", options.System);
            AddString(metadata, "queueOperation", operationName);
            AddString(metadata, "queueOperationKind", options.OperationKind);
            AddString(metadata, "queueName", options.QueueName);
            AddString(metadata, "taskName", options.TaskName);
            AddNonNegativeInt(metadata, "messageCount", options.MessageCount);
            return metadata;
        }

        private static Dictionary<string, object?> SafeMetadata(IDictionary<string, object?>? metadata)
        {
            return TelemetryMetadata.CopySafeDependencyMetadata(metadata);
        }

        private static void AddString(IDictionary<string, object?> metadata, string key, string? value)
        {
            if (!string.IsNullOrWhiteSpace(value))
            {
                metadata[key] = value!.Trim();
            }
        }

        private static void AddNonNegativeInt(IDictionary<string, object?> metadata, string key, int? value)
        {
            if (value.HasValue)
            {
                if (value.Value < 0)
                {
                    throw new SdkException("validation_error", key + " must be non-negative");
                }

                metadata[key] = value.Value;
            }
        }

        public sealed class DatabaseOperationOptions
        {
            internal CommonOptions Common { get; } = new CommonOptions();

            public string? EventIdPrefix
            {
                get { return Common.EventIdPrefix; }
            }

            public string? System { get; private set; }

            public string? OperationKind { get; private set; }

            public string? DatabaseName { get; private set; }

            public string? StatementTemplate { get; private set; }

            public int? RowCount { get; private set; }

            public static DatabaseOperationOptions Create()
            {
                return new DatabaseOperationOptions();
            }

            public DatabaseOperationOptions WithEventIdPrefix(string value)
            {
                Common.EventIdPrefix = value;
                return this;
            }

            public DatabaseOperationOptions WithMetadata(IDictionary<string, object?> value)
            {
                Common.Metadata = value;
                return this;
            }

            public DatabaseOperationOptions OnError(Action<SdkException> value)
            {
                Common.OnError = value;
                return this;
            }

            public DatabaseOperationOptions WithSystem(string value)
            {
                System = value;
                return this;
            }

            public DatabaseOperationOptions WithOperationKind(string value)
            {
                OperationKind = value;
                return this;
            }

            public DatabaseOperationOptions WithDatabaseName(string value)
            {
                DatabaseName = value;
                return this;
            }

            public DatabaseOperationOptions WithStatementTemplate(string value)
            {
                StatementTemplate = value;
                return this;
            }

            public DatabaseOperationOptions WithRowCount(int value)
            {
                RowCount = value;
                return this;
            }
        }

        public sealed class CacheOperationOptions
        {
            internal CommonOptions Common { get; } = new CommonOptions();

            public string? EventIdPrefix
            {
                get { return Common.EventIdPrefix; }
            }

            public string? System { get; private set; }

            public string? OperationKind { get; private set; }

            public string? CacheName { get; private set; }

            public bool? Hit { get; private set; }

            public int? ItemSizeBytes { get; private set; }

            public int? ItemCount { get; private set; }

            public static CacheOperationOptions Create()
            {
                return new CacheOperationOptions();
            }

            public CacheOperationOptions WithEventIdPrefix(string value)
            {
                Common.EventIdPrefix = value;
                return this;
            }

            public CacheOperationOptions WithMetadata(IDictionary<string, object?> value)
            {
                Common.Metadata = value;
                return this;
            }

            public CacheOperationOptions OnError(Action<SdkException> value)
            {
                Common.OnError = value;
                return this;
            }

            public CacheOperationOptions WithSystem(string value)
            {
                System = value;
                return this;
            }

            public CacheOperationOptions WithOperationKind(string value)
            {
                OperationKind = value;
                return this;
            }

            public CacheOperationOptions WithCacheName(string value)
            {
                CacheName = value;
                return this;
            }

            public CacheOperationOptions WithHit(bool value)
            {
                Hit = value;
                return this;
            }

            public CacheOperationOptions WithItemSizeBytes(int value)
            {
                ItemSizeBytes = value;
                return this;
            }

            public CacheOperationOptions WithItemCount(int value)
            {
                ItemCount = value;
                return this;
            }
        }

        public sealed class QueueOperationOptions
        {
            internal CommonOptions Common { get; } = new CommonOptions();

            public string? EventIdPrefix
            {
                get { return Common.EventIdPrefix; }
            }

            public string? System { get; private set; }

            public string? OperationKind { get; private set; }

            public string? QueueName { get; private set; }

            public string? TaskName { get; private set; }

            public int? MessageCount { get; private set; }

            public static QueueOperationOptions Create()
            {
                return new QueueOperationOptions();
            }

            public QueueOperationOptions WithEventIdPrefix(string value)
            {
                Common.EventIdPrefix = value;
                return this;
            }

            public QueueOperationOptions WithMetadata(IDictionary<string, object?> value)
            {
                Common.Metadata = value;
                return this;
            }

            public QueueOperationOptions OnError(Action<SdkException> value)
            {
                Common.OnError = value;
                return this;
            }

            public QueueOperationOptions WithSystem(string value)
            {
                System = value;
                return this;
            }

            public QueueOperationOptions WithOperationKind(string value)
            {
                OperationKind = value;
                return this;
            }

            public QueueOperationOptions WithQueueName(string value)
            {
                QueueName = value;
                return this;
            }

            public QueueOperationOptions WithTaskName(string value)
            {
                TaskName = value;
                return this;
            }

            public QueueOperationOptions WithMessageCount(int value)
            {
                MessageCount = value;
                return this;
            }
        }

        internal sealed class CommonOptions
        {
            internal string? EventIdPrefix { get; set; }

            internal IDictionary<string, object?>? Metadata { get; set; }

            internal Action<SdkException>? OnError { get; set; }
        }
    }
}
