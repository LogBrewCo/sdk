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

public static class Program
{
    private const string IncomingTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    public static async Task Main()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "checkout-dotnet-service", "0.1.0");
        var root = LogBrewTraceContext.FromTraceparent(IncomingTraceparent, "b7ad6b7169203331");

        using (LogBrewTrace.Activate(root))
        {
            using var updateCommand = new DemoDbCommand
            {
                CommandText = "UPDATE orders SET card_number = 'sample' WHERE id = @id",
                CommandType = CommandType.Text,
                AffectedRows = 4
            };
            var changed = LogBrewDbCommandTelemetry.ExecuteNonQuery(
                client,
                updateCommand,
                LogBrewDbCommandOptions.Create()
                    .WithEventIdPrefix("dotnet_dbcommand")
                    .WithSystem("sqlserver")
                    .WithOperationName("orders.update")
                    .WithDatabaseName("checkout")
                    .WithMetadata(new Dictionary<string, object?>
                    {
                        ["feature"] = "checkout",
                        ["sql"] = "UPDATE orders SET card_number = 'sample'",
                        ["connection_string"] = "Server=example;User=sample"
                    }));
            if (changed != 4 || !updateCommand.SawActiveTrace)
            {
                throw new InvalidOperationException("expected DbCommand helper to preserve result and activate child trace");
            }

            using var countCommand = new DemoDbCommand
            {
                CommandText = "SELECT COUNT(*) FROM orders",
                ScalarResult = 9
            };
            var count = await LogBrewDbCommandTelemetry.ExecuteScalarAsync(
                client,
                countCommand,
                LogBrewDbCommandOptions.Create()
                    .WithEventIdPrefix("dotnet_dbcommand")
                    .WithOperationName("orders.count"),
                CancellationToken.None).ConfigureAwait(false);
            if ((int)count! != 9)
            {
                throw new InvalidOperationException("expected DbCommand scalar result");
            }

            try
            {
                using var failingCommand = new DemoDbCommand
                {
                    CommandText = "INSERT INTO payments(card_number) VALUES ('sample')",
                    ExecuteError = new InvalidOperationException("database provider error with sample command details")
                };
                LogBrewDbCommandTelemetry.ExecuteNonQuery(
                    client,
                    failingCommand,
                    LogBrewDbCommandOptions.Create()
                        .WithEventIdPrefix("dotnet_dbcommand")
                        .WithOperationName("payments.insert")
                        .WithSystem("sqlserver"));
            }
            catch (InvalidOperationException)
            {
                // The SDK preserves the original provider exception while emitting type-only span diagnostics.
            }
        }

        var events = client.PendingEvents();
        Console.WriteLine(client.PreviewJson());
        var response = client.Shutdown(RecordingTransport.AlwaysAccept());
        Console.Error.WriteLine(
            "{\"ok\":true,\"events\":"
            + events.ToString(CultureInfo.InvariantCulture)
            + ",\"status\":"
            + response.StatusCode.ToString(CultureInfo.InvariantCulture)
            + ",\"attempts\":"
            + response.Attempts.ToString(CultureInfo.InvariantCulture)
            + "}");
    }

    private sealed class DemoDbCommand : DbCommand
    {
        private readonly DemoParameterCollection parameters = new DemoParameterCollection();

        [AllowNull]
        public override string CommandText { get; set; } = string.Empty;

        public override int CommandTimeout { get; set; }

        public override CommandType CommandType { get; set; } = CommandType.Text;

        public override UpdateRowSource UpdatedRowSource { get; set; }

        public override bool DesignTimeVisible { get; set; }

        internal int AffectedRows { get; set; }

        internal object? ScalarResult { get; set; }

        internal Exception? ExecuteError { get; set; }

        internal bool SawActiveTrace { get; private set; }

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
            SawActiveTrace = LogBrewTrace.Current != null;
            if (ExecuteError != null)
            {
                throw ExecuteError;
            }

            return AffectedRows;
        }

        public override object? ExecuteScalar()
        {
            return ScalarResult;
        }

        public override void Prepare()
        {
        }

        public override Task<object?> ExecuteScalarAsync(CancellationToken cancel)
        {
            return Task.FromResult(ScalarResult);
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

    private sealed class DemoParameterCollection : DbParameterCollection
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
