using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

namespace LogBrew
{
    /// <summary>
    /// Immutable schema-v1 resource, correlation, session, subject, and tag context shared by every signal.
    /// </summary>
    public sealed class TelemetryContext
    {
        private readonly TelemetryResource? resource;
        private readonly TraceValue? trace;
        private readonly SessionValue? session;
        private readonly SubjectValue? subject;
        private readonly Dictionary<string, string>? tags;

        private TelemetryContext(
            TelemetryResource? resource,
            TraceValue? trace,
            SessionValue? session,
            SubjectValue? subject,
            IDictionary<string, string>? tags)
        {
            this.resource = resource;
            this.trace = trace;
            this.session = session;
            this.subject = subject;
            this.tags = tags == null ? null : new Dictionary<string, string>(tags, StringComparer.Ordinal);
        }

        /// <summary>The current shared-context schema version.</summary>
        public const int SchemaVersion = 1;

        /// <summary>Creates a builder for one bounded shared context.</summary>
        public static Builder Create()
        {
            return new Builder();
        }

        /// <summary>
        /// Merges client context with an event override. Resource fields and tags merge by field;
        /// event trace, session, and subject sections replace the matching client section.
        /// </summary>
        public static TelemetryContext? Merge(TelemetryContext? clientContext, TelemetryContext? eventContext)
        {
            if (clientContext == null)
            {
                return eventContext;
            }

            if (eventContext == null)
            {
                return clientContext;
            }

            var mergedTags = MergeTags(clientContext.tags, eventContext.tags);
            return new TelemetryContext(
                TelemetryResource.Merge(clientContext.resource, eventContext.resource),
                eventContext.trace ?? clientContext.trace,
                eventContext.session ?? clientContext.session,
                eventContext.subject ?? clientContext.subject,
                mergedTags);
        }

        internal static TelemetryContext WithTrace(TelemetryContext? context, LogBrewTraceContext traceContext)
        {
            ExceptionContract.ThrowIfNull(traceContext, nameof(traceContext));
            return Merge(context, Create().WithTrace(traceContext).Build())!;
        }

        internal static TelemetryContext RuntimeDefaults()
        {
            var resource = TelemetryResource.Create()
                .WithRuntime("dotnet", Environment.Version.ToString())
                .WithOperatingSystem(OperatingSystemFamily())
                .WithDevice(architecture: RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant())
                .Build();
            return Create().WithResource(resource).Build();
        }

        internal OrderedJsonObject ToJsonObject()
        {
            var result = new OrderedJsonObject().Add("schemaVersion", SchemaVersion);
            result.AddIfNotNull("resource", resource?.ToJsonObject());
            result.AddIfNotNull("trace", trace?.ToJsonObject());
            result.AddIfNotNull("session", session?.ToJsonObject());
            result.AddIfNotNull("subject", subject?.ToJsonObject());
            if (tags != null)
            {
                var tagValues = new OrderedJsonObject();
                foreach (var tag in tags)
                {
                    tagValues.Add(tag.Key, tag.Value);
                }

                result.Add("tags", tagValues);
            }

            return result;
        }

        private static Dictionary<string, string>? MergeTags(
            IDictionary<string, string>? clientTags,
            IDictionary<string, string>? eventTags)
        {
            if (clientTags == null && eventTags == null)
            {
                return null;
            }

            var merged = new Dictionary<string, string>(StringComparer.Ordinal);
            if (clientTags != null)
            {
                foreach (var tag in clientTags)
                {
                    merged[tag.Key] = tag.Value;
                }
            }

            if (eventTags != null)
            {
                foreach (var tag in eventTags)
                {
                    merged[tag.Key] = tag.Value;
                }
            }

            TelemetryContextValue.RequireTagCount(merged.Count);
            return SortTags(merged);
        }

        private static Dictionary<string, string> SortTags(IDictionary<string, string> source)
        {
            var keys = new List<string>(source.Keys);
            keys.Sort(StringComparer.Ordinal);
            var sorted = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var key in keys)
            {
                sorted[key] = source[key];
            }

            return sorted;
        }

        private static string OperatingSystemFamily()
        {
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                return "windows";
            }

            if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
            {
                return "macos";
            }

            if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
            {
                return "linux";
            }

