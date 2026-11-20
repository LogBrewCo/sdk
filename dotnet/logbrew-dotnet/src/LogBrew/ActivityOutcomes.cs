using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading;

namespace LogBrew
{
    public static partial class LogBrewActivitySpanTelemetry
    {
        private const int MaxBreadcrumbMessage = 512;
        private const int MaxBreadcrumbCategory = 64;
        private const string InnerStackEnd = "--- End of inner exception stack trace ---";
        private static readonly ConditionalWeakTable<Activity, BreadcrumbTrail> BreadcrumbTrails = new ConditionalWeakTable<Activity, BreadcrumbTrail>();
        private static long breadcrumbSequence;

        /// <summary>
        /// Adds one breadcrumb to the trail of an Activity. An issue for that Activity, or for an Activity
        /// started inside it, includes the breadcrumb. Returns false when the breadcrumb is not valid.
        /// </summary>
        public static bool RecordBreadcrumb(Activity? activity, IssueBreadcrumb breadcrumb)
        {
            ExceptionContract.ThrowIfNull(breadcrumb, nameof(breadcrumb));
            if (activity == null)
            {
                return false;
            }

            try
            {
                breadcrumb.ToJsonObject();
            }
            catch (SdkException)
            {
                return false;
            }

            BreadcrumbTrails.GetValue(activity, _ => new BreadcrumbTrail()).Add(breadcrumb);
            return true;
        }

        /// <summary>
        /// Sends the outcome of an ended server or consumer Activity: one duration histogram in milliseconds,
        /// and one issue with stack frames and breadcrumbs when it failed with an exception event. Every ended
        /// Activity also becomes a breadcrumb on its parent. Returns false when LogBrew rejects an event.
        /// </summary>
        public static bool CaptureOutcome(
            LogBrewClient client,
            Activity? activity,
            LogBrewActivitySpanOptions? options = null)
        {
            ExceptionContract.ThrowIfNull(client, nameof(client));
            if (!TryCreateSpanContext(activity, out var context))
            {
                return false;
            }

            var ended = activity!;
            var safeOptions = options ?? LogBrewActivitySpanOptions.Create();
            var failed = IsFailed(ended);
            RecordBreadcrumb(ended.Parent, EndedActivityBreadcrumb(ended, failed));
            if (ended.Kind != ActivityKind.Server && ended.Kind != ActivityKind.Consumer)
            {
                return true;
            }

            var telemetryContext = ActivityTelemetryContext(context, safeOptions);
            try
            {
                client.Metric(
                    safeOptions.EventIdPrefix + "_metric_" + context.SpanId,
                    safeOptions.TimestampProvider(),
                    MetricAttributes.Create(DurationMetricName(ended), "histogram", Math.Max(0, ended.Duration.TotalMilliseconds), "ms", "delta")
                        .WithMetadata(OutcomeMetadata(ended, failed))
                        .WithContext(telemetryContext));
                var issue = failed ? ActivityIssue(ended, safeOptions) : null;
                if (issue != null)
                {
                    client.Issue(
                        safeOptions.EventIdPrefix + "_issue_" + context.SpanId,
                        safeOptions.TimestampProvider(),
                        issue.WithContext(telemetryContext));
                }

                return true;
            }
            catch (SdkException error)
            {
                ReportCaptureError(safeOptions.OnErrorHandler, error);
                return false;
            }
        }

        internal static TelemetryContext? CurrentActivityContext()
        {
            if (!TryCreateSpanContext(Activity.Current, out var context))
            {
                return null;
            }

            return TelemetryContext.Create()
                .WithTrace(context.TraceId, context.SpanId, context.ParentSpanId, context.Sampled)
                .Build();
        }

        internal static void RecordLogBreadcrumb(string categoryName, string level, string message, string timestamp)
        {
            var activity = Activity.Current;
            if (activity == null)
            {
                return;
            }

            var text = BreadcrumbText(message);
            var category = "log." + categoryName;
            if (category.Length > MaxBreadcrumbCategory
                || !RecordBreadcrumb(activity, IssueBreadcrumb.Create(timestamp, category).WithType("log").WithLevel(level).WithMessage(text)))
            {
                RecordBreadcrumb(activity, IssueBreadcrumb.Create(timestamp, "log").WithType("log").WithLevel(level).WithMessage(text));
            }
        }

