using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;

namespace LogBrew
{
    public sealed class LogBrewActivitySourceListenerOptions
    {
        private readonly HashSet<string> sourceNames = new HashSet<string>(StringComparer.Ordinal);

        internal LogBrewActivitySpanOptions SpanOptions { get; } = LogBrewActivitySpanOptions.Create();

        internal Func<Activity, bool>? ActivityFilter { get; private set; }

        internal Func<Activity, IDictionary<string, object?>?>? MetadataProvider { get; private set; }

        internal IReadOnlyCollection<string> SourceNames => sourceNames;

        public static LogBrewActivitySourceListenerOptions Create()
        {
            return new LogBrewActivitySourceListenerOptions();
        }

        public LogBrewActivitySourceListenerOptions WithActivityFilter(Func<Activity, bool> value)
        {
            ActivityFilter = value ?? throw new ArgumentNullException(nameof(value));
            return this;
        }

        public LogBrewActivitySourceListenerOptions WithEventIdPrefix(string value)
        {
            SpanOptions.WithEventIdPrefix(value);
            return this;
        }

        public LogBrewActivitySourceListenerOptions WithMetadata(IDictionary<string, object?> value)
        {
            SpanOptions.WithMetadata(value);
            return this;
        }

        public LogBrewActivitySourceListenerOptions WithMetadataProvider(Func<Activity, IDictionary<string, object?>?> value)
        {
            MetadataProvider = value ?? throw new ArgumentNullException(nameof(value));
            return this;
        }

        public LogBrewActivitySourceListenerOptions WithSourceName(string value)
        {
            Validation.RequireNonEmpty("ActivitySource name", value);
            sourceNames.Add(value.Trim());
            return this;
        }

        public LogBrewActivitySourceListenerOptions WithTimestampProvider(Func<string> value)
        {
            SpanOptions.WithTimestampProvider(value);
            return this;
        }

        public LogBrewActivitySourceListenerOptions OnError(Action<SdkException> value)
        {
            SpanOptions.OnError(value);
            return this;
        }
    }

    public sealed class LogBrewActivitySourceListener : IDisposable
    {
        private readonly LogBrewClient client;
        private readonly ActivityListener listener;
        private readonly LogBrewActivitySourceListenerOptions options;
        private bool disposed;

        private LogBrewActivitySourceListener(LogBrewClient client, LogBrewActivitySourceListenerOptions options)
        {
            this.client = client;
            this.options = options;
            listener = new ActivityListener
            {
                ShouldListenTo = ShouldListenTo,
                Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllDataAndRecorded,
                SampleUsingParentId = (ref ActivityCreationOptions<string> _) => ActivitySamplingResult.AllDataAndRecorded,
                ActivityStopped = CaptureActivity
            };

            ActivitySource.AddActivityListener(listener);
        }

        public static LogBrewActivitySourceListener Start(
            LogBrewClient client,
            Action<LogBrewActivitySourceListenerOptions>? configure = null)
        {
            if (client == null)
            {
                throw new ArgumentNullException(nameof(client));
            }

            var options = LogBrewActivitySourceListenerOptions.Create();
            configure?.Invoke(options);
            return new LogBrewActivitySourceListener(client, options);
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }

            listener.Dispose();
            disposed = true;
            GC.SuppressFinalize(this);
        }

        private void CaptureActivity(Activity activity)
        {
            if (disposed || !ShouldCapture(activity))
            {
                return;
            }

            LogBrewActivitySpanTelemetry.Capture(client, activity, CaptureOptions(activity));
        }

        private LogBrewActivitySpanOptions CaptureOptions(Activity activity)
        {
            var spanOptions = LogBrewActivitySpanOptions.Create()
                .WithEventIdPrefix(options.SpanOptions.EventIdPrefix)
                .WithTimestampProvider(options.SpanOptions.TimestampProvider)
                .WithActivityNameOverride(SafeActivityName(activity));
            if (options.SpanOptions.OnErrorHandler != null)
            {
                spanOptions.OnError(options.SpanOptions.OnErrorHandler);
            }

            var metadata = TelemetryMetadata.CopySafeDependencyMetadata(options.SpanOptions.Metadata);
            var dynamicMetadata = DynamicMetadata(activity);
            foreach (var item in dynamicMetadata)
            {
                metadata[item.Key] = item.Value;
            }

            if (metadata.Count > 0)
            {
                spanOptions.WithMetadata(metadata);
            }

            return spanOptions;
        }

