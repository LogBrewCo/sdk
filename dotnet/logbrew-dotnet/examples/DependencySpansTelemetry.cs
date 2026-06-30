using System;
using System.Collections.Generic;
using LogBrew;

public static class Program
{
    private const string IncomingTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    public static void Main()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "checkout-dotnet-service", "0.1.0");
        var root = LogBrewTraceContext.FromTraceparent(IncomingTraceparent, "b7ad6b7169203331");
        var queueHeaders = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        using (LogBrewTrace.Activate(root))
        {
            var orderId = LogBrewOperationTracing.DatabaseOperation(
                client,
                "orders.select",
                () =>
                {
                    if (LogBrewTrace.Current == null || LogBrewTrace.Current.ParentSpanId != root.SpanId)
                    {
                        throw new InvalidOperationException("expected database operation to run under a child trace");
                    }

                    return "order_123";
                },
                LogBrewOperationTracing.DatabaseOperationOptions.Create()
                    .WithEventIdPrefix("dotnet_dependency")
                    .WithSystem("sqlserver")
                    .WithOperationKind("select")
                    .WithDatabaseName("checkout")
                    .WithStatementTemplate("SELECT * FROM orders WHERE id = ?")
                    .WithRowCount(1)
                    .WithMetadata(new Dictionary<string, object?>
                    {
                        ["feature"] = "checkout",
                        ["query"] = "SELECT * FROM orders WHERE id = 'sample'",
                        ["connection_string"] = "Server=example;User=sample"
                    }));

            var cacheHit = LogBrewOperationTracing.CacheOperation(
                client,
                "cart.get",
                () => true,
                LogBrewOperationTracing.CacheOperationOptions.Create()
                    .WithEventIdPrefix("dotnet_dependency")
                    .WithSystem("redis")
                    .WithOperationKind("get")
                    .WithCacheName("cart")
                    .WithHit(true)
                    .WithItemCount(1)
                    .WithMetadata(new Dictionary<string, object?>
                    {
                        ["feature"] = "checkout",
                        ["cache-key"] = "cart:sample"
                    }));

            try
            {
                LogBrewOperationTracing.DatabaseOperation<int>(
                    client,
                    "orders.fail",
                    () => throw new InvalidOperationException("database failed with sample payload details"),
                    LogBrewOperationTracing.DatabaseOperationOptions.Create()
                        .WithEventIdPrefix("dotnet_dependency")
                        .WithSystem("sqlserver")
                        .WithOperationKind("select")
                        .WithDatabaseName("checkout")
                        .WithMetadata(new Dictionary<string, object?>
                        {
                            ["feature"] = "checkout",
                            ["query"] = "SELECT * FROM orders WHERE id = 'sample'"
                        }));
            }
            catch (InvalidOperationException)
            {
                // The SDK preserves the original exception while capturing type-only span diagnostics.
            }

            var queued = LogBrewOperationTracing.QueueOperation(
                client,
                "invoice.publish",
                () =>
                {
                    if (!queueHeaders.TryGetValue("traceparent", out var traceparent)
                        || LogBrewTrace.Current == null
                        || traceparent != LogBrewTrace.Current.Traceparent)
                    {
                        throw new InvalidOperationException("expected queue traceparent header to match the active queue span");
                    }

                    return orderId.Length > 0 && cacheHit;
                },
                LogBrewOperationTracing.QueueOperationOptions.Create()
                    .WithEventIdPrefix("dotnet_dependency")
                    .WithSystem("kafka")
                    .WithOperationKind("publish")
                    .WithQueueName("invoices")
                    .WithTaskName("invoice.created")
                    .WithMessageCount(1)
                    .WithTraceparentHeaderSetter((name, value) => queueHeaders[name] = value)
                    .WithMetadata(new Dictionary<string, object?>
                    {
                        ["feature"] = "checkout",
                        ["messageBody"] = "sample payload"
                    }));

            if (!queued)
            {
                throw new InvalidOperationException("expected queue operation to complete");
            }
        }

        LogBrewOperationTracing.QueueOperation(
            client,
            "invoice.process",
            () =>
            {
                if (LogBrewTrace.Current == null || LogBrewTrace.Current.ParentSpanId == null)
                {
                    throw new InvalidOperationException("expected incoming message trace to be active");
                }

                return true;
            },
            LogBrewOperationTracing.QueueOperationOptions.Create()
                .WithEventIdPrefix("dotnet_dependency")
                .WithSystem("rabbitmq")
                .WithOperationKind("process")
                .WithQueueName("invoice-work")
                .WithIncomingTraceparent(queueHeaders.TryGetValue("traceparent", out var incomingTraceparent) ? incomingTraceparent : null)
                .WithMetadata(new Dictionary<string, object?> { ["feature"] = "checkout" })
                .WithLinkedMessageTraceparent("00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01", new Dictionary<string, object?>
                {
                    ["relation"] = "message",
                    ["payload"] = "sample payload"
                }));

        var events = client.PendingEvents();
        Console.WriteLine(client.PreviewJson());
        var response = client.Shutdown(RecordingTransport.AlwaysAccept());
        Console.Error.WriteLine(
            "{\"ok\":true,\"events\":"
            + events
            + ",\"status\":"
            + response.StatusCode
            + ",\"attempts\":"
            + response.Attempts
            + "}");
    }
}
