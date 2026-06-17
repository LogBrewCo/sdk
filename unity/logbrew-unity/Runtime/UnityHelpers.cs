#nullable enable

using System;
using System.Collections.Generic;

namespace LogBrew.Unity
{
    public static partial class LogBrewUnity
    {
        public const string SdkVersion = "0.1.0";

        public static LogBrewClient CreateClient(string apiKey, string gameName, int maxRetries = 2)
        {
            return LogBrewClient.Create(apiKey, gameName, SdkVersion, maxRetries);
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

            client.Action(id, timestamp, ActionAttributes.Create("scene_loaded", "success").WithMetadata(metadata));
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
            client.Log(id, timestamp, LogAttributes.Create(message, MapLogLevel(unityLogType)).WithLogger("unity").WithMetadata(metadata));
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
            client.Issue(id, timestamp, IssueAttributes.Create(title, "error").WithMessage(stackTrace).WithMetadata(metadata));
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

            client.Span(
                id,
                timestamp,
                SpanAttributes.Create(name, traceId, spanId, "ok")
                    .WithDurationMs(durationMs)
                    .WithMetadata(MetadataFromContext(context)));
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

            Validation.RequireNonEmpty("unity previousState", previousState);
            Validation.RequireNonEmpty("unity currentState", currentState);
            var metadata = MetadataFromContext(context);
            metadata["previousState"] = previousState;
            metadata["currentState"] = currentState;
            metadata["durationSource"] = "previous_state";
            client.Span(
                id,
                timestamp,
                LogBrewTrace.SpanAttributes(
                    "unity.lifecycle:" + previousState + "->" + currentState,
                    "ok",
                    durationMs,
                    metadata));
        }

        internal static Dictionary<string, object?> MetadataFromContext(UnityContext? context)
        {
            return context == null
                ? new Dictionary<string, object?>()
                : new Dictionary<string, object?>(context.ToMetadata());
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
