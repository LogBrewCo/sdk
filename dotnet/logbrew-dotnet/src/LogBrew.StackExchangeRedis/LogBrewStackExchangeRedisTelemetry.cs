using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Threading.Tasks;
using StackExchange.Redis;

namespace LogBrew.StackExchangeRedis
{
    public sealed class LogBrewStackExchangeRedisCommandOptions
    {
        internal string? EventIdPrefix { get; private set; }

        internal IDictionary<string, object?>? Metadata { get; private set; }

        internal Action<SdkException>? OnErrorCallback { get; private set; }

        internal string? CacheName { get; private set; }

        internal bool? CacheHit { get; private set; }

        internal int? ResultCount { get; private set; }

        internal long? ResultSizeBytes { get; private set; }

        public static LogBrewStackExchangeRedisCommandOptions Create()
        {
            return new LogBrewStackExchangeRedisCommandOptions();
        }

        public LogBrewStackExchangeRedisCommandOptions WithEventIdPrefix(string value)
        {
            RequireNonEmpty("StackExchange.Redis event id prefix", value);
            EventIdPrefix = value.Trim();
            return this;
        }

        public LogBrewStackExchangeRedisCommandOptions WithMetadata(IDictionary<string, object?> value)
        {
            Metadata = value;
            return this;
        }

        public LogBrewStackExchangeRedisCommandOptions OnError(Action<SdkException> value)
        {
            OnErrorCallback = value;
            return this;
        }

        public LogBrewStackExchangeRedisCommandOptions WithCacheName(string value)
        {
            RequireNonEmpty("StackExchange.Redis cache name", value);
            CacheName = value.Trim();
            return this;
        }

        public LogBrewStackExchangeRedisCommandOptions WithCacheHit(bool value)
        {
            CacheHit = value;
            return this;
        }

        public LogBrewStackExchangeRedisCommandOptions WithResultCount(int value)
        {
            RequireNonNegative("StackExchange.Redis result count", value);
            ResultCount = value;
            return this;
        }

        public LogBrewStackExchangeRedisCommandOptions WithResultSizeBytes(long value)
        {
            RequireNonNegative("StackExchange.Redis result size bytes", value);
            ResultSizeBytes = value;
            return this;
        }

        private static void RequireNonEmpty(string label, string? value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                throw new SdkException("validation_error", label + " must be non-empty");
            }
        }