        private static bool IsFailed(Activity activity)
        {
            if (activity.Status == ActivityStatusCode.Error)
            {
                return true;
            }

            var metadata = new Dictionary<string, object?>(StringComparer.Ordinal);
            ActivityEventSummaries(activity, metadata);
            return string.Equals(StatusFromActivity(activity, metadata), "error", StringComparison.Ordinal);
        }

        private static string DurationMetricName(Activity activity)
        {
            if (activity.Kind == ActivityKind.Consumer)
            {
                return "messaging.process.duration";
            }

            return activity.GetTagItem("rpc.system.name") == null && activity.GetTagItem("rpc.system") == null
                ? "http.server.duration"
                : "rpc.server.duration";
        }

        private static Dictionary<string, object?> OutcomeMetadata(Activity activity, bool failed)
        {
            var metadata = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["source"] = "dotnet.activity",
                ["activityKind"] = activity.Kind.ToString().ToLowerInvariant(),
                ["status"] = failed ? "error" : "ok",
            };
            foreach (var tag in activity.TagObjects)
            {
                CopyKnownSafeTag(metadata, tag.Key, tag.Value);
            }

            return metadata;
        }

        private static IssueBreadcrumb EndedActivityBreadcrumb(Activity activity, bool failed)
        {
            var type = activity.GetTagItem("db.system") != null || activity.GetTagItem("db.system.name") != null
                ? "query"
                : activity.GetTagItem("http.request.method") != null || activity.GetTagItem("http.method") != null ? "http" : "default";
            var ended = new DateTimeOffset(activity.StartTimeUtc + activity.Duration, TimeSpan.Zero);
            return IssueBreadcrumb.Create(ended.ToString("O", CultureInfo.InvariantCulture), "activity." + activity.Kind.ToString().ToLowerInvariant())
                .WithType(type)
                .WithLevel(failed ? "error" : "info")
                .WithMessage(BreadcrumbText(ActivityName(activity)));
        }

        private static IssueAttributes? ActivityIssue(Activity activity, LogBrewActivitySpanOptions options)
        {
            ActivityEvent? exceptionEvent = null;
            foreach (var activityEvent in activity.Events)
            {
                if (IsExceptionEvent(activityEvent))
                {
                    exceptionEvent = activityEvent;
                }
            }

            if (exceptionEvent == null)
            {
                return null;
            }

            var eventMetadata = ActivityEventMetadata(exceptionEvent.Value);
            var exceptionType = eventMetadata.TryGetValue("exceptionType", out var typeValue)
                ? Convert.ToString(typeValue, CultureInfo.InvariantCulture)
                : null;
            var escaped = TryExceptionEscaped(eventMetadata, out var escapedValue) && escapedValue;
            var issue = IssueAttributes.Create(ActivityName(activity, options) + " failed", "error")
                .WithException(IssueExceptionInfo.Create(string.IsNullOrWhiteSpace(exceptionType) ? "Exception" : exceptionType!)
                    .WithMechanism(IssueExceptionMechanism.Create("dotnet.activity", !escaped)))
                .WithMetadata(OutcomeMetadata(activity, true));
            var frames = StackFramesFromText(Convert.ToString(exceptionEvent.Value.Tags.FirstOrDefault(tag => string.Equals(tag.Key, "exception.stacktrace", StringComparison.Ordinal)).Value, CultureInfo.InvariantCulture));
            if (frames.Count > 0)
            {
                issue.WithStackFrames(frames);
            }

            AttachBreadcrumbs(issue, activity);
            return issue;
        }

        private static void AttachBreadcrumbs(IssueAttributes issue, Activity activity)
        {
            var collected = new List<KeyValuePair<long, IssueBreadcrumb>>();
            var truncated = false;
            for (var current = activity; current != null; current = current.Parent)
            {
                if (BreadcrumbTrails.TryGetValue(current, out var trail))
                {
                    truncated |= trail.CopyTo(collected);
                }
            }

            if (collected.Count == 0)
            {
                return;
            }

            var ordered = collected.OrderBy(entry => entry.Key).Select(entry => entry.Value).ToList();
            if (ordered.Count > IssueDiagnostics.MaxBreadcrumbs)
            {
                truncated = true;
                ordered = ordered.GetRange(ordered.Count - IssueDiagnostics.MaxBreadcrumbs, IssueDiagnostics.MaxBreadcrumbs);
            }

            issue.WithBreadcrumbs(ordered);
            if (truncated)
            {
                issue.WithBreadcrumbsTruncated(true);
            }
        }

