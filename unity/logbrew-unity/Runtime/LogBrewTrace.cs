#nullable enable

using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Threading;

namespace LogBrew.Unity
{
    public sealed class LogBrewTraceContext
    {
        private const string ZeroTraceId = "00000000000000000000000000000000";
        private const string ZeroSpanId = "0000000000000000";
        private static readonly char[] LowerHex = "0123456789abcdef".ToCharArray();

        private LogBrewTraceContext(string traceId, string spanId, string? parentSpanId, string traceFlags)
        {
            TraceId = NormalizeTraceId(traceId);
            SpanId = NormalizeSpanId("spanId", spanId);
            ParentSpanId = parentSpanId == null ? null : NormalizeSpanId("parentSpanId", parentSpanId);
            TraceFlags = NormalizeTraceFlags(traceFlags);
            Sampled = (Convert.ToInt32(TraceFlags, 16) & 1) == 1;
        }

        public string TraceId { get; }

        public string SpanId { get; }

        public string? ParentSpanId { get; }

        public string TraceFlags { get; }

        public bool Sampled { get; }

        public string Traceparent
        {
            get { return CreateTraceparent(TraceId, SpanId, TraceFlags); }
        }

        public IReadOnlyDictionary<string, string> Headers
        {
            get { return new Dictionary<string, string> { ["traceparent"] = Traceparent }; }
        }

        public static LogBrewTraceContext CreateRoot()
        {
            return new LogBrewTraceContext(GenerateTraceId(), GenerateSpanId(), null, "01");
        }

        public static LogBrewTraceContext CreateRoot(string traceFlags)
        {
            return new LogBrewTraceContext(GenerateTraceId(), GenerateSpanId(), null, traceFlags);
        }

        public static LogBrewTraceContext CreateChild(LogBrewTraceContext parent)
        {
            if (parent == null)
            {
                throw new ArgumentNullException(nameof(parent));
            }

            return new LogBrewTraceContext(parent.TraceId, GenerateSpanId(), parent.SpanId, parent.TraceFlags);
        }

        public static LogBrewTraceContext FromTraceparent(string traceparent)
        {
            if (traceparent == null)
            {
                throw new ArgumentNullException(nameof(traceparent));
            }

            var parsed = ParseTraceparent(traceparent);
            return new LogBrewTraceContext(parsed.TraceId, GenerateSpanId(), parsed.ParentSpanId, parsed.TraceFlags);
        }

        public static LogBrewTraceContext FromTraceparent(string traceparent, string spanId)
        {
            if (traceparent == null)
            {
                throw new ArgumentNullException(nameof(traceparent));
            }

            var parsed = ParseTraceparent(traceparent);
            return new LogBrewTraceContext(parsed.TraceId, spanId, parsed.ParentSpanId, parsed.TraceFlags);
        }

        public static LogBrewTraceContext ContinueOrCreate(string? traceparent)
        {
            return TryFromTraceparent(traceparent, out var context) && context != null ? context : CreateRoot();
        }

        public static bool TryFromTraceparent(string? traceparent, out LogBrewTraceContext? context)
        {
            context = null;
            if (string.IsNullOrWhiteSpace(traceparent))
            {
                return false;
            }

            try
            {
                context = FromTraceparent(traceparent!);
                return true;
            }
            catch (SdkException)
            {
                return false;
            }
        }

        public IReadOnlyDictionary<string, object?> ToMetadata()
        {
            var metadata = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["traceId"] = TraceId,
                ["spanId"] = SpanId,
                ["traceFlags"] = TraceFlags,
                ["traceSampled"] = Sampled
            };
            if (ParentSpanId != null)
            {
                metadata["parentSpanId"] = ParentSpanId;
            }

            return metadata;
        }

        private static ParsedTraceparent ParseTraceparent(string traceparent)
        {
            Validation.RequireNonEmpty("traceparent", traceparent);
            var normalized = ToLowerAscii(traceparent.Trim());
            if (normalized.Length != 55 || normalized[2] != '-' || normalized[35] != '-' || normalized[52] != '-')
            {
                throw TraceparentShapeError();
            }

            var version = normalized.Substring(0, 2);
            var traceId = normalized.Substring(3, 32);
            var parentSpanId = normalized.Substring(36, 16);
            var traceFlags = normalized.Substring(53, 2);
            if (version != "00" || !IsLowerHex(traceId) || !IsLowerHex(parentSpanId) || !IsLowerHex(traceFlags))
            {
                throw TraceparentShapeError();
            }

            RequireTraceId(traceId);
            RequireSpanId("traceparent parent span id", parentSpanId);
            RequireTraceFlags(traceFlags);
            return new ParsedTraceparent(traceId, parentSpanId, traceFlags);
        }

