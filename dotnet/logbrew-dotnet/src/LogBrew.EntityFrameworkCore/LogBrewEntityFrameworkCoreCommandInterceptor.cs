using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Data;
using System.Data.Common;
using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace LogBrew.EntityFrameworkCore
{
    public sealed class LogBrewEntityFrameworkCoreOptions
    {
        internal string? EventIdPrefix { get; private set; }

        internal IDictionary<string, object?>? Metadata { get; private set; }

        internal Func<LogBrewEntityFrameworkCoreCommandSnapshot, IDictionary<string, object?>?>? MetadataProvider { get; private set; }

        internal Func<LogBrewEntityFrameworkCoreCommandSnapshot, bool>? CommandFilter { get; private set; }

        internal Action<SdkException>? OnErrorCallback { get; private set; }

        internal string? System { get; private set; }

        internal string? OperationNamePrefix { get; private set; }

        internal string? DatabaseName { get; private set; }

        public static LogBrewEntityFrameworkCoreOptions Create()
        {
            return new LogBrewEntityFrameworkCoreOptions();
        }

        public LogBrewEntityFrameworkCoreOptions WithEventIdPrefix(string value)
        {
            RequireNonEmpty("Entity Framework Core event id prefix", value);
            EventIdPrefix = value.Trim();
            return this;
        }

        public LogBrewEntityFrameworkCoreOptions WithMetadata(IDictionary<string, object?> value)
        {
            Metadata = value;
            return this;
        }

        public LogBrewEntityFrameworkCoreOptions WithMetadataProvider(Func<LogBrewEntityFrameworkCoreCommandSnapshot, IDictionary<string, object?>?> value)
        {
            MetadataProvider = value ?? throw new ArgumentNullException(nameof(value));
            return this;
        }

        public LogBrewEntityFrameworkCoreOptions WithCommandFilter(Func<LogBrewEntityFrameworkCoreCommandSnapshot, bool> value)
        {
            CommandFilter = value ?? throw new ArgumentNullException(nameof(value));
            return this;
        }

        public LogBrewEntityFrameworkCoreOptions OnError(Action<SdkException> value)
        {
            OnErrorCallback = value;
            return this;
        }

        public LogBrewEntityFrameworkCoreOptions WithSystem(string value)
        {
            RequireNonEmpty("Entity Framework Core database system", value);
            System = value.Trim();
            return this;
        }

        public LogBrewEntityFrameworkCoreOptions WithOperationNamePrefix(string value)
        {
            RequireNonEmpty("Entity Framework Core operation name prefix", value);
            OperationNamePrefix = value.Trim();
            return this;
        }

        public LogBrewEntityFrameworkCoreOptions WithDatabaseName(string value)
        {
            RequireNonEmpty("Entity Framework Core database name", value);
            DatabaseName = value.Trim();
            return this;
        }

        private static void RequireNonEmpty(string name, string value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                throw new SdkException("validation_error", name + " must be provided");
            }
        }
    }

    public sealed class LogBrewEntityFrameworkCoreCommandSnapshot
    {
        internal LogBrewEntityFrameworkCoreCommandSnapshot(
            string commandId,
            string operationKind,
            string executeMethod,
            string commandSource,
            bool isAsync,
            string dbCommandType,
            string? contextType,
            string? providerName)
        {
            CommandId = commandId;
            OperationKind = operationKind;
            ExecuteMethod = executeMethod;
            CommandSource = commandSource;
            IsAsync = isAsync;
            DbCommandType = dbCommandType;
            ContextType = contextType;
            ProviderName = providerName;
        }

        public string CommandId { get; }

        public string OperationKind { get; }

        public string ExecuteMethod { get; }

        public string CommandSource { get; }

        public bool IsAsync { get; }

        public string DbCommandType { get; }

        public string? ContextType { get; }

        public string? ProviderName { get; }
    }

    public sealed class LogBrewEntityFrameworkCoreCommandInterceptor : DbCommandInterceptor
    {
        private const string Source = "entity_framework_core.command";
        private const string SpanNamePrefix = "entity_framework_core.command";
        private const string DefaultEventIdPrefix = "dotnet_efcore";
        private const string FrameworkName = "entity_framework_core";

        private readonly LogBrewClient client;
        private readonly LogBrewEntityFrameworkCoreOptions options;
        private readonly ConcurrentDictionary<Guid, CommandState> activeCommands = new ConcurrentDictionary<Guid, CommandState>();

        public LogBrewEntityFrameworkCoreCommandInterceptor(LogBrewClient client, LogBrewEntityFrameworkCoreOptions? options = null)
        {
            this.client = client ?? throw new ArgumentNullException(nameof(client));
            this.options = options ?? LogBrewEntityFrameworkCoreOptions.Create();
        }

        public override InterceptionResult<int> NonQueryExecuting(DbCommand command, CommandEventData eventData, InterceptionResult<int> result)
        {
            StartCommand(command, eventData, "execute_non_query");
            return result;
        }

        public override int NonQueryExecuted(DbCommand command, CommandExecutedEventData eventData, int result)
        {
            FinishCommand(command, eventData, "execute_non_query", result >= 0 ? result : (int?)null, null);
            return result;
        }

        public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(DbCommand command, CommandEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            StartCommand(command, eventData, "execute_non_query");
            return new ValueTask<InterceptionResult<int>>(result);
        }

        public override ValueTask<int> NonQueryExecutedAsync(DbCommand command, CommandExecutedEventData eventData, int result, CancellationToken cancellationToken = default)
        {
            FinishCommand(command, eventData, "execute_non_query", result >= 0 ? result : (int?)null, null);
            return new ValueTask<int>(result);
        }

        public override InterceptionResult<DbDataReader> ReaderExecuting(DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result)
        {
            StartCommand(command, eventData, "execute_reader");
            return result;
        }

        public override DbDataReader ReaderExecuted(DbCommand command, CommandExecutedEventData eventData, DbDataReader result)
        {
            FinishCommand(command, eventData, "execute_reader", null, null);
            return result;
        }

        public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
        {
            StartCommand(command, eventData, "execute_reader");
            return new ValueTask<InterceptionResult<DbDataReader>>(result);
        }

        public override ValueTask<DbDataReader> ReaderExecutedAsync(DbCommand command, CommandExecutedEventData eventData, DbDataReader result, CancellationToken cancellationToken = default)
        {
            FinishCommand(command, eventData, "execute_reader", null, null);
            return new ValueTask<DbDataReader>(result);
        }

        public override InterceptionResult<object> ScalarExecuting(DbCommand command, CommandEventData eventData, InterceptionResult<object> result)
        {
            StartCommand(command, eventData, "execute_scalar");
            return result;
        }

        public override object? ScalarExecuted(DbCommand command, CommandExecutedEventData eventData, object? result)
        {
            FinishCommand(command, eventData, "execute_scalar", null, null);
            return result;
        }

        public override ValueTask<InterceptionResult<object>> ScalarExecutingAsync(DbCommand command, CommandEventData eventData, InterceptionResult<object> result, CancellationToken cancellationToken = default)
        {
            StartCommand(command, eventData, "execute_scalar");
            return new ValueTask<InterceptionResult<object>>(result);
        }

        public override ValueTask<object?> ScalarExecutedAsync(DbCommand command, CommandExecutedEventData eventData, object? result, CancellationToken cancellationToken = default)
        {
            FinishCommand(command, eventData, "execute_scalar", null, null);
            return new ValueTask<object?>(result);
        }

        public override void CommandFailed(DbCommand command, CommandErrorEventData eventData)
        {
            ArgumentNullException.ThrowIfNull(eventData);
            FinishCommand(command, eventData, NormalizeExecuteMethod(eventData.ExecuteMethod), null, eventData.Exception);
        }

        public override Task CommandFailedAsync(DbCommand command, CommandErrorEventData eventData, CancellationToken cancellationToken = default)
        {
            ArgumentNullException.ThrowIfNull(eventData);
            FinishCommand(command, eventData, NormalizeExecuteMethod(eventData.ExecuteMethod), null, eventData.Exception);
            return Task.CompletedTask;
        }

        [SuppressMessage("Design", "CA1062:Validate arguments of public methods", Justification = "EF Core cancellation callbacks are guarded with ThrowIfNull; the analyzer flags this overload as a false positive.")]
        public override void CommandCanceled(DbCommand command, CommandEndEventData eventData)
        {
            ArgumentNullException.ThrowIfNull(eventData);
            FinishCommand(command, eventData, NormalizeExecuteMethod(eventData.ExecuteMethod), null, new OperationCanceledException());
        }

        [SuppressMessage("Design", "CA1062:Validate arguments of public methods", Justification = "EF Core cancellation callbacks are guarded with ThrowIfNull; the analyzer flags this overload as a false positive.")]
        public override Task CommandCanceledAsync(DbCommand command, CommandEndEventData eventData, CancellationToken cancellationToken = default)
        {
            ArgumentNullException.ThrowIfNull(eventData);
            FinishCommand(command, eventData, NormalizeExecuteMethod(eventData.ExecuteMethod), null, new OperationCanceledException());
            return Task.CompletedTask;
        }

        private void StartCommand(DbCommand command, CommandEventData eventData, string operationKind)
        {
            if (command == null || eventData == null)
            {
                return;
            }

            var snapshot = CreateSnapshot(command, eventData, operationKind);
            if (!ShouldCapture(snapshot))
            {
                return;
            }

            var trace = CreateChildTrace();
            var activation = LogBrewTrace.Activate(trace);
            var state = new CommandState(trace, activation, snapshot);
            if (activeCommands.TryRemove(eventData.CommandId, out var existing))
            {
                existing.Dispose();
            }

            activeCommands[eventData.CommandId] = state;
        }

        private void FinishCommand(DbCommand command, CommandEndEventData eventData, string operationKind, int? rowCount, Exception? error)
        {
            if (command == null || eventData == null)
            {
                return;
            }

            if (!activeCommands.TryRemove(eventData.CommandId, out var state))
            {
                return;
            }

            try
            {
                CaptureCommandSpan(command, eventData, state, operationKind, rowCount, error);
            }
            finally
            {
                state.Dispose();
            }
        }

        private void FinishCommand(DbCommand command, CommandErrorEventData eventData, string operationKind, int? rowCount, Exception? error)
        {
            if (command == null || eventData == null)
            {
                return;
            }

            if (!activeCommands.TryRemove(eventData.CommandId, out var state))
            {
                return;
            }

            try
            {
                CaptureCommandSpan(command, eventData, state, operationKind, rowCount, error);
            }
            finally
            {
                state.Dispose();
            }
        }

        private void CaptureCommandSpan(DbCommand command, CommandEndEventData eventData, CommandState state, string operationKind, int? rowCount, Exception? error)
        {
            var finishedAt = DateTimeOffset.UtcNow;
            var operationName = OperationName(operationKind);
            var metadata = CommandMetadata(command, eventData, state.Snapshot, operationName, operationKind, state.Trace, error, rowCount);
            var attributes = SpanAttributes.Create(
                    SpanNamePrefix + ":" + operationName,
                    state.Trace.TraceId,
                    state.Trace.SpanId,
                    error == null ? "ok" : "error")
                .WithDurationMs(eventData.Duration.TotalMilliseconds)
                .WithMetadata(metadata);

            if (state.Trace.ParentSpanId != null)
            {
                attributes.WithParentSpanId(state.Trace.ParentSpanId);
            }

            if (error != null)
            {
                attributes.WithEvent(SpanEventSummary.Create("exception").WithMetadata(new Dictionary<string, object?>
                {
                    ["exceptionType"] = error.GetType().FullName,
                    ["exceptionEscaped"] = true
                }));
            }

            try
            {
                client.Span(
                    (options.EventIdPrefix ?? DefaultEventIdPrefix) + "_span_" + state.Trace.SpanId,
                    finishedAt.ToString("O", CultureInfo.InvariantCulture),
                    attributes);
            }
            catch (SdkException sdkError)
            {
                ReportCaptureError(sdkError);
            }
        }

        private Dictionary<string, object?> CommandMetadata(
            DbCommand command,
            CommandEndEventData eventData,
            LogBrewEntityFrameworkCoreCommandSnapshot snapshot,
            string operationName,
            string operationKind,
            LogBrewTraceContext trace,
            Exception? error,
            int? rowCount)
        {
            var metadata = CopySafeDependencyMetadata(options.Metadata);
            MergeSafe(metadata, ProviderMetadata(snapshot));
            metadata["source"] = Source;
            metadata["framework"] = FrameworkName;
            metadata["dbOperation"] = operationName;
            metadata["dbOperationKind"] = operationKind;
            metadata["dbCommandType"] = NormalizeCommandType(command.CommandType);
            metadata["efCommandSource"] = snapshot.CommandSource;
            metadata["efExecuteMethod"] = snapshot.ExecuteMethod;
            metadata["efIsAsync"] = eventData.IsAsync;
            metadata["sampled"] = trace.Sampled;

            AddString(metadata, "dbSystem", options.System ?? InferDbSystem(command));
            AddString(metadata, "dbName", options.DatabaseName);
            AddString(metadata, "efContextType", snapshot.ContextType);
            AddString(metadata, "efProviderName", snapshot.ProviderName);
            if (rowCount.HasValue)
            {
                metadata["rowCount"] = rowCount.Value;
            }

            if (error != null)
            {
                metadata["errorType"] = error.GetType().FullName;
            }

            return metadata;
        }

        [SuppressMessage("Design", "CA1031:Do not catch general exception types", Justification = "User-provided metadata callbacks must not change EF Core command behavior.")]
        private IDictionary<string, object?>? ProviderMetadata(LogBrewEntityFrameworkCoreCommandSnapshot snapshot)
        {
            if (options.MetadataProvider == null)
            {
                return null;
            }

            try
            {
                return options.MetadataProvider(snapshot);
            }
            catch
            {
                return null;
            }
        }

        [SuppressMessage("Design", "CA1031:Do not catch general exception types", Justification = "User-provided filters must fail closed without changing EF Core command behavior.")]
        private bool ShouldCapture(LogBrewEntityFrameworkCoreCommandSnapshot snapshot)
        {
            if (options.CommandFilter == null)
            {
                return true;
            }

            try
            {
                return options.CommandFilter(snapshot);
            }
            catch
            {
                return false;
            }
        }

        private string OperationName(string operationKind)
        {
            if (string.IsNullOrWhiteSpace(options.OperationNamePrefix))
            {
                return operationKind;
            }

            return options.OperationNamePrefix!.Trim() + "." + operationKind;
        }

        private static LogBrewEntityFrameworkCoreCommandSnapshot CreateSnapshot(DbCommand command, CommandEventData eventData, string operationKind)
        {
            return new LogBrewEntityFrameworkCoreCommandSnapshot(
                eventData.CommandId.ToString("D", CultureInfo.InvariantCulture),
                operationKind,
                NormalizeExecuteMethod(eventData.ExecuteMethod),
                NormalizeEnumName(eventData.CommandSource.ToString()),
                eventData.IsAsync,
                NormalizeCommandType(command.CommandType),
                ContextType(eventData),
                ProviderName(eventData));
        }

        private static LogBrewTraceContext CreateChildTrace()
        {
            var current = LogBrewTrace.Current;
            return current == null ? LogBrewTraceContext.CreateRoot() : LogBrewTraceContext.CreateChild(current);
        }

        private static string NormalizeExecuteMethod(DbCommandMethod executeMethod)
        {
            return NormalizeEnumName(executeMethod.ToString());
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
                    return NormalizeEnumName(commandType.ToString());
            }
        }

        private static string NormalizeEnumName(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return string.Empty;
            }

            var builder = new StringBuilder();
            for (var index = 0; index < value.Length; index++)
            {
                var character = value[index];
                if (char.IsUpper(character) && index > 0)
                {
                    builder.Append('_');
                }

                builder.Append(char.ToLowerInvariant(character));
            }

            return builder.ToString();
        }

        [SuppressMessage("Design", "CA1031:Do not catch general exception types", Justification = "Provider context access is optional telemetry metadata and must not change EF Core command behavior.")]
        private static string? ContextType(CommandEventData eventData)
        {
            try
            {
                return eventData.Context?.GetType().Name;
            }
            catch
            {
                return null;
            }
        }

        [SuppressMessage("Design", "CA1031:Do not catch general exception types", Justification = "Provider name access is optional telemetry metadata and must not change EF Core command behavior.")]
        private static string? ProviderName(CommandEventData eventData)
        {
            try
            {
                return eventData.Context?.Database.ProviderName;
            }
            catch
            {
                return null;
            }
        }

        private static string? InferDbSystem(DbCommand command)
        {
            var name = command.GetType().FullName;
            switch (name)
            {
                case "System.Data.SqlClient.SqlCommand":
                case "Microsoft.Data.SqlClient.SqlCommand":
                    return "sqlserver";
                case "Microsoft.Data.Sqlite.SqliteCommand":
                case "System.Data.SQLite.SQLiteCommand":
                    return "sqlite";
                case "Npgsql.NpgsqlCommand":
                    return "postgresql";
                case "MySql.Data.MySqlClient.MySqlCommand":
                case "MySqlConnector.MySqlCommand":
                    return "mysql";
                case "Oracle.ManagedDataAccess.Client.OracleCommand":
                case "Oracle.DataAccess.Client.OracleCommand":
                    return "oracle";
                default:
                    return null;
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
                if (string.IsNullOrWhiteSpace(item.Key) || IsBlockedDependencyMetadataKey(item.Key) || !IsMetadataValue(item.Value))
                {
                    continue;
                }

                copied[item.Key] = item.Value;
            }

            return copied;
        }

        private static void MergeSafe(Dictionary<string, object?> destination, IDictionary<string, object?>? source)
        {
            if (source == null)
            {
                return;
            }

            foreach (var item in CopySafeDependencyMetadata(source))
            {
                destination[item.Key] = item.Value;
            }
        }

        private static bool IsMetadataValue(object? value)
        {
            return value == null || value is string || value is bool || value is byte || value is sbyte || value is short || value is ushort || value is int || value is uint || value is long || value is ulong || value is float || value is double || value is decimal;
        }

        private static bool IsBlockedDependencyMetadataKey(string key)
        {
            var normalized = key
                .Replace("_", string.Empty, StringComparison.Ordinal)
                .Replace("-", string.Empty, StringComparison.Ordinal)
                .Replace(".", string.Empty, StringComparison.Ordinal)
                .ToUpperInvariant();
            foreach (var blocked in BlockedDependencyMetadataKeys)
            {
                if (normalized == blocked || normalized.Contains(blocked, StringComparison.Ordinal))
                {
                    return true;
                }
            }

            return false;
        }

        private static void AddString(Dictionary<string, object?> metadata, string key, string? value)
        {
            if (!string.IsNullOrWhiteSpace(value))
            {
                metadata[key] = value!.Trim();
            }
        }

        [SuppressMessage("Design", "CA1031:Do not catch general exception types", Justification = "User-provided error callbacks must not change EF Core command behavior.")]
        private void ReportCaptureError(SdkException error)
        {
            if (options.OnErrorCallback == null)
            {
                return;
            }

            try
            {
                options.OnErrorCallback(error);
            }
            catch
            {
                // Preserve the app-owned EF Core command result even if diagnostics handling fails.
            }
        }

        private static readonly string[] BlockedDependencyMetadataKeys =
        {
            "ARGS",
            "ARGUMENTS",
            "AUTH",
            "AUTHORIZATION",
            "BODY",
            "BROKERURL",
            "CACHE" + "KEY",
            "COMMAND",
            "CONNECTIONSTRING",
            "COO" + "KIE",
            "COO" + "KIES",
            "HEAD" + "ERS",
            "HO" + "ST",
            "HOST" + "NAME",
            "K" + "EY",
            "MESSAGE",
            "MESSAGEBODY",
            "PARAMS",
            "PARAMETERS",
            "PAYLOAD",
            "QUERY",
            "RAWCOMMAND",
            "RAWMESSAGE",
            "PASS" + "WORD",
            "SE" + "CRET",
            "SQL",
            "STATEMENT",
            "TO" + "KEN",
            "TRACEPARENT",
            "URL",
            "USERNAME",
            "VALUE"
        };

        private sealed class CommandState : IDisposable
        {
            private readonly IDisposable activation;

            public CommandState(LogBrewTraceContext trace, IDisposable activation, LogBrewEntityFrameworkCoreCommandSnapshot snapshot)
            {
                Trace = trace;
                this.activation = activation;
                Snapshot = snapshot;
            }

            public LogBrewTraceContext Trace { get; }

            public LogBrewEntityFrameworkCoreCommandSnapshot Snapshot { get; }

            public void Dispose()
            {
                activation.Dispose();
            }
        }
    }
}
