using System;
using System.Collections.Generic;
using System.Reflection;
using System.Threading.Tasks;
using LogBrew;
using LogBrew.StackExchangeRedis;
using StackExchange.Redis;

static void Require(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException(message);
    }
}

const string IncomingTraceparent = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01";

var tests = 0;

TraceCommandCreatesPrivacyBoundedSpan();
tests++;
await TraceCommandAsyncPreservesResultAndActiveTrace().ConfigureAwait(false);
tests++;
CommandFailurePreservesOriginalExceptionAndCapturesTypeOnlyEvent();
tests++;
CaptureFailureDoesNotReplaceRedisResult();
tests++;

await Console.Error.WriteLineAsync("{\"tests\":" + tests.ToString(System.Globalization.CultureInfo.InvariantCulture) + "}").ConfigureAwait(false);

static void TraceCommandCreatesPrivacyBoundedSpan()
{
    var client = LogBrewClient.Create("LOGBREW_API_KEY", "stackexchange-redis-tests", "0.1.0");
    var root = LogBrewTraceContext.FromTraceparent(IncomingTraceparent, "b7ad6b7169203331");
    var database = CreateDatabase(databaseIndex: 7, syncResult: "cached-value", asyncResult: "unused");
    var proxy = RedisDatabaseProxy.From(database);

    RedisValue result;
    using (LogBrewTrace.Activate(root))
    {
        result = database.TraceLogBrewCommand(
            client,
            "get cart:private",
            redis => redis.StringGet("cart:private"),
            LogBrewStackExchangeRedisCommandOptions.Create()
                .WithEventIdPrefix("dotnet_redis")
                .WithCacheName("checkout-cache")
                .WithMetadata(new Dictionary<string, object?>
                {
                    ["safe"] = true,
                    ["command"] = "GET cart:private",
                    ["host"] = "127.0.0.1",
                    ["key"] = "cart:private"
                }));
    }

    Require(result.ToString() == "cached-value", "expected Redis command result");
    Require(proxy.TraceDuringSync != null, "expected active Redis child trace");
    Require(proxy.TraceDuringSync!.TraceId == root.TraceId, "expected Redis child trace id");
    Require(proxy.TraceDuringSync.ParentSpanId == root.SpanId, "expected Redis parent span");

    var payload = client.PreviewJson();
    foreach (var expected in new[]
    {
        "\"id\": \"dotnet_redis_span_",
        "\"name\": \"stackexchange_redis.command:GET\"",
        "\"source\": \"stackexchange_redis.command\"",
        "\"framework\": \"stackexchange.redis\"",
        "\"cacheSystem\": \"redis\"",
        "\"cacheOperation\": \"GET\"",
        "\"cacheOperationKind\": \"read\"",
        "\"cacheName\": \"checkout-cache\"",
        "\"redisDatabaseIndex\": 7",
        "\"cacheHit\": true",
        "\"resultSizeBytes\": 12",
        "\"safe\": true",
        "\"traceId\": \"4bf92f3577b34da6a3ce929d0e0e4736\"",
        "\"parentSpanId\": \"b7ad6b7169203331\"",
        "\"sampled\": true"
    })
    {
        Require(payload.Contains(expected, StringComparison.Ordinal), "missing Redis payload: " + expected);
    }

    foreach (var blocked in new[]
    {
        "cart:private",
        "cached-value",
        "127.0.0.1",
        "GET cart:private"
    })
    {
        Require(!payload.Contains(blocked, StringComparison.Ordinal), "expected Redis detail to be omitted: " + blocked);
    }
}

static async Task TraceCommandAsyncPreservesResultAndActiveTrace()
{
    var client = LogBrewClient.Create("LOGBREW_API_KEY", "stackexchange-redis-tests", "0.1.0");
    var root = LogBrewTraceContext.FromTraceparent(IncomingTraceparent, "b7ad6b7169203332");
    var database = CreateDatabase(databaseIndex: 3, syncResult: "unused", asyncResult: "async-value");
    var proxy = RedisDatabaseProxy.From(database);

    RedisValue result;
    using (LogBrewTrace.Activate(root))
    {
        result = await database.TraceLogBrewCommandAsync(
            client,
            "mget account:private",
            redis => redis.StringGetAsync("account:private"),
            LogBrewStackExchangeRedisCommandOptions.Create().WithCacheName("session-cache")).ConfigureAwait(false);
    }

    Require(result.ToString() == "async-value", "expected async Redis result");
    Require(proxy.TraceDuringAsync != null, "expected active async Redis child trace");
    Require(proxy.TraceDuringAsync!.TraceId == root.TraceId, "expected async Redis child trace id");
    Require(proxy.TraceDuringAsync.ParentSpanId == root.SpanId, "expected async Redis parent span");

    var payload = client.PreviewJson();
    Require(payload.Contains("\"name\": \"stackexchange_redis.command:MGET\"", StringComparison.Ordinal), "expected async Redis span");
    Require(payload.Contains("\"redisDatabaseIndex\": 3", StringComparison.Ordinal), "expected async Redis database index");
    Require(payload.Contains("\"cacheName\": \"session-cache\"", StringComparison.Ordinal), "expected async Redis cache name");
    Require(payload.Contains("\"resultSizeBytes\": 11", StringComparison.Ordinal), "expected async Redis result size");
    Require(!payload.Contains("account:private", StringComparison.Ordinal), "expected async Redis key to be omitted");
    Require(!payload.Contains("async-value", StringComparison.Ordinal), "expected async Redis value to be omitted");
}

