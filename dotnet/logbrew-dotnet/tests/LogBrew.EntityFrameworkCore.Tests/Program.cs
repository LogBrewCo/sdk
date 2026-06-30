using System;
using System.Collections.Generic;
using System.Data;
using System.Data.Common;
using System.Globalization;
using LogBrew;
using LogBrew.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;

const string IncomingTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

var tests = 0;
EntityFrameworkCoreInterceptorCapturesPrivacyBoundedCommandSpans();
tests++;
EntityFrameworkCoreInterceptorCapturesFailureAsTypeOnlySpan();
tests++;
EntityFrameworkCoreInterceptorCapturesCancellationAndReturnsToRootTrace();
tests++;
EntityFrameworkCoreInterceptorFilterSkipsTelemetry();
tests++;
Console.WriteLine("dotnet efcore package tests ok (" + tests.ToString(CultureInfo.InvariantCulture) + " tests)");

static void EntityFrameworkCoreInterceptorCapturesPrivacyBoundedCommandSpans()
{
    var client = LogBrewClient.Create("LOGBREW_API_KEY", "efcore-tests", "0.1.0");
    var root = LogBrewTraceContext.FromTraceparent(IncomingTraceparent, "b7ad6b7169203331");
    LogBrewTraceContext? metadataTrace = null;
    var metadataCalls = 0;
    var interceptor = new LogBrewEntityFrameworkCoreCommandInterceptor(
        client,
        LogBrewEntityFrameworkCoreOptions.Create()
            .WithEventIdPrefix("dotnet_efcore")
            .WithSystem("sqlite")
            .WithDatabaseName("checkout")
            .WithOperationNamePrefix("orders")
            .WithMetadata(new Dictionary<string, object?>
            {
                ["feature"] = "checkout",
                ["sql"] = "SELECT card_number FROM payments",
                ["connection" + "_string"] = "Data Source=redacted;Pass" + "word=sample"
            })
            .WithMetadataProvider(snapshot =>
            {
                metadataCalls++;
                metadataTrace = LogBrewTrace.Current;
                return new Dictionary<string, object?>
                {
                    ["commandId"] = snapshot.CommandId,
                    ["executeMethod"] = snapshot.ExecuteMethod,
                    ["trace" + "parent"] = IncomingTraceparent,
                    ["parameters"] = "@card=sample"
                };
            }));
    using var connection = new TestDbConnection();
    using var nonQueryCommand = new TestDbCommand(connection)
    {
        CommandText = "INSERT INTO orders(card_number) VALUES ('sample')",
        CommandType = CommandType.Text
    };
    using var readerCommand = new TestDbCommand(connection)
    {
        CommandText = "SELECT card_number FROM orders",
        CommandType = CommandType.Text
    };
    var nonQueryCommandId = Guid.NewGuid();
    var readerCommandId = Guid.NewGuid();

    using (LogBrewTrace.Activate(root))
    {
        interceptor.NonQueryExecuting(
            nonQueryCommand,
            CreateCommandEventData(nonQueryCommand, nonQueryCommandId, CommandSource.SaveChanges, DbCommandMethod.ExecuteNonQuery, async: false),
            default);
        Require(
            interceptor.NonQueryExecuted(
                nonQueryCommand,
                CreateCommandExecutedEventData(nonQueryCommand, nonQueryCommandId, CommandSource.SaveChanges, DbCommandMethod.ExecuteNonQuery, result: 1, async: false),
                1) == 1,
            "expected non-query result");

        interceptor.ReaderExecuting(
            readerCommand,
            CreateCommandEventData(readerCommand, readerCommandId, CommandSource.LinqQuery, DbCommandMethod.ExecuteReader, async: false),
            default);
        using var readerTable = new DataTable();
        using var reader = readerTable.CreateDataReader();
        Require(
            ReferenceEquals(
                interceptor.ReaderExecuted(
                    readerCommand,
                    CreateCommandExecutedEventData(readerCommand, readerCommandId, CommandSource.LinqQuery, DbCommandMethod.ExecuteReader, reader, async: false),
                    reader),
                reader),
            "expected reader result");

        Require(LogBrewTrace.Current == root, "expected EF Core command scope to return to root trace");
    }

    Require(metadataCalls >= 2, "expected metadata provider to be called");
    Require(metadataTrace != null, "expected metadata provider to see active command trace");
    Require(metadataTrace!.TraceId == root.TraceId, "expected metadata trace id to match root");
    Require(metadataTrace.ParentSpanId == root.SpanId, "expected metadata parent span to match root");

    var payload = client.PreviewJson();
    foreach (var expected in new[]
    {
        "\"id\": \"dotnet_efcore_span_",
        "\"source\": \"entity_framework_core.command\"",
        "\"framework\": \"entity_framework_core\"",
        "\"dbSystem\": \"sqlite\"",
        "\"dbName\": \"checkout\"",
        "\"dbOperation\": \"orders.execute_non_query\"",
        "\"dbOperation\": \"orders.execute_reader\"",
        "\"dbOperationKind\": \"execute_non_query\"",
        "\"dbOperationKind\": \"execute_reader\"",
        "\"dbCommandType\": \"text\"",
        "\"efCommandSource\": \"save_changes\"",
        "\"efCommandSource\": \"linq_query\"",
        "\"efExecuteMethod\": \"execute_non_query\"",
        "\"efExecuteMethod\": \"execute_reader\"",
        "\"efIsAsync\": false",
        "\"feature\": \"checkout\"",
        "\"traceId\": \"4bf92f3577b34da6a3ce929d0e0e4736\"",
        "\"parentSpanId\": \"b7ad6b7169203331\"",
        "\"sampled\": true"
    })
    {
        Require(payload.Contains(expected, StringComparison.Ordinal), "missing EF Core payload: " + expected);
    }

    foreach (var blocked in new[]
    {
        "SELECT card_number",
        "Data Source=private",
        "INSERT INTO",
        "SELECT \"o\"",
        "@card=sample",
        IncomingTraceparent,
        "\"connection" + "_string\"",
        "\"parameters\"",
        "\"sql\""
    })
    {
        Require(!payload.Contains(blocked, StringComparison.Ordinal), "expected EF Core payload to omit unsafe value: " + blocked);
    }
}

