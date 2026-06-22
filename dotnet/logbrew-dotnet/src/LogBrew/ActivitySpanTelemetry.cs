using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;

namespace LogBrew
{
    public sealed class LogBrewActivitySpanOptions
    {
        internal string EventIdPrefix { get; private set; } = "dotnet_activity";

        internal IDictionary<string, object?>? Metadata { get; private set; }

        internal Func<string> TimestampProvider { get; private set; } = DefaultTimestamp;

        internal Action<SdkException>? OnErrorHandler { get; private set; }

        internal string? ActivityNameOverride { get; private set; }

        public static LogBrewActivitySpanOptions Create()
        {
            return new LogBrewActivitySpanOptions();
        }

        public LogBrewActivitySpanOptions WithEventIdPrefix(string value)
        {
            Validation.RequireNonEmpty("Activity span eventIdPrefix", value);
            EventIdPrefix = value.Trim();
            return this;
        }

        public LogBrewActivitySpanOptions WithMetadata(IDictionary<string, object?> value)
        {
            Metadata = value;
            return this;
        }

        public LogBrewActivitySpanOptions WithTimestampProvider(Func<string> value)
        {
            TimestampProvider = value ?? throw new ArgumentNullException(nameof(value));
            return this;
        }

        public LogBrewActivitySpanOptions OnError(Action<SdkException> value)
        {
            OnErrorHandler = value ?? throw new ArgumentNullException(nameof(value));
            return this;
        }

        internal LogBrewActivitySpanOptions WithActivityNameOverride(string value)
        {
            Validation.RequireNonEmpty("Activity span name", value);
            ActivityNameOverride = value.Trim();
            return this;
        }