        private static List<IssueStackFrame> StackFramesFromText(string? text)
        {
            var frames = new List<IssueStackFrame>();
            if (string.IsNullOrWhiteSpace(text))
            {
                return frames;
            }

            var lines = text!.Split('\n');
            var start = 0;
            for (var index = 0; index < lines.Length; index++)
            {
                if (string.Equals(lines[index].Trim(), InnerStackEnd, StringComparison.Ordinal))
                {
                    start = index + 1;
                }
            }

            for (var index = start; index < lines.Length && frames.Count < IssueDiagnostics.MaxStackFrames; index++)
            {
                var line = lines[index].Trim();
                if (line.StartsWith("at ", StringComparison.Ordinal))
                {
                    var frame = StackFrameFromLine(line.Substring(3));
                    if (frame != null)
                    {
                        frames.Add(frame);
                    }
                }
            }

            return frames;
        }

        private static IssueStackFrame? StackFrameFromLine(string text)
        {
            var method = text;
            string? file = null;
            var lineNumber = 1;
            var location = text.LastIndexOf(" in ", StringComparison.Ordinal);
            if (location >= 0)
            {
                var suffix = text.Substring(location + 4);
                var marker = suffix.LastIndexOf(":line ", StringComparison.Ordinal);
                if (marker > 0
                    && TryParseLineNumber(suffix, marker + 6, out var parsed))
                {
                    file = suffix.Substring(0, marker);
                    lineNumber = parsed;
                    method = text.Substring(0, location);
                }
            }

            var parenthesis = method.IndexOf('(');
            var qualified = (parenthesis >= 0 ? method.Substring(0, parenthesis) : method).Trim();
            var dot = qualified.LastIndexOf('.');
            if (dot > 0 && qualified[dot - 1] == '.')
            {
                dot--;
            }

            var function = dot >= 0 ? qualified.Substring(dot + 1) : qualified;
            var module = dot > 0 ? qualified.Substring(0, dot) : null;
            var typeName = module?.Substring(module.LastIndexOf('.') + 1);
            try
            {
                string filename;
                try
                {
                    filename = IssueDiagnostics.GeneratedFilename(file, typeName);
                }
                catch (SdkException)
                {
                    filename = IssueDiagnostics.GeneratedFilename(null, typeName);
                }

                var frame = IssueStackFrame.Create(filename, lineNumber, 1);
                if (function.Length > 0)
                {
                    frame.WithFunction(function);
                }

                if (module != null)
                {
                    frame.WithModule(module);
                }

                frame.ToJsonObject();
                return frame;
            }
            catch (SdkException)
            {
                return null;
            }
        }

        private static bool TryParseLineNumber(string text, int start, out int value)
        {
            value = 0;
            if (start >= text.Length || text.Length - start > 9)
            {
                return false;
            }

            for (var index = start; index < text.Length; index++)
            {
                var digit = text[index] - '0';
                if (digit < 0 || digit > 9)
                {
                    value = 0;
                    return false;
                }

                value = (value * 10) + digit;
            }

            return value > 0;
        }

        private static string BreadcrumbText(string value)
        {
            var characters = value.Select(character => char.IsControl(character) ? ' ' : character).ToArray();
            var text = new string(characters).Trim();
            return text.Length > MaxBreadcrumbMessage ? text.Substring(0, MaxBreadcrumbMessage) : text;
        }

        private sealed class BreadcrumbTrail
        {
            private readonly object gate = new object();
            private readonly Queue<KeyValuePair<long, IssueBreadcrumb>> entries = new Queue<KeyValuePair<long, IssueBreadcrumb>>();
            private bool dropped;

            internal void Add(IssueBreadcrumb breadcrumb)
            {
                var entry = new KeyValuePair<long, IssueBreadcrumb>(Interlocked.Increment(ref breadcrumbSequence), breadcrumb);
                lock (gate)
                {
                    entries.Enqueue(entry);
                    if (entries.Count > IssueDiagnostics.MaxBreadcrumbs)
                    {
                        entries.Dequeue();
                        dropped = true;
                    }
                }
            }

            internal bool CopyTo(List<KeyValuePair<long, IssueBreadcrumb>> target)
            {
                lock (gate)
                {
                    target.AddRange(entries);
                    return dropped;
                }
            }
        }
    }
}