static void EntityFrameworkCoreInterceptorCapturesFailureAsTypeOnlySpan()
{
    var client = LogBrewClient.Create("LOGBREW_API_KEY", "efcore-error-tests", "0.1.0");
    var interceptor = new LogBrewEntityFrameworkCoreCommandInterceptor(
        client,
        LogBrewEntityFrameworkCoreOptions.Create()
            .WithEventIdPrefix("dotnet_efcore_error")
            .WithOperationNamePrefix("orders"));
    using var connection = new TestDbConnection();
    using var command = new TestDbCommand(connection)
    {
        CommandText = "INSERT INTO orders(external_id) VALUES ('duplicate')",
        CommandType = CommandType.Text
    };
    var commandId = Guid.NewGuid();
    var providerError = new InvalidOperationException("UNIQUE constraint failed: orders.external_id duplicate");

    interceptor.NonQueryExecuting(
        command,
        CreateCommandEventData(command, commandId, CommandSource.SaveChanges, DbCommandMethod.ExecuteNonQuery, async: false),
        default);
    interceptor.CommandFailed(
        command,
        CreateCommandErrorEventData(command, commandId, CommandSource.SaveChanges, DbCommandMethod.ExecuteNonQuery, providerError, async: false));

    var payload = client.PreviewJson();
    Require(payload.Contains("\"id\": \"dotnet_efcore_error_span_", StringComparison.Ordinal), "expected EF Core error span");
    Require(payload.Contains("\"status\": \"error\"", StringComparison.Ordinal), "expected EF Core error status");
    Require(payload.Contains("\"errorType\": \"System.InvalidOperationException\"", StringComparison.Ordinal), "expected provider error type");
    Require(payload.Contains("\"name\": \"exception\"", StringComparison.Ordinal), "expected exception span event");
    Require(payload.Contains("\"exceptionEscaped\": true", StringComparison.Ordinal), "expected exception escaped flag");
    foreach (var blocked in new[] { "UNIQUE constraint failed", "duplicate", "INSERT INTO" })
    {
        Require(!payload.Contains(blocked, StringComparison.Ordinal), "expected EF Core error payload to omit unsafe value: " + blocked);
    }
}