        private static string DefaultTimestamp()
        {
            return DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture);
        }
    }

    public static class LogBrewActivitySpanTelemetry
    {
        private const string ZeroSpanId = "0000000000000000";

        public static bool Capture(
            LogBrewClient client,
            Activity? activity,
            LogBrewActivitySpanOptions? options = null)
        {
            if (client == null)
            {
                throw new ArgumentNullException(nameof(client));
            }

            if (!TryCreateSpanContext(activity, out var context))
            {
                return false;
            }

            var capturedActivity = activity!;
            var safeOptions = options ?? LogBrewActivitySpanOptions.Create();
            var activityName = ActivityName(capturedActivity, safeOptions);
            var attributes = SpanAttributes.Create(activityName, context.TraceId, context.SpanId, StatusFromActivity(capturedActivity))
                .WithDurationMs(Math.Max(0, capturedActivity.Duration.TotalMilliseconds))
                .WithMetadata(ActivityMetadata(capturedActivity, context, safeOptions));
            if (context.ParentSpanId != null)
            {
                attributes.WithParentSpanId(context.ParentSpanId);
            }

            try
            {
                client.Span(
                    safeOptions.EventIdPrefix + "_span_" + context.SpanId,
                    safeOptions.TimestampProvider(),
                    attributes);
                return true;
            }
            catch (SdkException error)
            {
                ReportCaptureError(safeOptions.OnErrorHandler, error);
                return false;
            }
        }

        private static IDictionary<string, object?> ActivityMetadata(
            Activity activity,
            CapturedActivityContext context,
            LogBrewActivitySpanOptions options)
        {
            var metadata = TelemetryMetadata.CopySafeDependencyMetadata(options.Metadata);
            metadata["source"] = "dotnet.activity";
            metadata["activityName"] = ActivityName(activity, options);
            metadata["activityKind"] = activity.Kind.ToString().ToLowerInvariant();
            metadata["traceFlags"] = context.TraceFlags;
            metadata["traceSampled"] = context.Sampled;
            AddString(metadata, "activitySourceName", activity.Source.Name);
            AddString(metadata, "activitySourceVersion", activity.Source.Version);

            foreach (var tag in activity.TagObjects)
            {
                CopyKnownSafeTag(metadata, tag.Key, tag.Value);
            }

            return metadata;
        }

        private static bool TryCreateSpanContext(Activity? activity, out CapturedActivityContext context)
        {
            context = default;
            if (activity == null || activity.IdFormat != ActivityIdFormat.W3C)
            {
                return false;
            }

            var traceId = activity.TraceId.ToHexString();
            var spanId = activity.SpanId.ToHexString();
            var traceFlags = activity.ActivityTraceFlags.HasFlag(ActivityTraceFlags.Recorded) ? "01" : "00";
            try
            {
                Traceparent.Create(traceId, spanId, traceFlags);
            }
            catch (SdkException)
            {
                return false;
            }

            var parentSpanId = activity.ParentSpanId.ToHexString();
            context = new CapturedActivityContext(
                traceId,
                spanId,
                string.Equals(parentSpanId, ZeroSpanId, StringComparison.Ordinal) ? null : parentSpanId,
                traceFlags);
            return true;
        }

        private static void CopyKnownSafeTag(IDictionary<string, object?> metadata, string key, object? value)
        {
            if (string.IsNullOrWhiteSpace(key) || !Validation.IsMetadataValue(value))
            {
                return;
            }

            switch (key)
            {
                case "http.request.method":
                case "http.method":
                    AddString(metadata, "httpMethod", value);
                    break;
                case "http.route":
                    AddRouteTemplate(metadata, value);
                    break;
                case "http.response.status_code":
                case "http.status_code":
                    AddStatusCode(metadata, value);
                    break;
                case "db.system":
                    AddString(metadata, "dbSystem", value);
                    break;
                case "db.operation.name":
                case "db.operation":
                    AddString(metadata, "dbOperation", value);
                    break;
                case "messaging.system":
                    AddString(metadata, "messagingSystem", value);
                    break;
                case "messaging.operation.name":
                case "messaging.operation":
                    AddString(metadata, "messagingOperation", value);
                    break;
            }
        }

        private static string StatusFromActivity(Activity activity)
        {
            foreach (var tag in activity.TagObjects)
            {
                if (string.Equals(tag.Key, "otel.status_code", StringComparison.Ordinal)
                    && string.Equals(Convert.ToString(tag.Value, CultureInfo.InvariantCulture), "ERROR", StringComparison.OrdinalIgnoreCase))
                {
                    return "error";
                }

                if ((string.Equals(tag.Key, "http.response.status_code", StringComparison.Ordinal)
                        || string.Equals(tag.Key, "http.status_code", StringComparison.Ordinal))
                    && TryStatusCode(tag.Value, out var statusCode)
                    && statusCode >= 500)
                {
                    return "error";
                }
            }

            return "ok";
        }

        private static string ActivityName(Activity activity)
        {
            return string.IsNullOrWhiteSpace(activity.DisplayName) ? activity.OperationName : activity.DisplayName;
        }

        private static string ActivityName(Activity activity, LogBrewActivitySpanOptions options)
        {
            return options.ActivityNameOverride ?? ActivityName(activity);
        }

        private static void AddStatusCode(IDictionary<string, object?> metadata, object? value)
        {
            if (TryStatusCode(value, out var statusCode))
            {
                metadata["httpStatusCode"] = statusCode;
            }
        }

        private static void AddRouteTemplate(IDictionary<string, object?> metadata, object? value)
        {
            var text = Convert.ToString(value, CultureInfo.InvariantCulture);
            if (string.IsNullOrWhiteSpace(text))
            {
                return;
            }

            metadata["httpRoute"] = TimelineMetadata.SanitizeRouteTemplate("Activity route", text);
        }

        private static bool TryStatusCode(object? value, out int statusCode)
        {
            if (value is int intValue)
            {
                statusCode = intValue;
                return true;
            }

            var text = Convert.ToString(value, CultureInfo.InvariantCulture);
            if (int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out statusCode))
            {
                return true;
            }

            statusCode = 0;
            return false;
        }

        private static void AddString(IDictionary<string, object?> metadata, string key, object? value)
        {
            var text = Convert.ToString(value, CultureInfo.InvariantCulture);
            if (!string.IsNullOrWhiteSpace(text))
            {
                metadata[key] = text;
            }
        }

        private static void ReportCaptureError(Action<SdkException>? onError, SdkException error)
        {
            if (onError == null)
            {
                return;
            }

            try
            {
                onError(error);
            }
            catch
            {
                // Preserve the app-owned Activity flow even if diagnostics handling fails.
            }
        }

        private readonly struct CapturedActivityContext
        {
            internal CapturedActivityContext(string traceId, string spanId, string? parentSpanId, string traceFlags)
            {
                TraceId = traceId;
                SpanId = spanId;
                ParentSpanId = parentSpanId;
                TraceFlags = traceFlags;
                Sampled = (Convert.ToInt32(traceFlags, 16) & 1) == 1;
            }

            internal string TraceId { get; }

            internal string SpanId { get; }

            internal string? ParentSpanId { get; }

            internal string TraceFlags { get; }

            internal bool Sampled { get; }
        }
    }
}