static void CommandFailurePreservesOriginalExceptionAndCapturesTypeOnlyEvent()
{
    var client = LogBrewClient.Create("LOGBREW_API_KEY", "stackexchange-redis-tests", "0.1.0");
    var original = new InvalidOperationException("redis failure includes private key");
    var database = CreateDatabase(databaseIndex: 1, syncResult: "unused", asyncResult: "unused");
    RedisDatabaseProxy.From(database).SyncError = original;

    try
    {
        database.TraceLogBrewCommand(
            client,
            "set private:key",
            redis => redis.StringGet("private:key"),
            LogBrewStackExchangeRedisCommandOptions.Create());
    }
    catch (InvalidOperationException error)
    {
        Require(object.ReferenceEquals(error, original), "expected original Redis exception");
    }

    var payload = client.PreviewJson();
    Require(payload.Contains("\"status\": \"error\"", StringComparison.Ordinal), "expected Redis error span");
    Require(payload.Contains("\"cacheOperation\": \"SET\"", StringComparison.Ordinal), "expected normalized failing command");
    Require(payload.Contains("\"cacheOperationKind\": \"write\"", StringComparison.Ordinal), "expected write command kind");
    Require(payload.Contains("\"errorType\": \"System.InvalidOperationException\"", StringComparison.Ordinal), "expected error type only");
    Require(payload.Contains("\"name\": \"exception\"", StringComparison.Ordinal), "expected exception span event");
    Require(payload.Contains("\"exceptionEscaped\": true", StringComparison.Ordinal), "expected escaped exception event");
    Require(!payload.Contains("redis failure includes", StringComparison.Ordinal), "expected exception message to be omitted");
    Require(!payload.Contains("private:key", StringComparison.Ordinal), "expected failing Redis key to be omitted");
}

static void CaptureFailureDoesNotReplaceRedisResult()
{
    var client = LogBrewClient.Create("LOGBREW_API_KEY", "stackexchange-redis-tests", "0.1.0");
    client.Shutdown(RecordingTransport.AlwaysAccept());
    var callbackErrors = 0;
    var database = CreateDatabase(databaseIndex: 0, syncResult: "still-returned", asyncResult: "unused");

    var result = database.TraceLogBrewCommand(
        client,
        "GET",
        redis => redis.StringGet("safe-to-omit"),
        LogBrewStackExchangeRedisCommandOptions.Create()
            .OnError(error =>
            {
                Require(error.Code == "shutdown_error", "expected shutdown capture error");
                callbackErrors++;
                throw new InvalidOperationException("diagnostics callback failed");
            }));

    Require(result.ToString() == "still-returned", "expected capture failure to preserve Redis result");
    Require(callbackErrors == 1, "expected capture error callback");
}

static IDatabase CreateDatabase(int databaseIndex, RedisValue syncResult, RedisValue asyncResult)
{
    var analyzerVisibleProxy = new RedisDatabaseProxyAnalyzerSubtype();
    GC.KeepAlive(analyzerVisibleProxy);
    var database = DispatchProxy.Create<IDatabase, RedisDatabaseProxy>();
    var proxy = RedisDatabaseProxy.From(database);
    proxy.DatabaseIndex = databaseIndex;
    proxy.SyncResult = syncResult;
    proxy.AsyncResult = asyncResult;
    return database;
}

internal class RedisDatabaseProxy : DispatchProxy
{
    internal int DatabaseIndex { get; set; }

    internal RedisValue SyncResult { get; set; }

    internal RedisValue AsyncResult { get; set; }

    internal Exception? SyncError { get; set; }

    internal LogBrewTraceContext? TraceDuringSync { get; private set; }

    internal LogBrewTraceContext? TraceDuringAsync { get; private set; }

    internal static RedisDatabaseProxy From(IDatabase database)
    {
        return (RedisDatabaseProxy)(object)database;
    }

    protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
    {
        if (targetMethod == null)
        {
            return null;
        }

        if (targetMethod.Name == "get_Database")
        {
            return DatabaseIndex;
        }

        if (targetMethod.Name == "StringGet" && targetMethod.ReturnType == typeof(RedisValue))
        {
            TraceDuringSync = LogBrewTrace.Current;
            if (SyncError != null)
            {
                throw SyncError;
            }

            return SyncResult;
        }

        if (targetMethod.Name == "StringGetAsync" && targetMethod.ReturnType == typeof(Task<RedisValue>))
        {
            TraceDuringAsync = LogBrewTrace.Current;
            return Task.FromResult(AsyncResult);
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

internal sealed class RedisDatabaseProxyAnalyzerSubtype : RedisDatabaseProxy
{
}