static void EntityFrameworkCoreInterceptorCapturesCancellationAndReturnsToRootTrace()
{
    var client = LogBrewClient.Create("LOGBREW_API_KEY", "efcore-canceled-tests", "0.1.0");
    var root = LogBrewTraceContext.FromTraceparent(IncomingTraceparent, "b7ad6b7169203331");
    var interceptor = new LogBrewEntityFrameworkCoreCommandInterceptor(
        client,
        LogBrewEntityFrameworkCoreOptions.Create()
            .WithEventIdPrefix("dotnet_efcore_canceled")
            .WithOperationNamePrefix("orders"));
    using var connection = new TestDbConnection();
    using var command = new TestDbCommand(connection)
    {
        CommandText = "SELECT card_number FROM orders",
        CommandType = CommandType.Text
    };
    var commandId = Guid.NewGuid();

    using (LogBrewTrace.Activate(root))
    {
        interceptor.ReaderExecuting(
            command,
            CreateCommandEventData(command, commandId, CommandSource.LinqQuery, DbCommandMethod.ExecuteReader, async: true),
            default);
        interceptor.CommandCanceled(
            command,
            CreateCommandEndEventData(command, commandId, CommandSource.LinqQuery, DbCommandMethod.ExecuteReader, async: true));
        Require(LogBrewTrace.Current == root, "expected EF Core canceled command scope to return to root trace");
    }

    var payload = client.PreviewJson();
    Require(payload.Contains("\"id\": \"dotnet_efcore_canceled_span_", StringComparison.Ordinal), "expected EF Core canceled span");
    Require(payload.Contains("\"status\": \"error\"", StringComparison.Ordinal), "expected canceled EF Core status");
    Require(payload.Contains("\"errorType\": \"System.OperationCanceledException\"", StringComparison.Ordinal), "expected cancellation error type");
    Require(payload.Contains("\"dbOperation\": \"orders.execute_reader\"", StringComparison.Ordinal), "expected canceled operation name");
    foreach (var blocked in new[] { "SELECT card_number", "orders.card_number" })
    {
        Require(!payload.Contains(blocked, StringComparison.Ordinal), "expected EF Core canceled payload to omit unsafe value: " + blocked);
    }
}

static void EntityFrameworkCoreInterceptorFilterSkipsTelemetry()
{
    var client = LogBrewClient.Create("LOGBREW_API_KEY", "efcore-filter-tests", "0.1.0");
    var interceptor = new LogBrewEntityFrameworkCoreCommandInterceptor(
        client,
        LogBrewEntityFrameworkCoreOptions.Create().WithCommandFilter(_ => false));
    using var connection = new TestDbConnection();
    using var command = new TestDbCommand(connection) { CommandText = "SELECT card_number FROM orders" };
    var commandId = Guid.NewGuid();

    interceptor.ReaderExecuting(
        command,
        CreateCommandEventData(command, commandId, CommandSource.LinqQuery, DbCommandMethod.ExecuteReader, async: false),
        default);
    using var readerTable = new DataTable();
    using var reader = readerTable.CreateDataReader();
    interceptor.ReaderExecuted(
        command,
        CreateCommandExecutedEventData(command, commandId, CommandSource.LinqQuery, DbCommandMethod.ExecuteReader, reader, async: false),
        reader);

    Require(client.PendingEvents() == 0, "filtered EF Core commands should not capture telemetry");
}

static CommandEventData CreateCommandEventData(
    TestDbCommand command,
    Guid commandId,
    CommandSource commandSource,
    DbCommandMethod executeMethod,
    bool async)
{
    return new CommandEventData(
        null!,
        static (_, _) => string.Empty,
        command.Connection!,
        command,
        command.CommandText,
        null!,
        executeMethod,
        commandId,
        Guid.NewGuid(),
        async,
        false,
        DateTimeOffset.UtcNow,
        commandSource);
}

