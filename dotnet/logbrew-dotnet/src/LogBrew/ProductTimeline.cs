using System;
using System.Collections.Generic;

namespace LogBrew
{
    public static class ProductTimeline
    {
        public static ProductActionBuilder ProductAction(string name)
        {
            return new ProductActionBuilder(name);
        }

        public static NetworkMilestoneBuilder NetworkMilestone(string routeTemplate)
        {
            return new NetworkMilestoneBuilder(routeTemplate);
        }
    }

    public sealed class ProductActionBuilder
    {
        private readonly string name;
        private string status = "success";
        private string? routeTemplate;
        private string? sessionId;
        private string? traceId;
        private string? screen;
        private string? funnel;
        private string? step;
        private Dictionary<string, object?> metadata = new Dictionary<string, object?>();

        internal ProductActionBuilder(string name)
        {
            this.name = name;
        }

        public ProductActionBuilder WithStatus(string value)
        {
            status = value;
            return this;
        }

        public ProductActionBuilder WithRouteTemplate(string value)
        {
            routeTemplate = TimelineMetadata.SanitizeRouteTemplate("product routeTemplate", value);
            return this;
        }

        public ProductActionBuilder WithSessionId(string value)
        {
            sessionId = TimelineMetadata.RequirePrimitiveLabel("sessionId", value);
            return this;
        }

        public ProductActionBuilder WithTraceId(string value)
        {
            traceId = TimelineMetadata.RequirePrimitiveLabel("traceId", value);
            return this;
        }

        public ProductActionBuilder WithScreen(string value)
        {
            screen = TimelineMetadata.RequirePrimitiveLabel("screen", value);
            return this;
        }

        public ProductActionBuilder WithFunnel(string value)
        {
            funnel = TimelineMetadata.RequirePrimitiveLabel("funnel", value);
            return this;
        }

        public ProductActionBuilder WithStep(string value)
        {
            step = TimelineMetadata.RequirePrimitiveLabel("step", value);
            return this;
        }

        public ProductActionBuilder WithMetadata(IDictionary<string, object?> value)
        {
            metadata = TimelineMetadata.CopyMetadata(value);
            return this;
        }

        public ActionAttributes ToActionAttributes()
        {
            var actionMetadata = TimelineMetadata.CreateMetadata("product_timeline", metadata);
            TimelineMetadata.AddIfNotNull(actionMetadata, "routeTemplate", routeTemplate);
            TimelineMetadata.AddIfNotNull(actionMetadata, "sessionId", sessionId);
            TimelineMetadata.AddIfNotNull(actionMetadata, "traceId", traceId);
            TimelineMetadata.AddIfNotNull(actionMetadata, "screen", screen);
            TimelineMetadata.AddIfNotNull(actionMetadata, "funnel", funnel);
            TimelineMetadata.AddIfNotNull(actionMetadata, "step", step);
            return ActionAttributes.Create(name, status).WithMetadata(actionMetadata);
        }
    }

    public sealed class NetworkMilestoneBuilder
    {
        private readonly string routeTemplate;
        private string? name;
        private string method = "GET";
        private string? status;
        private int? statusCode;
        private double? durationMs;
        private string? sessionId;
        private string? traceId;
        private Dictionary<string, object?> metadata = new Dictionary<string, object?>();

        internal NetworkMilestoneBuilder(string routeTemplate)
        {
            this.routeTemplate = TimelineMetadata.SanitizeRouteTemplate("network milestone routeTemplate", routeTemplate);
        }

        public NetworkMilestoneBuilder WithName(string value)
        {
            name = value;
            return this;
        }

        public NetworkMilestoneBuilder WithMethod(string value)
        {
            method = TimelineMetadata.NormalizeHttpMethod(value);
            return this;
        }

        public NetworkMilestoneBuilder WithStatus(string value)
        {
            status = value;
            return this;
        }

        public NetworkMilestoneBuilder WithStatusCode(int value)
        {
            statusCode = value;
            return this;
        }

        public NetworkMilestoneBuilder WithDurationMs(double value)
        {
            durationMs = value;
            return this;
        }

        public NetworkMilestoneBuilder WithSessionId(string value)
        {
            sessionId = TimelineMetadata.RequirePrimitiveLabel("sessionId", value);
            return this;
        }

        public NetworkMilestoneBuilder WithTraceId(string value)
        {
            traceId = TimelineMetadata.RequirePrimitiveLabel("traceId", value);
            return this;
        }

        public NetworkMilestoneBuilder WithMetadata(IDictionary<string, object?> value)
        {
            metadata = TimelineMetadata.CopyMetadata(value);
            return this;
        }