        private IDictionary<string, object?> DynamicMetadata(Activity activity)
        {
            if (options.MetadataProvider == null)
            {
                return new Dictionary<string, object?>();
            }

            try
            {
                return TelemetryMetadata.CopySafeDependencyMetadata(options.MetadataProvider(activity));
            }
            catch (Exception error)
            {
                ReportCaptureError("ActivitySource metadata provider failed: " + error.GetType().Name);
                return new Dictionary<string, object?>();
            }
        }

        private bool ShouldCapture(Activity activity)
        {
            if (options.ActivityFilter == null)
            {
                return true;
            }

            try
            {
                return options.ActivityFilter(activity);
            }
            catch (Exception error)
            {
                ReportCaptureError("ActivitySource filter failed: " + error.GetType().Name);
                return false;
            }
        }

        private bool ShouldListenTo(ActivitySource source)
        {
            if (options.SourceNames.Count == 0)
            {
                return false;
            }

            foreach (var sourceName in options.SourceNames)
            {
                if (string.Equals(sourceName, source.Name, StringComparison.Ordinal))
                {
                    return true;
                }
            }

            return false;
        }

        private static string SafeActivityName(Activity activity)
        {
            var name = string.IsNullOrWhiteSpace(activity.DisplayName) ? activity.OperationName ?? string.Empty : activity.DisplayName;
            if (IsSafeActivityName(name))
            {
                return name;
            }

            var method = SafeHttpMethod(TagText(activity, "http.request.method") ?? TagText(activity, "http.method"));
            var route = SafeRoute(TagText(activity, "http.route"));
            if (method != null && route != null)
            {
                return method + " " + route;
            }

            var sourceName = string.IsNullOrWhiteSpace(activity.Source.Name) ? "activity" : activity.Source.Name;
            return sourceName + "." + activity.Kind.ToString().ToLowerInvariant();
        }

        private static bool IsSafeActivityName(string value)
        {
            if (string.IsNullOrWhiteSpace(value) || value.Length > 120)
            {
                return false;
            }

            return value.IndexOf("://", StringComparison.Ordinal) < 0
                && value.IndexOf("?", StringComparison.Ordinal) < 0
                && value.IndexOf("#", StringComparison.Ordinal) < 0
                && value.IndexOf("\r", StringComparison.Ordinal) < 0
                && value.IndexOf("\n", StringComparison.Ordinal) < 0
                && value.IndexOf("authorization", StringComparison.OrdinalIgnoreCase) < 0
                && value.IndexOf("cookie", StringComparison.OrdinalIgnoreCase) < 0
                && value.IndexOf("pass" + "word", StringComparison.OrdinalIgnoreCase) < 0
                && value.IndexOf("sec" + "ret", StringComparison.OrdinalIgnoreCase) < 0
                && value.IndexOf("tok" + "en", StringComparison.OrdinalIgnoreCase) < 0;
        }

        private static string? SafeHttpMethod(string? value)
        {
            if (value == null)
            {
                return null;
            }

            try
            {
                return TimelineMetadata.NormalizeHttpMethod(value);
            }
            catch (SdkException)
            {
                return null;
            }
        }

        private static string? SafeRoute(string? value)
        {
            if (value == null)
            {
                return null;
            }

            var route = TimelineMetadata.SanitizeRouteTemplate("ActivitySource route", value);
            return route.Length == 0 ? null : route;
        }

        private static string? TagText(Activity activity, string name)
        {
            foreach (var tag in activity.TagObjects)
            {
                if (tag.Key == null
                    || !string.Equals(tag.Key, name, StringComparison.Ordinal)
                    || !Validation.IsMetadataValue(tag.Value))
                {
                    continue;
                }

                var text = Convert.ToString(tag.Value, CultureInfo.InvariantCulture);
                if (!string.IsNullOrWhiteSpace(text))
                {
                    return text;
                }
            }

            return null;
        }

        private void ReportCaptureError(string message)
        {
            var onError = options.SpanOptions.OnErrorHandler;
            if (onError == null)
            {
                return;
            }

            try
            {
                onError(new SdkException("capture_error", message));
            }
            catch
            {
            }
        }
    }
}
