using System.Text.Json;
using Hangfire;
using Hangfire.InMemory;
using LogBrew;
using LogBrew.Hangfire;
using Microsoft.Extensions.Logging;

const string PrivateArgument = "PRIVATE_HANGFIRE_ARGUMENT";

var client = LogBrewClient.Create("LOGBREW_API_KEY", "hangfire-tests", "0.1.0");
using var factory = LoggerFactory.Create(builder => builder.AddLogBrew(client));
Jobs.Configure(factory.CreateLogger("Hangfire.Tests.Job"));
GlobalConfiguration.Configuration.UseInMemoryStorage().UseLogBrewHangfire(client);
using (var server = new BackgroundJobServer(new BackgroundJobServerOptions { WorkerCount = 1 }))
{
    var success = BackgroundJob.Enqueue(() => Jobs.Success(PrivateArgument));
    var failure = BackgroundJob.Enqueue(() => Jobs.Failure(PrivateArgument));
    Require(Jobs.Completed.Wait(TimeSpan.FromSeconds(15)), "Hangfire jobs did not execute");
    Require(WaitForState(success, "Succeeded"), "successful job did not reach Succeeded");
    Require(WaitForState(failure, "Failed"), "failed job did not reach Failed");
}

var payload = client.PreviewJson();
using var document = JsonDocument.Parse(payload);
var events = document.RootElement.GetProperty("events").EnumerateArray().ToArray();
Require(events.Length == 5, "expected two logs, two spans, and one issue");
Require(events.Count(item => Type(item) == "log") == 2, "expected two job logs");
Require(events.Count(item => Type(item) == "span") == 2, "expected two job spans");
Require(events.Count(item => Type(item) == "issue") == 1, "expected one failed-job issue");

foreach (var name in new[] { "Jobs.Success", "Jobs.Failure" })
{
    var span = events.Single(item => Type(item) == "span" && Attribute(item, "name") == name);
    var metadata = span.GetProperty("attributes").GetProperty("metadata");
    Require(metadata.GetProperty("source").GetString() == "hangfire.job", "expected Hangfire source");
    Require(metadata.GetProperty("framework").GetString() == "hangfire", "expected Hangfire framework");
    Require(metadata.GetProperty("operation").GetString() == "job.execute", "expected job operation");
    var log = events.Single(item => Type(item) == "log" && Attribute(item, "message").StartsWith(name, StringComparison.Ordinal));
    Require(Trace(log, "traceId") == Attribute(span, "traceId"), "job log did not inherit trace id");
    Require(Trace(log, "spanId") == Attribute(span, "spanId"), "job log did not inherit span id");
}

var issue = events.Single(item => Type(item) == "issue");
var issueAttributes = issue.GetProperty("attributes");
var errorSpan = events.Single(item => Type(item) == "span" && Attribute(item, "name") == "Jobs.Failure");
var mechanism = issueAttributes.GetProperty("exception").GetProperty("mechanism");
Require(mechanism.GetProperty("type").GetString() == "hangfire.job", "expected Hangfire issue mechanism");
Require(!mechanism.GetProperty("handled").GetBoolean(), "expected unhandled job issue");
Require(Trace(issue, "traceId") == Attribute(errorSpan, "traceId"), "issue did not inherit job trace id");
Require(Trace(issue, "spanId") == Attribute(errorSpan, "spanId"), "issue did not inherit job span id");
Require(Attribute(errorSpan, "status") == "error", "failed job span was not an error");
Require(!payload.Contains(PrivateArgument, StringComparison.Ordinal), "job argument leaked");
Require(!payload.Contains(Jobs.PrivateException, StringComparison.Ordinal), "exception message leaked");
Console.WriteLine(JsonSerializer.Serialize(new { integration = "hangfire", ok = true }));

static string Type(JsonElement item) => item.GetProperty("type").GetString() ?? "";

static string Attribute(JsonElement item, string name) =>
    item.GetProperty("attributes").GetProperty(name).GetString() ?? "";

static string Trace(JsonElement item, string name) =>
    item.GetProperty("attributes").GetProperty("context").GetProperty("trace").GetProperty(name).GetString() ?? "";

static bool WaitForState(string jobId, string expected)
{
    var deadline = DateTime.UtcNow.AddSeconds(15);
    do
    {
        var state = JobStorage.Current.GetMonitoringApi().JobDetails(jobId)?.History.FirstOrDefault()?.StateName;
        if (state == expected)
        {
            return true;
        }
        Thread.Sleep(20);
    } while (DateTime.UtcNow < deadline);
    return false;
}

static void Require(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException(message);
    }
}

internal static class Jobs
{
    internal const string PrivateException = "PRIVATE_HANGFIRE_EXCEPTION";
    private static ILogger? logger;
    internal static CountdownEvent Completed { get; } = new(2);
    internal static void Configure(ILogger value) => logger = value;

    public static void Success(string ignored)
    {
        _ = ignored;
        logger!.Log(LogLevel.Information, new EventId(1, "Success"), "Jobs.Success running", null, static (state, _) => state);
        Completed.Signal();
    }

    [AutomaticRetry(Attempts = 0)]
    public static void Failure(string ignored)
    {
        _ = ignored;
        logger!.Log(LogLevel.Information, new EventId(2, "Failure"), "Jobs.Failure running", null, static (state, _) => state);
        Completed.Signal();
        throw new InvalidOperationException(PrivateException);
    }
}
