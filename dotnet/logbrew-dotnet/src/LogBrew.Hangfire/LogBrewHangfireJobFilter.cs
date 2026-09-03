using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using Hangfire;
using Hangfire.Common;
using Hangfire.Server;

namespace LogBrew.Hangfire
{
    public static class LogBrewHangfireExtensions
    {
        public static IGlobalConfiguration UseLogBrewHangfire(
            this IGlobalConfiguration configuration,
            LogBrewClient client,
            Action<Exception>? onError = null)
        {
            if (configuration == null)
            {
                throw new ArgumentNullException(nameof(configuration));
            }
            GlobalJobFilters.Filters.Add(new LogBrewHangfireJobFilter(client, onError));
            return configuration;
        }
    }

    public sealed class LogBrewHangfireJobFilter : IServerFilter
    {
        private const string Source = "hangfire.job";
        private readonly LogBrewClient client;
        private readonly Action<Exception>? onError;
        private readonly string stateKey = "LogBrew.Hangfire." + Guid.NewGuid().ToString("N");

        public LogBrewHangfireJobFilter(LogBrewClient client, Action<Exception>? onError = null)
        {
            this.client = client ?? throw new ArgumentNullException(nameof(client));
            this.onError = onError;
        }

        public void OnPerforming(PerformingContext context)
        {
            if (context == null)
            {
                throw new ArgumentNullException(nameof(context));
            }
            try
            {
                var parent = LogBrewTrace.Current;
                var trace = parent == null ? LogBrewTraceContext.CreateRoot() : LogBrewTraceContext.CreateChild(parent);
                context.Items[stateKey] = new JobState(
                    JobName(context.BackgroundJob.Job), trace,
                    LogBrewTrace.Activate(trace), Stopwatch.GetTimestamp());
            }
            catch (Exception error)
            {
                Report(error);
            }
        }

        public void OnPerformed(PerformedContext context)
        {
            if (context == null)
            {
                throw new ArgumentNullException(nameof(context));
            }
            if (!context.Items.TryGetValue(stateKey, out var rawState) || !(rawState is JobState state))
            {
                return;
            }
            try
            {
                if (context.Exception != null)
                {
                    TryCapture(() => CaptureIssue(state, context.Exception));
                }
                TryCapture(() => CaptureSpan(state, context.Exception, context.Canceled));
            }
            finally
            {
                state.Scope.Dispose();
                context.Items.Remove(stateKey);
            }
        }

        private void CaptureIssue(JobState state, Exception error)
        {
            client.Issue(
                EventId("issue", state.Trace.SpanId),
                Timestamp(),
                IssueAttributes.FromException(error, state.Name + " failed", Source, false)
                    .WithMetadata(Metadata(state, error, false))
                    .WithContext(state.Trace.ToTelemetryContext()));
        }

        private void CaptureSpan(JobState state, Exception? error, bool canceled)
        {
            var attributes = SpanAttributes.Create(
                    state.Name,
                    state.Trace.TraceId,
                    state.Trace.SpanId,
                    error == null && !canceled ? "ok" : "error")
                .WithDurationMs(Math.Max(0, (Stopwatch.GetTimestamp() - state.StartedAt) * 1000.0 / Stopwatch.Frequency))
                .WithMetadata(Metadata(state, error, canceled))
                .WithContext(state.Trace.ToTelemetryContext());
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
            client.Span(EventId("span", state.Trace.SpanId), Timestamp(), attributes);
        }

        private static Dictionary<string, object?> Metadata(JobState state, Exception? error, bool canceled)
        {
            var metadata = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["source"] = Source,
                ["framework"] = "hangfire",
                ["operation"] = "job.execute",
                ["sampled"] = state.Trace.Sampled
            };
            if (error != null)
            {
                metadata["errorType"] = error.GetType().FullName;
            }
            if (canceled)
            {
                metadata["canceled"] = true;
            }
            return metadata;
        }

        private static string EventId(string type, string spanId) => "dotnet_hangfire_" + type + "_" + spanId;

        private static string Timestamp() => DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture);

        private void TryCapture(Action capture)
        {
            try
            {
                capture();
            }
            catch (Exception error)
            {
                Report(error);
            }
        }

        private static string JobName(Job job)
        {
            var type = (job.Type.FullName ?? job.Type.Name).Split('`')[0];
            var name = type + "." + job.Method.Name;
            if (name.Length > 160)
            {
                return "hangfire.job";
            }
            foreach (var character in name)
            {
                if (!char.IsLetterOrDigit(character) && character != '.' && character != '_' && character != '+')
                {
                    return "hangfire.job";
                }
            }
            return name;
        }

        private void Report(Exception error)
        {
            try
            {
                onError?.Invoke(error);
            }
            catch
            {
            }
        }

        private sealed class JobState(
            string name,
            LogBrewTraceContext trace,
            IDisposable scope,
            long startedAt)
        {
            internal string Name { get; } = name;
            internal LogBrewTraceContext Trace { get; } = trace;
            internal IDisposable Scope { get; } = scope;
            internal long StartedAt { get; } = startedAt;
        }
    }
}