static CommandExecutedEventData CreateCommandExecutedEventData(
    TestDbCommand command,
    Guid commandId,
    CommandSource commandSource,
    DbCommandMethod executeMethod,
    object result,
    bool async)
{
    return new CommandExecutedEventData(
        null!,
        static (_, _) => string.Empty,
        command.Connection!,
        command,
        command.CommandText,
        null!,
        executeMethod,
        commandId,
        Guid.NewGuid(),
        result,
        async,
        false,
        DateTimeOffset.UtcNow.AddMilliseconds(-7),
        TimeSpan.FromMilliseconds(7),
        commandSource);
}

static CommandErrorEventData CreateCommandErrorEventData(
    TestDbCommand command,
    Guid commandId,
    CommandSource commandSource,
    DbCommandMethod executeMethod,
    Exception error,
    bool async)
{
    return new CommandErrorEventData(
        null!,
        static (_, _) => string.Empty,
        command.Connection!,
        command,
        command.CommandText,
        null!,
        executeMethod,
        commandId,
        Guid.NewGuid(),
        error,
        async,
        false,
        DateTimeOffset.UtcNow.AddMilliseconds(-5),
        TimeSpan.FromMilliseconds(5),
        commandSource);
}

static CommandEndEventData CreateCommandEndEventData(
    TestDbCommand command,
    Guid commandId,
    CommandSource commandSource,
    DbCommandMethod executeMethod,
    bool async)
{
    return new CommandEndEventData(
        null!,
        static (_, _) => string.Empty,
        command.Connection!,
        command,
        command.CommandText,
        null!,
        executeMethod,
        commandId,
        Guid.NewGuid(),
        async,
        false,
        DateTimeOffset.UtcNow.AddMilliseconds(-11),
        TimeSpan.FromMilliseconds(11),
        commandSource);
}

static void Require(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException(message);
    }
}

#pragma warning disable CS8764, CS8765
internal sealed class TestDbCommand : DbCommand
{
    public TestDbCommand(DbConnection connection)
    {
        DbConnection = connection;
    }

    public override string CommandText { get; set; } = string.Empty;

    public override int CommandTimeout { get; set; }

    public override CommandType CommandType { get; set; } = CommandType.Text;

    public override bool DesignTimeVisible { get; set; }

    public override UpdateRowSource UpdatedRowSource { get; set; }

    protected override DbConnection? DbConnection { get; set; }

    protected override DbParameterCollection DbParameterCollection { get; } = new TestDbParameterCollection();

    protected override DbTransaction? DbTransaction { get; set; }

    public override void Cancel()
    {
    }

    public override int ExecuteNonQuery()
    {
        return 1;
    }

    public override object? ExecuteScalar()
    {
        return 1;
    }

    public override void Prepare()
    {
    }

    protected override DbParameter CreateDbParameter()
    {
        throw new NotSupportedException();
    }

    protected override DbDataReader ExecuteDbDataReader(CommandBehavior behavior)
    {
        throw new NotSupportedException();
    }
}

internal sealed class TestDbConnection : DbConnection
{
    public override string ConnectionString { get; set; } = "Data Source=redacted;Pass" + "word=sample";

    public override string Database => "checkout";

    public override string DataSource => "private-host";

    public override string ServerVersion => "1.0";

    public override ConnectionState State => ConnectionState.Open;

    public override void ChangeDatabase(string databaseName)
    {
    }

    public override void Close()
    {
    }

    public override void Open()
    {
    }

    protected override DbTransaction BeginDbTransaction(IsolationLevel isolationLevel)
    {
        throw new NotSupportedException();
    }

    protected override DbCommand CreateDbCommand()
    {
        return new TestDbCommand(this);
    }
}

internal sealed class TestDbParameterCollection : DbParameterCollection
{
    public override int Count => 0;

    public override object SyncRoot { get; } = new object();

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

    public override System.Collections.IEnumerator GetEnumerator()
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
        throw new ArgumentOutOfRangeException(nameof(index));
    }

    protected override DbParameter GetParameter(string parameterName)
    {
        throw new ArgumentOutOfRangeException(nameof(parameterName));
    }

    protected override void SetParameter(int index, DbParameter value)
    {
        throw new ArgumentOutOfRangeException(nameof(index));
    }

    protected override void SetParameter(string parameterName, DbParameter value)
    {
        throw new ArgumentOutOfRangeException(nameof(parameterName));
    }
}
