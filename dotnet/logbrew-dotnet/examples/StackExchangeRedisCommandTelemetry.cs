using System;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using System.Threading.Tasks;
using LogBrew;
using LogBrew.StackExchangeRedis;
using StackExchange.Redis;

public static class Program
{
    private const string IncomingTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    public static async Task Main()
    {
        var client = LogBrewClient.Create("LOGBREW_API_KEY", "checkout-dotnet-service", "0.1.0");
        var root = LogBrewTraceContext.FromTraceparent(IncomingTraceparent, "b7ad6b7169203331");
        var database = DemoRedisDatabase.Create(databaseIndex: 4, syncResult: "cached-cart", asyncResult: "cached-account");

        using (LogBrewTrace.Activate(root))
        {
            var cart = database.TraceLogBrewCommand(
                client,
                "GET cart:private",
                redis => redis.StringGet("cart:private"),
                LogBrewStackExchangeRedisCommandOptions.Create()
                    .WithEventIdPrefix("dotnet_stackexchange_redis")
                    .WithCacheName("checkout-cache")
                    .WithMetadata(new Dictionary<string, object?>
                    {
                        ["feature"] = "checkout",
                        ["command"] = "GET cart:private",
                        ["key"] = "cart:private"
                    }));
            if (cart.ToString() != "cached-cart" || !DemoRedisDatabase.From(database).SawSyncTrace)
            {
                throw new InvalidOperationException("expected Redis helper to preserve sync result and activate child trace");
            }

            var account = await database.TraceLogBrewCommandAsync(
                client,
                "MGET account:private",
                redis => redis.StringGetAsync("account:private"),
                LogBrewStackExchangeRedisCommandOptions.Create()
                    .WithEventIdPrefix("dotnet_stackexchange_redis")
                    .WithCacheName("account-cache")).ConfigureAwait(false);
            if (account.ToString() != "cached-account" || !DemoRedisDatabase.From(database).SawAsyncTrace)
            {
                throw new InvalidOperationException("expected Redis helper to preserve async result and activate child trace");
            }

            try
            {
                DemoRedisDatabase.From(database).SyncError = new InvalidOperationException("redis failure with private key");
                database.TraceLogBrewCommand(
                    client,
                    "SET private:key",
                    redis => redis.StringGet("private:key"),
                    LogBrewStackExchangeRedisCommandOptions.Create()
                        .WithEventIdPrefix("dotnet_stackexchange_redis")
                        .WithCacheName("checkout-cache"));
            }
            catch (InvalidOperationException)
            {
                // The SDK preserves the original Redis exception while emitting type-only span diagnostics.
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

    private class DemoRedisDatabase : DispatchProxy
    {
        private int databaseIndex;
        private RedisValue syncResult;
        private RedisValue asyncResult;

        internal Exception? SyncError { get; set; }

        internal bool SawSyncTrace { get; private set; }

        internal bool SawAsyncTrace { get; private set; }

        internal static IDatabase Create(int databaseIndex, RedisValue syncResult, RedisValue asyncResult)
        {
            var database = DispatchProxy.Create<IDatabase, DemoRedisDatabase>();
            var proxy = From(database);
            proxy.databaseIndex = databaseIndex;
            proxy.syncResult = syncResult;
            proxy.asyncResult = asyncResult;
            return database;
        }

        internal static DemoRedisDatabase From(IDatabase database)
        {
            return (DemoRedisDatabase)(object)database;
        }

        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
        {
            if (targetMethod == null)
            {
                return null;
            }

            if (targetMethod.Name == "get_Database")
            {
                return databaseIndex;
            }

            if (targetMethod.Name == "StringGet" && targetMethod.ReturnType == typeof(RedisValue))
            {
                SawSyncTrace = LogBrewTrace.Current != null;
                if (SyncError != null)
                {
                    throw SyncError;
                }

                return syncResult;
            }

            if (targetMethod.Name == "StringGetAsync" && targetMethod.ReturnType == typeof(Task<RedisValue>))
            {
                SawAsyncTrace = LogBrewTrace.Current != null;
                return Task.FromResult(asyncResult);
            }

            return DefaultValue(targetMethod.ReturnType);
        }

        private static object? DefaultValue(Type type)
        {
            if (type == typeof(void))
            {
                return null;
            }

            if (type.IsValueType)
            {
                return Activator.CreateInstance(type);
            }

            if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(Task<>))
            {
                var resultType = type.GetGenericArguments()[0];
                var fromResult = typeof(Task).GetMethod(nameof(Task.FromResult))!.MakeGenericMethod(resultType);
                return fromResult.Invoke(null, new[] { DefaultValue(resultType) });
            }

            return null;
        }
    }
}