        private static string CreateTraceparent(string traceId, string spanId, string traceFlags)
        {
            var normalizedTraceId = NormalizeTraceId(traceId);
            var normalizedSpanId = NormalizeSpanId("spanId", spanId);
            var normalizedTraceFlags = NormalizeTraceFlags(traceFlags);
            return "00-" + normalizedTraceId + "-" + normalizedSpanId + "-" + normalizedTraceFlags;
        }

        private static string GenerateTraceId()
        {
            return GenerateNonZeroHex(16, ZeroTraceId);
        }

        private static string GenerateSpanId()
        {
            return GenerateNonZeroHex(8, ZeroSpanId);
        }

        private static string GenerateNonZeroHex(int byteCount, string zeroValue)
        {
            var bytes = new byte[byteCount];
            string value;
            using (var random = RandomNumberGenerator.Create())
            {
                do
                {
                    random.GetBytes(bytes);
                    value = ToLowerHex(bytes);
                }
                while (string.Equals(value, zeroValue, StringComparison.Ordinal));
            }

            return value;
        }

        private static string ToLowerHex(byte[] bytes)
        {
            var chars = new char[bytes.Length * 2];
            for (var index = 0; index < bytes.Length; index++)
            {
                var value = bytes[index];
                chars[index * 2] = LowerHex[value >> 4];
                chars[(index * 2) + 1] = LowerHex[value & 0x0f];
            }

            return new string(chars);
        }

        private static string NormalizeTraceId(string traceId)
        {
            Validation.RequireNonEmpty("traceId", traceId);
            var normalized = ToLowerAscii(traceId.Trim());
            RequireTraceId(normalized);
            return normalized;
        }

        private static string NormalizeSpanId(string label, string spanId)
        {
            Validation.RequireNonEmpty(label, spanId);
            var normalized = ToLowerAscii(spanId.Trim());
            RequireSpanId(label, normalized);
            return normalized;
        }

        private static string NormalizeTraceFlags(string traceFlags)
        {
            var normalized = string.IsNullOrWhiteSpace(traceFlags) ? "01" : ToLowerAscii(traceFlags.Trim());
            RequireTraceFlags(normalized);
            return normalized;
        }

        private static string ToLowerAscii(string value)
        {
            var chars = value.ToCharArray();
            for (var index = 0; index < chars.Length; index++)
            {
                var character = chars[index];
                if (character >= 'A' && character <= 'F')
                {
                    chars[index] = (char)(character + ('a' - 'A'));
                }
            }

            return new string(chars);
        }

        private static void RequireTraceId(string traceId)
        {
            if (traceId.Length != 32 || !IsLowerHex(traceId) || string.Equals(traceId, ZeroTraceId, StringComparison.Ordinal))
            {
                throw new SdkException("validation_error", "traceId must be 32 lowercase hex characters and non-zero");
            }
        }

        private static void RequireSpanId(string label, string spanId)
        {
            if (spanId.Length != 16 || !IsLowerHex(spanId) || string.Equals(spanId, ZeroSpanId, StringComparison.Ordinal))
            {
                throw new SdkException("validation_error", label + " must be 16 lowercase hex characters and non-zero");
            }
        }

        private static void RequireTraceFlags(string traceFlags)
        {
            if (traceFlags.Length != 2 || !IsLowerHex(traceFlags))
            {
                throw new SdkException("validation_error", "traceFlags must be two lowercase hex characters");
            }
        }

        private static bool IsLowerHex(string value)
        {
            foreach (var character in value)
            {
                if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')))
                {
                    return false;
                }
            }

            return true;
        }

        private static SdkException TraceparentShapeError()
        {
            return new SdkException("validation_error", "traceparent must match W3C version-traceid-parentid-flags shape");
        }

        private sealed class ParsedTraceparent
        {
            internal ParsedTraceparent(string traceId, string parentSpanId, string traceFlags)
            {
                TraceId = traceId;
                ParentSpanId = parentSpanId;
                TraceFlags = traceFlags;
            }

            internal string TraceId { get; }

            internal string ParentSpanId { get; }

