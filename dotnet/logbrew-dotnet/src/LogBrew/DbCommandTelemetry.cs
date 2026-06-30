using System;
using System.Collections.Generic;
using System.Data;
using System.Data.Common;
using System.Diagnostics;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;

namespace LogBrew
{
    public sealed class LogBrewDbCommandOptions
    {
        internal string? EventIdPrefix { get; private set; }

        internal IDictionary<string, object?>? Metadata { get; private set; }

        internal Action<SdkException>? OnErrorCallback { get; private set; }

        internal string? System { get; private set; }

        internal string? OperationName { get; private set; }

        internal string? OperationKind { get; private set; }

        internal string? DatabaseName { get; private set; }

        public static LogBrewDbCommandOptions Create()
        {
            return new LogBrewDbCommandOptions();
        }

        public LogBrewDbCommandOptions WithEventIdPrefix(string value)
        {
            Validation.RequireNonEmpty("DbCommand event id prefix", value);
            EventIdPrefix = value.Trim();
            return this;
        }

        public LogBrewDbCommandOptions WithMetadata(IDictionary<string, object?> value)
        {
            Metadata = value;
            return this;
        }

        public LogBrewDbCommandOptions OnError(Action<SdkException> value)
        {
            OnErrorCallback = value;
            return this;
        }

        public LogBrewDbCommandOptions WithSystem(string value)
        {
            Validation.RequireNonEmpty("DbCommand system", value);
            System = value.Trim();
            return this;
        }

        public LogBrewDbCommandOptions WithOperationName(string value)
        {
            Validation.RequireNonEmpty("DbCommand operation name", value);
            OperationName = value.Trim();
            return this;
        }

        public LogBrewDbCommandOptions WithOperationKind(string value)
        {
            Validation.RequireNonEmpty("DbCommand operation kind", value);
            OperationKind = value.Trim();
            return this;
        }

        public LogBrewDbCommandOptions WithDatabaseName(string value)
        {
            Validation.RequireNonEmpty("DbCommand database name", value);
            DatabaseName = value.Trim();
            return this;
        }
    }

    public static class LogBrewDbCommandTelemetry
    {
        private const string Source = "database.command";
        private const string SpanNamePrefix = "database.command";
        private const string DefaultEventIdPrefix = "dotnet_dbcommand";
        private const string FrameworkName = "ado.net";

        public static int ExecuteNonQuery(
            LogBrewClient client,
            DbCommand command,
            LogBrewDbCommandOptions? options = null)
        {
            return ExecuteCommand(
                client,
                command,
                options,
                "execute_non_query",
                () => command.ExecuteNonQuery(),
                static rowCount => rowCount >= 0 ? rowCount : (int?)null);
        }

        public static Task<int> ExecuteNonQueryAsync(
            LogBrewClient client,
            DbCommand command,
            LogBrewDbCommandOptions? options = null,
            CancellationToken cancel = default)
        {
            return ExecuteCommandAsync(
                client,
                command,
                options,
                "execute_non_query",
                ct => command.ExecuteNonQueryAsync(ct),
                static rowCount => rowCount >= 0 ? rowCount : (int?)null,
                cancel);
        }

        public static object? ExecuteScalar(
            LogBrewClient client,
            DbCommand command,
            LogBrewDbCommandOptions? options = null)
        {
            return ExecuteCommand<object?>(
                client,
                command,
                options,
                "execute_scalar",
                command.ExecuteScalar,
                null);
        }

        public static Task<object?> ExecuteScalarAsync(
            LogBrewClient client,
            DbCommand command,
            LogBrewDbCommandOptions? options = null,
            CancellationToken cancel = default)
        {
            return ExecuteCommandAsync<object?>(
                client,
                command,
                options,
                "execute_scalar",
                ct => command.ExecuteScalarAsync(ct),
                null,
                cancel);
        }

        public static DbDataReader ExecuteReader(
            LogBrewClient client,
            DbCommand command,
            LogBrewDbCommandOptions? options = null)
        {
            return ExecuteCommand<DbDataReader>(
                client,
                command,
                options,
                "execute_reader",
                command.ExecuteReader,
                null);
        }

        public static Task<DbDataReader> ExecuteReaderAsync(
            LogBrewClient client,
            DbCommand command,
            LogBrewDbCommandOptions? options = null,
            CancellationToken cancel = default)
        {
            return ExecuteCommandAsync<DbDataReader>(
                client,
                command,
                options,
                "execute_reader",
                ct => command.ExecuteReaderAsync(ct),
                null,
                cancel);
        }