            return "unknown";
        }

        /// <summary>Builds a non-empty immutable telemetry context.</summary>
        public sealed class Builder
        {
            private TelemetryResource? resource;
            private TraceValue? trace;
            private SessionValue? session;
            private SubjectValue? subject;
            private readonly Dictionary<string, string> tags = new Dictionary<string, string>(StringComparer.Ordinal);

            internal Builder()
            {
            }

            /// <summary>Sets stable resource identity.</summary>
            public Builder WithResource(TelemetryResource value)
            {
                ExceptionContract.ThrowIfNull(value, nameof(value));
                resource = value;
                return this;
            }

            /// <summary>Sets exact W3C trace correlation from an active LogBrew trace.</summary>
            public Builder WithTrace(LogBrewTraceContext value)
            {
                ExceptionContract.ThrowIfNull(value, nameof(value));
                return WithTrace(value.TraceId, value.SpanId, value.ParentSpanId, value.Sampled);
            }

            /// <summary>Sets exact W3C trace and optional span correlation.</summary>
            public Builder WithTrace(
                string traceId,
                string? spanId = null,
                string? parentSpanId = null,
                bool? sampled = null)
            {
                trace = new TraceValue(
                    TelemetryContextValue.HexId(traceId, 32, "traceId"),
                    TelemetryContextValue.OptionalHexId(spanId, 16, "spanId"),
                    TelemetryContextValue.OptionalHexId(parentSpanId, 16, "parentSpanId"),
                    sampled);
                return this;
            }

            /// <summary>Sets opaque current and optional previous session identities.</summary>
            public Builder WithSession(string id, string? previousId = null)
            {
                var normalizedId = TelemetryContextValue.Id(id, "session id");
                var normalizedPreviousId = TelemetryContextValue.OptionalId(previousId, "session previousId");
                if (string.Equals(normalizedId, normalizedPreviousId, StringComparison.Ordinal))
                {
                    throw TelemetryContextValue.Invalid("session previousId must differ from id");
                }

                session = new SessionValue(normalizedId, normalizedPreviousId);
                return this;
            }

            /// <summary>Sets an opaque user or anonymous subject identity.</summary>
            public Builder WithSubject(string id, string kind)
            {
                var normalizedId = TelemetryContextValue.Id(id, "subject id");
                if (!string.Equals(kind, "anonymous", StringComparison.Ordinal)
                    && !string.Equals(kind, "user", StringComparison.Ordinal))
                {
                    throw TelemetryContextValue.Invalid("subject kind must be anonymous or user");
                }

                subject = new SubjectValue(normalizedId, kind);
                return this;
            }

            /// <summary>Adds or replaces one low-cardinality tag.</summary>
            public Builder WithTag(string key, string value)
            {
                var normalizedKey = TelemetryContextValue.TagKey(key);
                tags[normalizedKey] = TelemetryContextValue.RequiredString(value, "tag value for " + normalizedKey);
                return this;
            }

            /// <summary>Adds or replaces low-cardinality tags from a caller-owned map.</summary>
            public Builder WithTags(IDictionary<string, string> values)
            {
                ExceptionContract.ThrowIfNull(values, nameof(values));
                foreach (var value in values)
                {
                    WithTag(value.Key, value.Value);
                }

                return this;
            }

            /// <summary>Builds one non-empty immutable shared context.</summary>
            public TelemetryContext Build()
            {
                if (resource == null && trace == null && session == null && subject == null && tags.Count == 0)
                {
                    throw TelemetryContextValue.Invalid(
                        "telemetry context must include resource, trace, session, subject, or tags");
                }

                Dictionary<string, string>? builtTags = null;
                if (tags.Count > 0)
                {
                    TelemetryContextValue.RequireTagCount(tags.Count);
                    builtTags = SortTags(tags);
                }

                return new TelemetryContext(resource, trace, session, subject, builtTags);
            }
        }

        private sealed class TraceValue
        {
            internal TraceValue(string traceId, string? spanId, string? parentSpanId, bool? sampled)
            {
                TraceId = traceId;
                SpanId = spanId;
                ParentSpanId = parentSpanId;
                Sampled = sampled;
            }

            internal string TraceId { get; }

            internal string? SpanId { get; }

            internal string? ParentSpanId { get; }

            internal bool? Sampled { get; }

            internal OrderedJsonObject ToJsonObject()
            {
                var result = new OrderedJsonObject().Add("traceId", TraceId);
                result.AddIfNotNull("spanId", SpanId);
                result.AddIfNotNull("parentSpanId", ParentSpanId);
                if (Sampled.HasValue)
                {
                    result.Add("sampled", Sampled.Value);
                }

                return result;
            }
        }

        private sealed class SessionValue
        {
            internal SessionValue(string id, string? previousId)
            {
                Id = id;
                PreviousId = previousId;
            }

            internal string Id { get; }

            internal string? PreviousId { get; }

            internal OrderedJsonObject ToJsonObject()
            {
                var result = new OrderedJsonObject().Add("id", Id);
                result.AddIfNotNull("previousId", PreviousId);
                return result;
            }
        }

        private sealed class SubjectValue
        {
            internal SubjectValue(string id, string kind)
            {
                Id = id;
                Kind = kind;
            }

            internal string Id { get; }

            internal string Kind { get; }

            internal OrderedJsonObject ToJsonObject()
            {
                return new OrderedJsonObject().Add("id", Id).Add("kind", Kind);
            }
        }
    }

    /// <summary>Owns explicit async-local shared telemetry context scopes.</summary>
    public static class LogBrewTelemetry
    {
        private static readonly AsyncLocal<TelemetryContext?> ActiveContext = new AsyncLocal<TelemetryContext?>();

        /// <summary>Gets the active immutable context for the current asynchronous flow.</summary>
        public static TelemetryContext? CurrentContext
        {
            get { return ActiveContext.Value; }
        }

        /// <summary>
        /// Activates context for the current asynchronous flow. Nested context merges over the
        /// prior scope and disposal reinstates the exact prior value.
        /// </summary>
        public static IDisposable ActivateContext(TelemetryContext context)
        {
            ExceptionContract.ThrowIfNull(context, nameof(context));
            var previous = ActiveContext.Value;
            ActiveContext.Value = TelemetryContext.Merge(previous, context);
            return new ContextScope(previous);
        }

        private sealed class ContextScope : IDisposable
        {
            private readonly TelemetryContext? previous;
            private bool disposed;

            internal ContextScope(TelemetryContext? previous)
            {
                this.previous = previous;
            }

            public void Dispose()
            {
                if (disposed)
                {
                    return;
                }

                ActiveContext.Value = previous;
                disposed = true;
            }
        }
    }

    internal static class TelemetryContextValue
    {
        private const int MaxIdLength = 200;
        private const int MaxStringLength = 256;
        private const int MaxTagKeyLength = 64;
        private const int MaxTags = 32;

        internal static string RequiredString(string value, string label)
        {
            return BoundedString(value, label, MaxStringLength);
        }

        internal static string? OptionalString(string? value, string label)
        {
            return value == null ? null : BoundedString(value, label, MaxStringLength);
        }

        internal static string Id(string value, string label)
        {
            return BoundedString(value, label, MaxIdLength);
        }

        internal static string? OptionalId(string? value, string label)
        {
            return value == null ? null : BoundedString(value, label, MaxIdLength);
        }

        internal static string HexId(string value, int width, string label)
        {
            if (value == null)
            {
                throw Invalid(label + " must be " + width.ToString(CultureInfo.InvariantCulture) + " non-zero hex characters");
            }

            var normalized = value.Trim().ToLowerInvariant();
            if (normalized.Length != width || IsAllZero(normalized))
            {
                throw Invalid(label + " must be " + width.ToString(CultureInfo.InvariantCulture) + " non-zero hex characters");
            }

            foreach (var character in normalized)
            {
                if (!IsLowerHex(character))
                {
                    throw Invalid(label + " must be " + width.ToString(CultureInfo.InvariantCulture) + " non-zero hex characters");
                }
            }

            return normalized;
        }

        internal static string? OptionalHexId(string? value, int width, string label)
        {
            return value == null ? null : HexId(value, width, label);
        }

        internal static string TagKey(string value)
        {
            if (string.IsNullOrEmpty(value)
                || value.Length > MaxTagKeyLength
                || !IsAsciiLetter(value[0]))
            {
                throw Invalid("tag key is invalid");
            }

            for (var index = 1; index < value.Length; index++)
            {
                var character = value[index];
                if (!IsAsciiLetter(character)
                    && (character < '0' || character > '9')
                    && character != '_'
                    && character != '.'
                    && character != '-')
                {
                    throw Invalid("tag key is invalid");
                }
            }

            return value;
        }

        internal static void RequireTagCount(int count)
        {
            if (count < 1 || count > MaxTags)
            {
                throw Invalid("tags must contain 1-32 entries");
            }
        }

        internal static SdkException Invalid(string message)
        {
            return new SdkException("validation_error", message);
        }

        private static string BoundedString(string value, string label, int maxCodePoints)
        {
            if (value == null)
            {
                throw Invalid(label + " is invalid");
            }

            var normalized = value.Trim();
            if (normalized.Length == 0 || !HasValidCodePoints(normalized, maxCodePoints))
            {
                throw Invalid(label + " is invalid");
            }

            return normalized;
        }

        private static bool HasValidCodePoints(string value, int maxCodePoints)
        {
            var count = 0;
            for (var index = 0; index < value.Length; index++)
            {
                var character = value[index];
                int codePoint;
                if (char.IsHighSurrogate(character))
                {
                    if (index + 1 >= value.Length || !char.IsLowSurrogate(value[index + 1]))
                    {
                        return false;
                    }

                    codePoint = char.ConvertToUtf32(character, value[++index]);
                }
                else if (char.IsLowSurrogate(character))
                {
                    return false;
                }
                else
                {
                    codePoint = character;
                }

                if (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159) || ++count > maxCodePoints)
                {
                    return false;
                }
            }

            return true;
        }

        private static bool IsAllZero(string value)
        {
            foreach (var character in value)
            {
                if (character != '0')
                {
                    return false;
                }
            }

            return true;
        }

        private static bool IsLowerHex(char value)
        {
            return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f');
        }

        private static bool IsAsciiLetter(char value)
        {
            return (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z');
        }
    }
}