            internal string TraceFlags { get; }
        }
    }

    public static class LogBrewTrace
    {
        private static readonly HashSet<string> TraceMetadataKeys = new HashSet<string>(StringComparer.Ordinal)
        {
            "traceId",
            "spanId",
            "parentSpanId",
            "traceFlags",
            "traceSampled",
            "traceparent"
        };

        [ThreadStatic]
        private static List<TraceFrame>? activeTraceStack;

        private static long nextScopeId;

        public static LogBrewTraceContext? Current
        {
            get
            {
                var stack = activeTraceStack;
                return stack == null || stack.Count == 0 ? null : stack[stack.Count - 1].Context;
            }
        }

        public static IDisposable Activate(LogBrewTraceContext context)
        {
            if (context == null)
            {
                throw new ArgumentNullException(nameof(context));
            }

            var scopeId = Interlocked.Increment(ref nextScopeId);
            ActiveStack.Add(new TraceFrame(scopeId, context));
            return new ActiveTraceScope(scopeId);
        }

        public static IDictionary<string, object?> MetadataWithCurrentTrace(IDictionary<string, object?>? metadata)
        {
            return MetadataWithTrace(Current, metadata);
        }

        public static IDictionary<string, object?> MetadataWithTrace(LogBrewTraceContext? context, IDictionary<string, object?>? metadata)
        {
            var result = CopyMetadata(metadata);
            AddTraceMetadata(result, context);
            return result;
        }

        public static SpanAttributes SpanAttributes(
            string name,
            string status = "ok",
            double? durationMs = null,
            IDictionary<string, object?>? metadata = null,
            LogBrewTraceContext? context = null)
        {
            var trace = context ?? Current ?? LogBrewTraceContext.CreateRoot();
            var attributes = LogBrew.Unity.SpanAttributes.Create(name, trace.TraceId, trace.SpanId, status);
            if (trace.ParentSpanId != null)
            {
                attributes.WithParentSpanId(trace.ParentSpanId);
            }

            if (durationMs.HasValue)
            {
                attributes.WithDurationMs(durationMs.Value);
            }

            attributes.WithMetadata(MetadataWithTrace(trace, metadata));
            return attributes;
        }

        public static IReadOnlyDictionary<string, string> OutgoingHeaders(LogBrewTraceContext? context = null)
        {
            return (context ?? Current ?? LogBrewTraceContext.CreateRoot()).Headers;
        }

        internal static OrderedJsonObject AddActiveTraceMetadata(OrderedJsonObject attributes)
        {
            var context = Current;
            if (context == null)
            {
                return attributes;
            }

            var result = new OrderedJsonObject();
            var addedMetadata = false;
            foreach (var item in attributes.Values)
            {
                if (string.Equals(item.Key, "metadata", StringComparison.Ordinal) && item.Value is OrderedJsonObject metadata)
                {
                    result.Add("metadata", MetadataObjectWithTrace(context, metadata));
                    addedMetadata = true;
                    continue;
                }

                result.Add(item.Key, item.Value);
            }

            if (!addedMetadata)
            {
                result.Add("metadata", MetadataObjectWithTrace(context, null));
            }

            return result;
        }

        private static List<TraceFrame> ActiveStack
        {
            get
            {
                if (activeTraceStack == null)
                {
                    activeTraceStack = new List<TraceFrame>();
                }

                return activeTraceStack;
            }
        }

        private static Dictionary<string, object?> CopyMetadata(IDictionary<string, object?>? metadata)
        {
            var result = new Dictionary<string, object?>(StringComparer.Ordinal);
            if (metadata == null)
            {
                return result;
            }

            foreach (var item in metadata)
            {
                Validation.RequireNonEmpty("metadata key", item.Key);
                if (!TraceMetadataKeys.Contains(item.Key))
                {
                    result[item.Key] = Validation.RequireMetadataValue(item.Key, item.Value);
                }
            }

            return result;
        }

        private static void AddTraceMetadata(Dictionary<string, object?> metadata, LogBrewTraceContext? context)
        {
            if (context == null)
            {
                return;
            }

            metadata["traceId"] = context.TraceId;
            metadata["spanId"] = context.SpanId;
            if (context.ParentSpanId != null)
            {
                metadata["parentSpanId"] = context.ParentSpanId;
            }

            metadata["traceFlags"] = context.TraceFlags;
            metadata["traceSampled"] = context.Sampled;
        }

        private static OrderedJsonObject MetadataObjectWithTrace(LogBrewTraceContext context, OrderedJsonObject? metadata)
        {
            var result = new OrderedJsonObject();
            if (metadata != null)
            {
                foreach (var item in metadata.Values)
                {
                    if (!TraceMetadataKeys.Contains(item.Key))
                    {
                        result.Add(item.Key, item.Value);
                    }
                }
            }

            foreach (var item in context.ToMetadata())
            {
                result.Add(item.Key, item.Value);
            }

            return result;
        }

        private static void Close(long scopeId)
        {
            var stack = activeTraceStack;
            if (stack == null)
            {
                return;
            }

            var index = stack.FindLastIndex(frame => frame.Id == scopeId);
            if (index >= 0)
            {
                stack.RemoveAt(index);
            }

            if (stack.Count == 0)
            {
                activeTraceStack = null;
            }
        }

        private sealed class ActiveTraceScope : IDisposable
        {
            private readonly long scopeId;
            private bool disposed;

            internal ActiveTraceScope(long scopeId)
            {
                this.scopeId = scopeId;
            }

            public void Dispose()
            {
                if (disposed)
                {
                    return;
                }

                Close(scopeId);
                disposed = true;
            }
        }

        private sealed class TraceFrame
        {
            internal TraceFrame(long id, LogBrewTraceContext context)
            {
                Id = id;
                Context = context;
            }

            internal long Id { get; }

            internal LogBrewTraceContext Context { get; }
        }
    }
}