        private static T ExecuteCommand<T>(
            LogBrewClient client,
            DbCommand command,
            LogBrewDbCommandOptions? options,
            string defaultOperationKind,
            Func<T> execute,
            Func<T, int?>? rowCountSelector)
        {
            ValidateInputs(client, command, execute);
            var safeOptions = options ?? LogBrewDbCommandOptions.Create();
            var operationKind = NormalizeOperationKind(safeOptions, defaultOperationKind);
            var operationName = NormalizeOperationName(safeOptions, operationKind);
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
                        command,
                        safeOptions,
                        operationName,
                        operationKind,
                        trace,
                        startedAt,
                        commandError,
                        hasResult && rowCountSelector != null ? rowCountSelector(result) : null);
                }
            }
        }

        private static async Task<T> ExecuteCommandAsync<T>(
            LogBrewClient client,
            DbCommand command,
            LogBrewDbCommandOptions? options,
            string defaultOperationKind,
            Func<CancellationToken, Task<T>> execute,
            Func<T, int?>? rowCountSelector,
            CancellationToken cancel)
        {
            ValidateInputs(client, command, execute);
            var safeOptions = options ?? LogBrewDbCommandOptions.Create();
            var operationKind = NormalizeOperationKind(safeOptions, defaultOperationKind);
            var operationName = NormalizeOperationName(safeOptions, operationKind);
            var trace = CreateChildTrace();
            var startedAt = Stopwatch.GetTimestamp();
            Exception? commandError = null;
            var result = default(T)!;
            var hasResult = false;

            using (LogBrewTrace.Activate(trace))
            {
                try
                {
                    result = await execute(cancel).ConfigureAwait(false);
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
                        command,
                        safeOptions,
                        operationName,
                        operationKind,
                        trace,
                        startedAt,
                        commandError,
                        hasResult && rowCountSelector != null ? rowCountSelector(result) : null);
                }
            }
        }

        private static void ValidateInputs<T>(LogBrewClient client, DbCommand command, T execute)
        {
            if (client == null)
            {
                throw new ArgumentNullException(nameof(client));
            }

            if (command == null)
            {
                throw new ArgumentNullException(nameof(command));
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

        private static string NormalizeOperationKind(LogBrewDbCommandOptions options, string defaultOperationKind)
        {
            return string.IsNullOrWhiteSpace(options.OperationKind) ? defaultOperationKind : options.OperationKind!.Trim();
        }

        private static string NormalizeOperationName(LogBrewDbCommandOptions options, string operationKind)
        {
            return string.IsNullOrWhiteSpace(options.OperationName) ? operationKind : options.OperationName!.Trim();
        }

        private static void CaptureCommandSpan(
            LogBrewClient client,
            DbCommand command,
            LogBrewDbCommandOptions options,
            string operationName,
            string operationKind,
            LogBrewTraceContext trace,
            long startedAt,
            Exception? commandError,
            int? rowCount)
        {
            var finishedAt = DateTimeOffset.UtcNow;
            var metadata = CommandMetadata(command, options, operationName, operationKind, trace, commandError, rowCount);
            var attributes = SpanAttributes.Create(
                    SpanNamePrefix + ":" + operationName,
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
            DbCommand command,
            LogBrewDbCommandOptions options,
            string operationName,
            string operationKind,
            LogBrewTraceContext trace,
            Exception? commandError,
            int? rowCount)
        {
            var metadata = TelemetryMetadata.CopySafeDependencyMetadata(options.Metadata);
            metadata["source"] = Source;
            metadata["framework"] = FrameworkName;
            metadata["dbOperation"] = operationName;
            metadata["dbOperationKind"] = operationKind;
            metadata["dbCommandType"] = NormalizeCommandType(command.CommandType);
            metadata["sampled"] = trace.Sampled;

            AddString(metadata, "dbSystem", options.System);
            AddString(metadata, "dbName", options.DatabaseName);
            if (rowCount.HasValue)
            {
                metadata["rowCount"] = rowCount.Value;
            }

            if (commandError != null)
            {
                metadata["errorType"] = commandError.GetType().FullName;
            }

            return metadata;
        }

        private static string NormalizeCommandType(CommandType commandType)
        {
            switch (commandType)
            {
                case CommandType.Text:
                    return "text";
                case CommandType.StoredProcedure:
                    return "stored_procedure";
                case CommandType.TableDirect:
                    return "table_direct";
                default:
                    return commandType.ToString().ToLowerInvariant();
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
                // Preserve the app-owned command result even if diagnostics handling fails.
            }
        }
    }
}
