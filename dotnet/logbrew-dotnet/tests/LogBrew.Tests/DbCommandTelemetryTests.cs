using System;
using System.Collections;
using System.Collections.Generic;
using System.Data;
using System.Data.Common;
using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using LogBrew;

internal static class DbCommandTelemetryTests
{
    private const string IncomingTraceparent = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01";

    internal static int Run()
    {
        var tests = 0;
        ExecuteNonQueryCreatesPrivacyBoundedSpan();
        tests++;
        ExecuteScalarAndReaderPreserveResults();
        tests++;
        ExecuteNonQueryAsyncKeepsTraceActive().GetAwaiter().GetResult();
        tests++;
        CommandFailurePreservesOriginalExceptionAndCapturesTypeOnlyEvent();
        tests++;
        CaptureFailureDoesNotReplaceCommandResult();
        tests++;
        return tests;
    }

    private static void ExecuteNonQueryCreatesPrivacyBoundedSpan()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "db-command-tests", "0.1.0");
        var root = LogBrewTraceContext.FromTraceparent(IncomingTraceparent, "b7ad6b7169203331");
        using var command = new TestDbCommand
        {
            CommandText = "UPDATE orders SET card_number = 'sample' WHERE id = @id",
            CommandType = CommandType.Text,
            NonQueryResult = 3
        };

        int result;
        using (LogBrewTrace.Activate(root))
        {
            result = LogBrewDbCommandTelemetry.ExecuteNonQuery(
                client,
                command,
                LogBrewDbCommandOptions.Create()
                    .WithEventIdPrefix("dotnet_dbcommand")
                    .WithSystem("sqlserver")
                    .WithOperationName("orders.update")
                    .WithDatabaseName("checkout")
                    .WithMetadata(new Dictionary<string, object?>
                    {
                        ["safe"] = true,
                        ["sql"] = "UPDATE orders SET card_number = 'sample'",
                        ["db.parameters"] = "@id=sample",
                        ["connection_string"] = "Data Source=private;User=sample"
                    }));
        }

        Require(result == 3, "expected non-query row count");
        Require(command.TraceDuringNonQuery != null, "expected active command trace");
        Require(command.TraceDuringNonQuery!.TraceId == root.TraceId, "expected command child trace id");
        Require(command.TraceDuringNonQuery.ParentSpanId == root.SpanId, "expected command parent span");

        var payload = client.PreviewJson();
        foreach (var expected in new[]
        {
            "\"id\": \"dotnet_dbcommand_span_",
            "\"name\": \"database.command:orders.update\"",
            "\"source\": \"database.command\"",
            "\"framework\": \"ado.net\"",
            "\"dbSystem\": \"sqlserver\"",
            "\"dbOperation\": \"orders.update\"",
            "\"dbOperationKind\": \"execute_non_query\"",
            "\"dbCommandType\": \"text\"",
            "\"dbName\": \"checkout\"",
            "\"rowCount\": 3",
            "\"safe\": true",
            "\"traceId\": \"4bf92f3577b34da6a3ce929d0e0e4736\"",
            "\"parentSpanId\": \"b7ad6b7169203331\"",
            "\"sampled\": true"
        })
        {
            Require(payload.Contains(expected, StringComparison.Ordinal), "missing DbCommand payload: " + expected);
        }

        foreach (var blocked in new[]
        {
            "UPDATE orders",
            "@id=sample",
            "Data Source=private",
            "card_number = 'sample'"
        })
        {
            Require(!payload.Contains(blocked, StringComparison.Ordinal), "expected command detail to be omitted: " + blocked);
        }
    }

    private static void ExecuteScalarAndReaderPreserveResults()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "db-command-tests", "0.1.0");
        using var scalarCommand = new TestDbCommand
        {
            CommandText = "SELECT COUNT(*) FROM orders",
            ScalarResult = 42
        };
        using var readerTable = new DataTable();
        using var readerCommand = new TestDbCommand
        {
            CommandText = "SELECT id FROM orders",
            ReaderResult = readerTable.CreateDataReader()
        };

        var scalar = LogBrewDbCommandTelemetry.ExecuteScalar(
            client,
            scalarCommand,
            LogBrewDbCommandOptions.Create()
                .WithEventIdPrefix("dotnet_dbcommand")
                .WithOperationName("orders.count"));
        using var reader = LogBrewDbCommandTelemetry.ExecuteReader(
            client,
            readerCommand,
            LogBrewDbCommandOptions.Create()
                .WithEventIdPrefix("dotnet_dbcommand")
                .WithOperationName("orders.reader"));

        Require((int)scalar! == 42, "expected scalar command result");
        Require(object.ReferenceEquals(reader, readerCommand.ReaderResult), "expected reader command result");
        var payload = client.PreviewJson();
        Require(payload.Contains("\"name\": \"database.command:orders.count\"", StringComparison.Ordinal), "expected scalar span");
        Require(payload.Contains("\"dbOperationKind\": \"execute_scalar\"", StringComparison.Ordinal), "expected scalar operation kind");
        Require(payload.Contains("\"name\": \"database.command:orders.reader\"", StringComparison.Ordinal), "expected reader span");
        Require(payload.Contains("\"dbOperationKind\": \"execute_reader\"", StringComparison.Ordinal), "expected reader operation kind");
        Require(!payload.Contains("SELECT COUNT", StringComparison.Ordinal), "expected scalar SQL to be omitted");
        Require(!payload.Contains("SELECT id", StringComparison.Ordinal), "expected reader SQL to be omitted");
    }

    private static async Task ExecuteNonQueryAsyncKeepsTraceActive()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "db-command-tests", "0.1.0");
        var root = LogBrewTraceContext.FromTraceparent(IncomingTraceparent, "b7ad6b7169203332");
        using var command = new TestDbCommand
        {
            CommandText = "DELETE FROM sessions WHERE session_id = @session_id",
            AsyncNonQueryResult = 5
        };
        using var scalarCommand = new TestDbCommand
        {
            CommandText = "SELECT COUNT(*) FROM sessions",
            AsyncScalarResult = 7
        };
        using var readerTable = new DataTable();
        using var readerCommand = new TestDbCommand
        {
            CommandText = "SELECT id FROM sessions",
            AsyncReaderResult = readerTable.CreateDataReader()
        };

        using (LogBrewTrace.Activate(root))
        {
            var result = await LogBrewDbCommandTelemetry.ExecuteNonQueryAsync(
                client,
                command,
                LogBrewDbCommandOptions.Create()
                    .WithSystem("postgresql")
                    .WithOperationName("sessions.expire"),
                CancellationToken.None).ConfigureAwait(false);
            Require(result == 5, "expected async row count");

            var scalar = await LogBrewDbCommandTelemetry.ExecuteScalarAsync(
                client,
                scalarCommand,
                LogBrewDbCommandOptions.Create().WithOperationName("sessions.count"),
                CancellationToken.None).ConfigureAwait(false);
            Require((int)scalar! == 7, "expected async scalar result");

            using var reader = await LogBrewDbCommandTelemetry.ExecuteReaderAsync(
                client,
                readerCommand,
                LogBrewDbCommandOptions.Create().WithOperationName("sessions.reader"),
                CancellationToken.None).ConfigureAwait(false);
            Require(object.ReferenceEquals(reader, readerCommand.AsyncReaderResult), "expected async reader result");
        }

        Require(command.TraceDuringAsyncNonQuery != null, "expected async active command trace");
        Require(command.TraceDuringAsyncNonQuery!.TraceId == root.TraceId, "expected async command trace id");
        Require(command.TraceDuringAsyncNonQuery.ParentSpanId == root.SpanId, "expected async parent span");
        var payload = client.PreviewJson();
        Require(payload.Contains("\"name\": \"database.command:sessions.expire\"", StringComparison.Ordinal), "expected async command span");
        Require(payload.Contains("\"dbSystem\": \"postgresql\"", StringComparison.Ordinal), "expected async DB system");
        Require(payload.Contains("\"rowCount\": 5", StringComparison.Ordinal), "expected async row count");
        Require(payload.Contains("\"name\": \"database.command:sessions.count\"", StringComparison.Ordinal), "expected async scalar span");
        Require(payload.Contains("\"dbOperationKind\": \"execute_scalar\"", StringComparison.Ordinal), "expected async scalar kind");
        Require(payload.Contains("\"name\": \"database.command:sessions.reader\"", StringComparison.Ordinal), "expected async reader span");
        Require(payload.Contains("\"dbOperationKind\": \"execute_reader\"", StringComparison.Ordinal), "expected async reader kind");
        Require(!payload.Contains("DELETE FROM", StringComparison.Ordinal), "expected async SQL to be omitted");
        Require(!payload.Contains("SELECT COUNT", StringComparison.Ordinal), "expected async scalar SQL to be omitted");
        Require(!payload.Contains("SELECT id", StringComparison.Ordinal), "expected async reader SQL to be omitted");
    }

    private static void CommandFailurePreservesOriginalExceptionAndCapturesTypeOnlyEvent()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "db-command-tests", "0.1.0");
        var original = new InvalidOperationException("provider error includes sample command details");
        using var command = new TestDbCommand
        {
            CommandText = "INSERT INTO payments(card_number) VALUES ('sample')",
            ExecuteNonQueryError = original
        };

        try
        {
            LogBrewDbCommandTelemetry.ExecuteNonQuery(
                client,
                command,
                LogBrewDbCommandOptions.Create().WithOperationName("payments.insert"));
        }
        catch (InvalidOperationException error)
        {
            Require(object.ReferenceEquals(error, original), "expected original command exception");
        }

        var payload = client.PreviewJson();
        Require(payload.Contains("\"status\": \"error\"", StringComparison.Ordinal), "expected error command span");
        Require(payload.Contains("\"errorType\": \"System.InvalidOperationException\"", StringComparison.Ordinal), "expected error type only");
        Require(payload.Contains("\"name\": \"exception\"", StringComparison.Ordinal), "expected exception event");
        Require(payload.Contains("\"exceptionEscaped\": true", StringComparison.Ordinal), "expected escaped exception event");
        Require(!payload.Contains("provider error includes", StringComparison.Ordinal), "expected exception message to be omitted");
        Require(!payload.Contains("INSERT INTO payments", StringComparison.Ordinal), "expected failing SQL to be omitted");
    }

    private static void CaptureFailureDoesNotReplaceCommandResult()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "db-command-tests", "0.1.0");
        client.Shutdown(RecordingTransport.AlwaysAccept());
        var callbackErrors = 0;
        using var command = new TestDbCommand
        {
            CommandText = "UPDATE orders SET status = @status",
            NonQueryResult = 2
        };

        var result = LogBrewDbCommandTelemetry.ExecuteNonQuery(
            client,
            command,
            LogBrewDbCommandOptions.Create()
                .OnError(error =>
                {
                    Require(error.Code == "shutdown_error", "expected shutdown capture error");
                    callbackErrors++;
                    throw new InvalidOperationException("diagnostics callback failed");
                }));

        Require(result == 2, "expected capture failure to preserve command result");
        Require(callbackErrors == 1, "expected capture error callback");
    }

    private static void Require(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }

    private sealed class TestDbCommand : DbCommand
    {
        private readonly TestDbParameterCollection parameters = new TestDbParameterCollection();

        [AllowNull]
        public override string CommandText { get; set; } = string.Empty;

        public override int CommandTimeout { get; set; }

        public override CommandType CommandType { get; set; } = CommandType.Text;

        public override UpdateRowSource UpdatedRowSource { get; set; }

        public override bool DesignTimeVisible { get; set; }

        internal int NonQueryResult { get; set; }

        internal int AsyncNonQueryResult { get; set; }

        internal object? ScalarResult { get; set; }

        internal object? AsyncScalarResult { get; set; }

        internal DbDataReader? ReaderResult { get; set; }

        internal DbDataReader? AsyncReaderResult { get; set; }

        internal Exception? ExecuteNonQueryError { get; set; }

        internal LogBrewTraceContext? TraceDuringNonQuery { get; private set; }

        internal LogBrewTraceContext? TraceDuringAsyncNonQuery { get; private set; }

        protected override DbConnection? DbConnection { get; set; }

        protected override DbParameterCollection DbParameterCollection
        {
            get { return parameters; }
        }

        protected override DbTransaction? DbTransaction { get; set; }

        public override void Cancel()
        {
        }

        public override int ExecuteNonQuery()
        {
            TraceDuringNonQuery = LogBrewTrace.Current;
            if (ExecuteNonQueryError != null)
            {
                throw ExecuteNonQueryError;
            }

            return NonQueryResult;
        }

        public override object? ExecuteScalar()
        {
            return ScalarResult;
        }

        public override void Prepare()
        {
        }

        public override Task<int> ExecuteNonQueryAsync(CancellationToken cancel)
        {
            TraceDuringAsyncNonQuery = LogBrewTrace.Current;
            return Task.FromResult(AsyncNonQueryResult);
        }

        public override Task<object?> ExecuteScalarAsync(CancellationToken cancel)
        {
            return Task.FromResult(AsyncScalarResult);
        }

        protected override DbParameter CreateDbParameter()
        {
            throw new NotSupportedException();
        }

        protected override DbDataReader ExecuteDbDataReader(CommandBehavior behavior)
        {
            return ReaderResult ?? throw new InvalidOperationException("Reader result was not configured");
        }

        protected override Task<DbDataReader> ExecuteDbDataReaderAsync(CommandBehavior behavior, CancellationToken cancel)
        {
            return Task.FromResult(AsyncReaderResult ?? throw new InvalidOperationException("Async reader result was not configured"));
        }
    }

    private sealed class TestDbParameterCollection : DbParameterCollection
    {
        private readonly object syncRoot = new object();

        public override int Count
        {
            get { return 0; }
        }

        public override object SyncRoot
        {
            get { return syncRoot; }
        }

        public override int Add(object value)
        {
            throw new NotSupportedException();
        }

        public override void AddRange(Array values)
        {
            throw new NotSupportedException();
        }

        public override void Clear()
        {
        }

        public override bool Contains(object value)
        {
            return false;
        }

        public override bool Contains(string value)
        {
            return false;
        }

        public override void CopyTo(Array array, int index)
        {
        }

        public override IEnumerator GetEnumerator()
        {
            return Array.Empty<object>().GetEnumerator();
        }

        public override int IndexOf(object value)
        {
            return -1;
        }

        public override int IndexOf(string parameterName)
        {
            return -1;
        }

        public override void Insert(int index, object value)
        {
            throw new NotSupportedException();
        }

        public override void Remove(object value)
        {
        }

        public override void RemoveAt(int index)
        {
        }

        public override void RemoveAt(string parameterName)
        {
        }

        protected override DbParameter GetParameter(int index)
        {
            throw new InvalidOperationException("Parameter was not found at index " + index.ToString(CultureInfo.InvariantCulture));
        }

        protected override DbParameter GetParameter(string parameterName)
        {
            throw new InvalidOperationException("Parameter was not found: " + parameterName);
        }

        protected override void SetParameter(int index, DbParameter value)
        {
            throw new NotSupportedException();
        }

        protected override void SetParameter(string parameterName, DbParameter value)
        {
            throw new NotSupportedException();
        }
    }

}