        public ActionAttributes ToActionAttributes()
        {
            TimelineMetadata.ValidateStatusCode(statusCode);
            TimelineMetadata.ValidateDurationMs(durationMs);
            var normalizedStatus = status ?? (statusCode.HasValue && statusCode.Value >= 400 ? "failure" : "success");
            var actionName = name ?? ("network." + TimelineMetadata.ToLowerAscii(method) + " " + routeTemplate);
            var actionMetadata = TimelineMetadata.CreateMetadata("network_timeline", metadata);
            actionMetadata["routeTemplate"] = routeTemplate;
            actionMetadata["method"] = method;
            TimelineMetadata.AddIfNotNull(actionMetadata, "statusCode", statusCode);
            TimelineMetadata.AddIfNotNull(actionMetadata, "durationMs", durationMs);
            TimelineMetadata.AddIfNotNull(actionMetadata, "sessionId", sessionId);
            TimelineMetadata.AddIfNotNull(actionMetadata, "traceId", traceId);
            return ActionAttributes.Create(actionName, normalizedStatus).WithMetadata(actionMetadata);
        }
    }

    internal static class TimelineMetadata
    {
        internal static Dictionary<string, object?> CopyMetadata(IDictionary<string, object?>? source)
        {
            var copied = Validation.CopyMetadata(source);
            var metadata = new Dictionary<string, object?>();
            if (copied == null)
            {
                return metadata;
            }

            foreach (var item in copied.Values)
            {
                metadata[item.Key] = item.Value;
            }

            return metadata;
        }

        internal static Dictionary<string, object?> CreateMetadata(string source, IReadOnlyDictionary<string, object?> appMetadata)
        {
            var metadata = new Dictionary<string, object?> { ["source"] = source };
            foreach (var item in appMetadata)
            {
                if (!string.Equals(item.Key, "source", StringComparison.Ordinal))
                {
                    metadata[item.Key] = item.Value;
                }
            }

            return metadata;
        }

        internal static void AddIfNotNull(Dictionary<string, object?> metadata, string key, object? value)
        {
            if (value != null)
            {
                metadata[key] = value;
            }
        }

        internal static string RequirePrimitiveLabel(string label, string value)
        {
            Validation.RequireNonEmpty(label, value);
            return value.Trim();
        }

        internal static string SanitizeRouteTemplate(string label, string routeTemplate)
        {
            Validation.RequireNonEmpty(label, routeTemplate);
            var trimmed = routeTemplate.Trim();
            if (Uri.TryCreate(trimmed, UriKind.Absolute, out var uri) && !string.IsNullOrEmpty(uri.Host))
            {
                return string.IsNullOrEmpty(uri.AbsolutePath) ? "/" : uri.AbsolutePath;
            }

            var queryIndex = trimmed.IndexOf('?');
            var fragmentIndex = trimmed.IndexOf('#');
            var cutoff = FirstPresentIndex(queryIndex, fragmentIndex);
            if (cutoff >= 0)
            {
                trimmed = trimmed.Substring(0, cutoff).TrimEnd();
            }

            return trimmed.Length == 0 ? "/" : trimmed;
        }

        internal static string NormalizeHttpMethod(string method)
        {
            if (string.IsNullOrWhiteSpace(method))
            {
                throw InvalidMethod();
            }

            var normalized = method.Trim().ToUpperInvariant();
            foreach (var character in normalized)
            {
                if (!IsMethodCharacter(character))
                {
                    throw InvalidMethod();
                }
            }

            return normalized;
        }

        internal static void ValidateStatusCode(int? statusCode)
        {
            if (statusCode.HasValue && (statusCode.Value < 100 || statusCode.Value > 599))
            {
                throw new SdkException("validation_error", "network milestone statusCode must be between 100 and 599");
            }
        }

        internal static void ValidateDurationMs(double? durationMs)
        {
            if (!durationMs.HasValue)
            {
                return;
            }

            Validation.RequireFiniteNumber("network milestone durationMs", durationMs.Value);
            if (durationMs.Value < 0)
            {
                throw new SdkException("validation_error", "network milestone durationMs must be non-negative");
            }
        }

        internal static string ToLowerAscii(string value)
        {
            var characters = value.ToCharArray();
            for (var index = 0; index < characters.Length; index++)
            {
                if (characters[index] >= 'A' && characters[index] <= 'Z')
                {
                    characters[index] = (char)(characters[index] + ('a' - 'A'));
                }
            }

            return new string(characters);
        }

        private static int FirstPresentIndex(int first, int second)
        {
            if (first < 0)
            {
                return second;
            }

            if (second < 0)
            {
                return first;
            }

            return Math.Min(first, second);
        }

        private static bool IsMethodCharacter(char character)
        {
            return (character >= 'A' && character <= 'Z')
                || (character >= '0' && character <= '9')
                || character == '-'
                || character == '_';
        }

        private static SdkException InvalidMethod()
        {
            return new SdkException("validation_error", "network milestone method must be a valid HTTP method");
        }
    }
}