        private static void RequireNonNegative(string label, long value)
        {
            if (value < 0)
            {
                throw new SdkException("validation_error", label + " must be non-negative");
            }
        }
    }

    public static class LogBrewStackExchangeRedisTelemetry
    {
        private const string Source = "stackexchange_redis.command";
        private const string FrameworkName = "stackexchange.redis";
        private const string DefaultEventIdPrefix = "dotnet_stackexchange_redis";

        public static T TraceLogBrewCommand<T>(
            this IDatabase database,
            LogBrewClient client,
            string commandName,
            Func<IDatabase, T> execute,
            LogBrewStackExchangeRedisCommandOptions? options = null)
        {
            if (database == null)
            {
                throw new ArgumentNullException(nameof(database));
            }

            if (execute == null)
            {
                throw new ArgumentNullException(nameof(execute));
            }

            return TraceCommand(client, database, commandName, () => execute(database), options);
        }

        public static Task<T> TraceLogBrewCommandAsync<T>(
            this IDatabaseAsync database,
            LogBrewClient client,
            string commandName,
            Func<IDatabaseAsync, Task<T>> execute,
            LogBrewStackExchangeRedisCommandOptions? options = null)
        {
            if (database == null)
            {
                throw new ArgumentNullException(nameof(database));
            }

            if (execute == null)
            {
                throw new ArgumentNullException(nameof(execute));
            }

            return TraceCommandAsync(client, database, commandName, () => execute(database), options);
        }

        private static T TraceCommand<T>(
            LogBrewClient client,
            object database,
            string commandName,
            Func<T> execute,
            LogBrewStackExchangeRedisCommandOptions? options)
        {
            ValidateInputs(client, execute);
            var safeOptions = options ?? LogBrewStackExchangeRedisCommandOptions.Create();
            var command = NormalizeCommandName(commandName);
            var operationKind = OperationKind(command);
            var trace = CreateChildTrace();
            var startedAt = Stopwatch.GetTimestamp();
            Exception? commandError = null;
            var result = default(T)!;
            var hasResult = false;

            using (LogBrewTrace.Activate(trace))
            {
                try
                {
                    result = execute();
                    hasResult = true;
                    return result;
                }
                catch (Exception error)
                {
                    commandError = error;
                    throw;
                }
                finally
                {
                    CaptureCommandSpan(
                        client,
                        database,
                        safeOptions,
                        command,
                        operationKind,
                        trace,
                        startedAt,
                        commandError,
                        hasResult ? result : default);
                }
            }
        }

        private static async Task<T> TraceCommandAsync<T>(
            LogBrewClient client,
            object database,
            string commandName,
            Func<Task<T>> execute,
            LogBrewStackExchangeRedisCommandOptions? options)
        {
            ValidateInputs(client, execute);
            var safeOptions = options ?? LogBrewStackExchangeRedisCommandOptions.Create();
            var command = NormalizeCommandName(commandName);
            var operationKind = OperationKind(command);
            var trace = CreateChildTrace();
            var startedAt = Stopwatch.GetTimestamp();
            Exception? commandError = null;
            var result = default(T)!;
            var hasResult = false;

            using (LogBrewTrace.Activate(trace))
            {
                try
                {
                    result = await execute().ConfigureAwait(false);
                    hasResult = true;
                    return result;
                }
                catch (Exception error)
                {
                    commandError = error;
                    throw;
                }
                finally
                {
                    CaptureCommandSpan(
                        client,
                        database,
                        safeOptions,
                        command,
                        operationKind,
                        trace,
                        startedAt,
                        commandError,
                        hasResult ? result : default);
                }
            }
        }

        private static void ValidateInputs<T>(LogBrewClient client, T execute)
        {
            if (client == null)
            {
                throw new ArgumentNullException(nameof(client));
            }

            if (execute == null)
            {
                throw new ArgumentNullException(nameof(execute));
            }
        }

        private static LogBrewTraceContext CreateChildTrace()
        {
            var current = LogBrewTrace.Current;
            return current == null ? LogBrewTraceContext.CreateRoot() : LogBrewTraceContext.CreateChild(current);
        }

        private static void CaptureCommandSpan(
            LogBrewClient client,
            object database,
            LogBrewStackExchangeRedisCommandOptions options,
            string command,
            string operationKind,
            LogBrewTraceContext trace,
            long startedAt,
            Exception? commandError,
            object? result)
        {
            var finishedAt = DateTimeOffset.UtcNow;
            var metadata = CommandMetadata(database, options, command, operationKind, trace, commandError, result);
            var attributes = SpanAttributes.Create(
                    Source + ":" + command,
                    trace.TraceId,
                    trace.SpanId,
                    commandError == null ? "ok" : "error")
                .WithDurationMs(ElapsedMilliseconds(startedAt))
                .WithMetadata(metadata);

            if (trace.ParentSpanId != null)
            {
                attributes.WithParentSpanId(trace.ParentSpanId);
            }

            if (commandError != null)
            {
                attributes.WithEvent(SpanEventSummary.Create("exception").WithMetadata(new Dictionary<string, object?>
                {
                    ["exceptionType"] = commandError.GetType().FullName,
                    ["exceptionEscaped"] = true
                }));
            }

            try
            {
                client.Span(
                    (options.EventIdPrefix ?? DefaultEventIdPrefix) + "_span_" + trace.SpanId,
                    finishedAt.ToString("O", CultureInfo.InvariantCulture),
                    attributes);
            }
            catch (SdkException error)
            {
                ReportCaptureError(options.OnErrorCallback, error);
            }
        }

        private static IDictionary<string, object?> CommandMetadata(
            object database,
            LogBrewStackExchangeRedisCommandOptions options,
            string command,
            string operationKind,
            LogBrewTraceContext trace,
            Exception? commandError,
            object? result)
        {
            var metadata = CopySafeDependencyMetadata(options.Metadata);
            metadata["source"] = Source;
            metadata["framework"] = FrameworkName;
            metadata["cacheSystem"] = "redis";
            metadata["cacheOperation"] = command;
            metadata["cacheOperationKind"] = operationKind;
            metadata["sampled"] = trace.Sampled;

            AddString(metadata, "cacheName", options.CacheName);
            var databaseIndex = TryGetDatabaseIndex(database);
            if (databaseIndex.HasValue && databaseIndex.Value >= 0)
            {
                metadata["redisDatabaseIndex"] = databaseIndex.Value;
            }

            AddResultMetadata(metadata, command, operationKind, result);
            AddOptionResultMetadata(metadata, options);

            if (commandError != null)
            {
                metadata["errorType"] = commandError.GetType().FullName;
            }

            return metadata;
        }

        private static void AddResultMetadata(IDictionary<string, object?> metadata, string command, string operationKind, object? result)
        {
            if (result == null)
            {
                if (operationKind == "read")
                {
                    metadata["cacheHit"] = false;
                }

                return;
            }

            var redisValue = result as RedisValue?;
            if (redisValue.HasValue)
            {
                AddRedisValueMetadata(metadata, operationKind, redisValue.Value);
                return;
            }

            var redisValues = result as RedisValue[];
            if (redisValues != null)
            {
                metadata["resultCount"] = redisValues.Length;
                if (operationKind == "read")
                {
                    var hits = 0;
                    foreach (var value in redisValues)
                    {
                        if (!value.IsNull)
                        {
                            hits++;
                        }
                    }

                    metadata["cacheHitCount"] = hits;
                }

                return;
            }

            var redisResult = result as RedisResult;
            if (redisResult != null)
            {
                if (operationKind == "read")
                {
                    metadata["cacheHit"] = !redisResult.IsNull;
                }

                if (redisResult.Length > 0)
                {
                    metadata["resultCount"] = redisResult.Length;
                }

                return;
            }

            if (command == "EXISTS" && result is bool exists)
            {
                metadata["cacheHit"] = exists;
                return;
            }

            if (result is ICollection collection && !(result is string) && !(result is byte[]))
            {
                metadata["resultCount"] = collection.Count;
            }
        }

        private static void AddRedisValueMetadata(IDictionary<string, object?> metadata, string operationKind, RedisValue value)
        {
            if (operationKind == "read")
            {
                metadata["cacheHit"] = !value.IsNull;
            }

            if (!value.IsNull && value.HasValue)
            {
                var size = value.GetLongByteCount();
                if (size >= 0)
                {
                    metadata["resultSizeBytes"] = size;
                }
            }
        }

        private static void AddOptionResultMetadata(IDictionary<string, object?> metadata, LogBrewStackExchangeRedisCommandOptions options)
        {
            if (options.CacheHit.HasValue)
            {
                metadata["cacheHit"] = options.CacheHit.Value;
            }

            if (options.ResultCount.HasValue)
            {
                metadata["resultCount"] = options.ResultCount.Value;
            }

            if (options.ResultSizeBytes.HasValue)
            {
                metadata["resultSizeBytes"] = options.ResultSizeBytes.Value;
            }
        }

        private static int? TryGetDatabaseIndex(object database)
        {
            try
            {
                if (database is IDatabase syncDatabase)
                {
                    return syncDatabase.Database;
                }
            }
            catch
            {
                return null;
            }

            return null;
        }

        private static string NormalizeCommandName(string commandName)
        {
            RequireNonEmpty("StackExchange.Redis command", commandName);
            var trimmed = commandName.Trim();
            var commandEnd = 0;
            while (commandEnd < trimmed.Length && !char.IsWhiteSpace(trimmed[commandEnd]))
            {
                commandEnd++;
            }

            var command = trimmed.Substring(0, commandEnd).Trim();
            if (command.Length == 0)
            {
                throw new SdkException("validation_error", "StackExchange.Redis command must start with a command name");
            }

            foreach (var character in command)
            {
                if (!(char.IsLetterOrDigit(character) || character == '.' || character == '_' || character == '-'))
                {
                    throw new SdkException("validation_error", "StackExchange.Redis command name contains unsupported characters");
                }
            }

            return command.ToUpperInvariant();
        }

        private static string OperationKind(string command)
        {
            switch (command)
            {
                case "GET":
                case "MGET":
                case "HGET":
                case "HMGET":
                case "HGETALL":
                case "EXISTS":
                case "TTL":
                case "PTTL":
                case "SCARD":
                case "ZCARD":
                case "LLEN":
                case "XLEN":
                case "GETBIT":
                case "GETRANGE":
                case "STRLEN":
                case "LRANGE":
                case "ZRANGE":
                case "SMEMBERS":
                    return "read";
                case "DEL":
                case "UNLINK":
                    return "delete";
                case "SET":
                case "SETEX":
                case "PSETEX":
                case "SETNX":
                case "MSET":
                case "MSETNX":
                case "HSET":
                case "HMSET":
                case "HDEL":
                case "INCR":
                case "INCRBY":
                case "DECR":
                case "DECRBY":
                case "EXPIRE":
                case "PEXPIRE":
                case "PUBLISH":
                    return "write";
                case "SUBSCRIBE":
                case "PSUBSCRIBE":
                case "UNSUBSCRIBE":
                case "PUNSUBSCRIBE":
                    return "subscription";
                default:
                    return "command";
            }
        }

        private static void AddString(IDictionary<string, object?> metadata, string key, string? value)
        {
            if (!string.IsNullOrWhiteSpace(value))
            {
                metadata[key] = value!.Trim();
            }
        }

        private static double ElapsedMilliseconds(long startedAt)
        {
            return (Stopwatch.GetTimestamp() - startedAt) * 1000.0 / Stopwatch.Frequency;
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
                // Preserve the app-owned Redis result even if diagnostics handling fails.
            }
        }

        private static Dictionary<string, object?> CopySafeDependencyMetadata(IDictionary<string, object?>? metadata)
        {
            var copied = new Dictionary<string, object?>(StringComparer.Ordinal);
            if (metadata == null)
            {
                return copied;
            }

            foreach (var item in metadata)
            {
                RequireNonEmpty("metadata key", item.Key);
                if (IsBlockedDependencyMetadataKey(item.Key))
                {
                    continue;
                }

                if (item.Value == null || item.Value is string || item.Value is bool || item.Value is int || item.Value is long || item.Value is float || item.Value is double || item.Value is decimal)
                {
                    copied[item.Key] = item.Value;
                    continue;
                }

                throw new SdkException("validation_error", "metadata value for " + item.Key + " must be a string, number, boolean, or null");
            }

            return copied;
        }

        private static bool IsBlockedDependencyMetadataKey(string key)
        {
            var normalized = key.Replace("_", string.Empty).Replace("-", string.Empty).Replace(".", string.Empty).ToLowerInvariant();
            foreach (var blocked in BlockedDependencyMetadataKeys())
            {
                if (normalized == blocked || normalized.Contains(blocked, StringComparison.Ordinal))
                {
                    return true;
                }
            }

            return false;
        }

        private static IEnumerable<string> BlockedDependencyMetadataKeys()
        {
            yield return "args";
            yield return "arguments";
            yield return "auth";
            yield return "authorization";
            yield return "body";
            yield return "cache" + "key";
            yield return "command";
            yield return "connectionstring";
            yield return "coo" + "kie";
            yield return "coo" + "kies";
            yield return "head" + "ers";
            yield return "ho" + "st";
            yield return "host" + "name";
            yield return "k" + "ey";
            yield return "message";
            yield return "messagebody";
            yield return "params";
            yield return "parameters";
            yield return "payload";
            yield return "query";
            yield return "rawcommand";
            yield return "pass" + "word";
            yield return "se" + "cret";
            yield return "to" + "ken";
            yield return "url";
            yield return "value";
        }

        private static void RequireNonEmpty(string label, string? value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                throw new SdkException("validation_error", label + " must be non-empty");
            }
        }
    }
}
