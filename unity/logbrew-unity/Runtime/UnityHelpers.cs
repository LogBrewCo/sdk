#nullable enable

using System;
using System.Collections.Generic;

namespace LogBrew.Unity
{
    public static partial class LogBrewUnity
    {
        public const string SdkVersion = "0.2.1";

        public static LogBrewClient CreateClient(
            string apiKey,
            string gameName,
            int maxRetries = 2,
            TelemetryContext? context = null,
            bool includeAutomaticContext = true)
        {
            Validation.RequireNonEmpty("game_name", gameName);
            var unityContext = UnityRuntimeContext.Create(gameName, includeAutomaticContext);
            return LogBrewClient.Create(
                apiKey,
                "logbrew-unity",
                SdkVersion,
                maxRetries,
                TelemetryContext.Merge(unityContext, context),
                includeAutomaticContext);
        }

        public static void CaptureSceneLoaded(
            LogBrewClient client,
            string id,
            string timestamp,
            string sceneName,
            int buildIndex = -1,
            UnityContext? context = null)
        {
            if (client == null)
            {
                throw new ArgumentNullException(nameof(client));
            }

            Validation.RequireNonEmpty("unity sceneName", sceneName);
            var metadata = MetadataFromContext(context);
            metadata["sceneName"] = sceneName;
            if (buildIndex >= 0)
            {
                metadata["buildIndex"] = buildIndex;
            }

            var attributes = ActionAttributes.Create("scene_loaded", "success").WithMetadata(metadata);
            AddContext(attributes, context);
            client.Action(id, timestamp, attributes);
        }

        public static void CaptureLogMessage(
            LogBrewClient client,
            string id,
            string timestamp,
            string message,
            string unityLogType,
            UnityContext? context = null)
        {
            if (client == null)
            {
                throw new ArgumentNullException(nameof(client));
            }

            Validation.RequireNonEmpty("unity logType", unityLogType);
            var metadata = MetadataFromContext(context);
            metadata["unityLogType"] = unityLogType;
            var attributes = LogAttributes.Create(message, MapLogLevel(unityLogType)).WithLogger("unity").WithMetadata(metadata);
            AddContext(attributes, context);
            client.Log(id, timestamp, attributes);
        }

        public static void CaptureException(
            LogBrewClient client,
            string id,
            string timestamp,
            string title,
            string stackTrace,
            UnityContext? context = null)
        {
            if (client == null)
            {
                throw new ArgumentNullException(nameof(client));
            }

            var metadata = MetadataFromContext(context);
            metadata["source"] = "unity";
            var attributes = IssueAttributes.Create(title, "error")
                .WithException(
                    IssueExceptionInfo.Create(IssueDiagnostics.UnityExceptionType(title))
                        .WithMechanism(IssueExceptionMechanism.Create("unity.log_callback", true)))
                .WithMetadata(metadata);
            var frames = IssueDiagnostics.StackFramesFromUnityStackTrace(stackTrace);
            if (frames.Count > 0)
            {
                attributes.WithStackFrames(frames);
            }

            AddContext(attributes, context);
            client.Issue(id, timestamp, attributes);
        }

        public static void CaptureException(
            LogBrewClient client,
            string id,
            string timestamp,
            Exception error,
            bool handled = true,
            UnityContext? context = null)
        {
            if (client == null)
            {
                throw new ArgumentNullException(nameof(client));
            }

            if (error == null)
            {
                throw new ArgumentNullException(nameof(error));
            }

            var attributes = IssueAttributes.FromException(error, "unity.exception", handled)
                .WithMetadata(MetadataFromContext(context));
            AddContext(attributes, context);
            client.Issue(id, timestamp, attributes);
        }

        public static void CaptureFrameSpan(
            LogBrewClient client,
            string id,
            string timestamp,
            string name,
            string traceId,
            string spanId,
            double durationMs,
            UnityContext? context = null)
        {
            if (client == null)
            {
                throw new ArgumentNullException(nameof(client));
            }

            var attributes = SpanAttributes.Create(name, traceId, spanId, "ok")
                .WithDurationMs(durationMs)
                .WithMetadata(MetadataFromContext(context));
            AddContext(attributes, context);
            client.Span(id, timestamp, attributes);
        }

        public static void CaptureLifecycleSpan(
            LogBrewClient client,
            string id,
            string timestamp,
            string previousState,
            string currentState,
            double durationMs,
            UnityContext? context = null)
        {
            if (client == null)
            {
                throw new ArgumentNullException(nameof(client));
            }

            CaptureLifecycleSpanWithMetadata(
                client,
                id,
                timestamp,
                previousState,
                currentState,
                durationMs,
                MetadataFromContext(context),
                context?.ToTelemetryContext());
        }

        internal static void CaptureLifecycleSpanWithMetadata(
            LogBrewClient client,
            string id,
            string timestamp,
            string previousState,
            string currentState,
            double durationMs,
            IDictionary<string, object?> metadata,
            TelemetryContext? context = null)
        {
            Validation.RequireNonEmpty("unity previousState", previousState);
            Validation.RequireNonEmpty("unity currentState", currentState);
            metadata["previousState"] = previousState;
            metadata["currentState"] = currentState;
            metadata["durationSource"] = "previous_state";
            var attributes = LogBrewTrace.SpanAttributes(
                "unity.lifecycle:" + previousState + "->" + currentState,
                "ok",
                durationMs,
                metadata);
            if (context != null)
            {
                attributes.WithContext(context);
            }

            client.Span(id, timestamp, attributes);
        }

        internal static Dictionary<string, object?> MetadataFromContext(UnityContext? context)
        {
            return context == null
                ? new Dictionary<string, object?>()
                : new Dictionary<string, object?>(context.ToMetadata());
        }

        private static void AddContext(ActionAttributes attributes, UnityContext? context)
        {
            var value = context?.ToTelemetryContext();
            if (value != null)
            {
                attributes.WithContext(value);
            }
        }

        private static void AddContext(LogAttributes attributes, UnityContext? context)
        {
            var value = context?.ToTelemetryContext();
            if (value != null)
            {
                attributes.WithContext(value);
            }
        }

        private static void AddContext(IssueAttributes attributes, UnityContext? context)
        {
            var value = context?.ToTelemetryContext();
            if (value != null)
            {
                attributes.WithContext(value);
            }
        }

        private static void AddContext(SpanAttributes attributes, UnityContext? context)
        {
            var value = context?.ToTelemetryContext();
            if (value != null)
            {
                attributes.WithContext(value);
            }
        }

        private static string MapLogLevel(string unityLogType)
        {
            switch (unityLogType)
            {
                case "Log":
                    return "info";
                case "Warning":
                    return "warning";
                case "Assert":
                case "Error":
                case "Exception":
                    return "error";
                default:
                    return "debug";
            }
        }
    }
}
