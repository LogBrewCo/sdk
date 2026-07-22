using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;

namespace LogBrew
{
    /// <summary>
    /// Inputs for creating a local-only support-ticket draft for planned backend routes.
    /// </summary>
    public sealed class SupportTicketDraftInput
    {
        private IReadOnlyDictionary<string, object?>? diagnostics;

        private SupportTicketDraftInput(string source, string category, string title, string description)
        {
            Source = source;
            Category = category;
            Title = title;
            Description = description;
        }

        public string Source { get; }

        public string Category { get; }

        public string Title { get; }

        public string Description { get; }

        public string? ProjectId { get; private set; }

        public string? Environment { get; private set; }

        public string? Runtime { get; private set; }

        public string? Framework { get; private set; }

        public string? SdkPackage { get; private set; }

        public string? SdkVersion { get; private set; }

        public string? Release { get; private set; }

        public string? TraceId { get; private set; }

        public string? EventId { get; private set; }

        public IReadOnlyDictionary<string, object?>? Diagnostics
        {
            get { return diagnostics; }
        }

        public static SupportTicketDraftInput Create(string source, string category, string title, string description)
        {
            return new SupportTicketDraftInput(source, category, title, description);
        }

        public SupportTicketDraftInput WithProjectId(string projectId)
        {
            ProjectId = projectId;
            return this;
        }

        public SupportTicketDraftInput WithEnvironment(string environment)
        {
            Environment = environment;
            return this;
        }

        public SupportTicketDraftInput WithRuntime(string runtime)
        {
            Runtime = runtime;
            return this;
        }

        public SupportTicketDraftInput WithFramework(string framework)
        {
            Framework = framework;
            return this;
        }

        public SupportTicketDraftInput WithSdkPackage(string sdkPackage)
        {
            SdkPackage = sdkPackage;
            return this;
        }

        public SupportTicketDraftInput WithSdkVersion(string sdkVersion)
        {
            SdkVersion = sdkVersion;
            return this;
        }

        public SupportTicketDraftInput WithRelease(string release)
        {
            Release = release;
            return this;
        }

        public SupportTicketDraftInput WithTraceId(string traceId)
        {
            TraceId = traceId;
            return this;
        }

        public SupportTicketDraftInput WithEventId(string eventId)
        {
            EventId = eventId;
            return this;
        }

        public SupportTicketDraftInput WithDiagnostics(IDictionary<string, object?> values)
        {
            if (values == null)
            {
                diagnostics = null;
            }
            else
            {
                diagnostics = new ReadOnlyDictionary<string, object?>(new Dictionary<string, object?>(values, StringComparer.Ordinal));
            }

            return this;
        }
    }

    /// <summary>
    /// Local-only support-ticket payload draft for explicit user or agent handoff.
    /// </summary>
    /// <remarks>
    /// This helper validates planned public support-ticket fields and redacts diagnostics.
    /// It does not send data, open a ticket, call backend support routes, or use
    /// account/session API credentials.
    /// </remarks>
    public sealed class SupportTicketDraft
    {
        private static readonly string[] SupportTicketSources = { "cli", "sdk", "website", "docs", "mobile" };

        private static readonly string[] SupportTicketCategories =
        {
            "sdk_install_failure",
            "ingest_failure",
            "auth_failure",
            "project_setup",
            "dashboard_issue",
            "docs_confusion",
            "cli_issue",
            "mobile_issue",
            "billing_question",
            "other",
        };

        private const string ZeroTraceId = "00000000000000000000000000000000";

        private SupportTicketDraft(
            string? projectId,
            string source,
            string category,
            string title,
            string description,
            string? environment,
            string? runtime,
            string? framework,
            string? sdkPackage,
            string? sdkVersion,
            string? release,
            string? traceId,
            string? eventId,
            IReadOnlyDictionary<string, object?> diagnostics)
        {
            ProjectId = projectId;
            Source = source;
            Category = category;
            Title = title;
            Description = description;
            Environment = environment;
            Runtime = runtime;
            Framework = framework;
            SdkPackage = sdkPackage;
            SdkVersion = sdkVersion;
            Release = release;
            TraceId = traceId;
            EventId = eventId;
            Diagnostics = diagnostics;
        }

        public string? ProjectId { get; }

        public string Source { get; }

        public string Category { get; }

        public string Title { get; }

        public string Description { get; }

        public string? Environment { get; }

        public string? Runtime { get; }

        public string? Framework { get; }

        public string? SdkPackage { get; }

        public string? SdkVersion { get; }

        public string? Release { get; }

        public string? TraceId { get; }

        public string? EventId { get; }

        public IReadOnlyDictionary<string, object?> Diagnostics { get; }

        public static SupportTicketDraft Create(SupportTicketDraftInput input)
        {
            if (input == null)
            {
                throw new SdkException("validation_error", "support ticket draft input must be provided");
            }

            Validation.RequireAllowedValue("support ticket source", input.Source, SupportTicketSources);
            Validation.RequireAllowedValue("support ticket category", input.Category, SupportTicketCategories);
            Validation.RequireNonEmpty("support ticket title", input.Title);
            Validation.RequireNonEmpty("support ticket description", input.Description);

            return new SupportTicketDraft(
                CleanOptionalString("support ticket project_id", input.ProjectId),
                input.Source,
                input.Category,
                input.Title.Trim(),
                input.Description.Trim(),
                CleanOptionalString("support ticket environment", input.Environment),
                CleanOptionalString("support ticket runtime", input.Runtime),
                CleanOptionalString("support ticket framework", input.Framework),
                CleanOptionalString("support ticket sdk_package", input.SdkPackage),
                CleanOptionalString("support ticket sdk_version", input.SdkVersion),
                CleanOptionalString("support ticket release", input.Release),
                NormalizeTraceId(input.TraceId),
                CleanOptionalString("support ticket event_id", input.EventId),
                SupportDiagnosticsSanitizer.Sanitize(input.Diagnostics));
        }

        public IReadOnlyDictionary<string, object?> ToDictionary()
        {
            var payload = new Dictionary<string, object?>(StringComparer.Ordinal);
            AddIfNotNull(payload, "project_id", ProjectId);
            payload["source"] = Source;
            payload["category"] = Category;
            payload["title"] = Title;
            payload["description"] = Description;
            AddIfNotNull(payload, "environment", Environment);
            AddIfNotNull(payload, "runtime", Runtime);
            AddIfNotNull(payload, "framework", Framework);
            AddIfNotNull(payload, "sdk_package", SdkPackage);
            AddIfNotNull(payload, "sdk_version", SdkVersion);
            AddIfNotNull(payload, "release", Release);
            AddIfNotNull(payload, "trace_id", TraceId);
            AddIfNotNull(payload, "event_id", EventId);
            if (Diagnostics.Count > 0)
            {
                payload["diagnostics"] = CopyDictionary(Diagnostics);
            }

            return new ReadOnlyDictionary<string, object?>(payload);
        }

        public string ToJson()
        {
            return JsonWriter.Write(ToJsonObject());
        }

        private OrderedJsonObject ToJsonObject()
        {
            var payload = new OrderedJsonObject();
            payload.AddIfNotNull("project_id", ProjectId);
            payload.Add("source", Source);
            payload.Add("category", Category);
            payload.Add("title", Title);
            payload.Add("description", Description);
            payload.AddIfNotNull("environment", Environment);
            payload.AddIfNotNull("runtime", Runtime);
            payload.AddIfNotNull("framework", Framework);
            payload.AddIfNotNull("sdk_package", SdkPackage);
            payload.AddIfNotNull("sdk_version", SdkVersion);
            payload.AddIfNotNull("release", Release);
            payload.AddIfNotNull("trace_id", TraceId);
            payload.AddIfNotNull("event_id", EventId);
            if (Diagnostics.Count > 0)
            {
                payload.Add("diagnostics", ToJsonObject(Diagnostics));
            }

            return payload;
        }

        private static OrderedJsonObject ToJsonObject(IReadOnlyDictionary<string, object?> values)
        {
            var json = new OrderedJsonObject();
            foreach (var item in values)
            {
                json.Add(item.Key, ToJsonValue(item.Value));
            }

            return json;
        }

        private static object? ToJsonValue(object? value)
        {
            if (value is IReadOnlyDictionary<string, object?> dictionary)
            {
                return ToJsonObject(dictionary);
            }

            if (value is IReadOnlyList<object?> list)
            {
                var output = new List<object?>();
                foreach (var item in list)
                {
                    output.Add(ToJsonValue(item));
                }

                return output;
            }

            return value;
        }

        private static string? CleanOptionalString(string label, string? value)
        {
            if (value == null)
            {
                return null;
            }

            Validation.RequireNonEmpty(label, value);
            return value.Trim();
        }

        private static string? NormalizeTraceId(string? traceId)
        {
            if (traceId == null)
            {
                return null;
            }

            Validation.RequireNonEmpty("support ticket trace_id", traceId);
            var normalized = LowercaseAscii(traceId.Trim());
            if (normalized.Length != 32 || !IsHex(normalized))
            {
                throw new SdkException("validation_error", "support ticket trace_id must be 32 hex characters");
            }

            if (ZeroTraceId.Equals(normalized, StringComparison.Ordinal))
            {
                throw new SdkException("validation_error", "support ticket trace_id must not be all zeros");
            }

            return normalized;
        }

        private static string LowercaseAscii(string value)
        {
            var output = new char[value.Length];
            for (var index = 0; index < value.Length; index++)
            {
                var character = value[index];
                output[index] = character >= 'A' && character <= 'Z'
                    ? (char)(character + ('a' - 'A'))
                    : character;
            }

            return new string(output);
        }

        private static bool IsHex(string value)
        {
            foreach (var character in value)
            {
                var isDigit = character >= '0' && character <= '9';
                var isHexLetter = character >= 'a' && character <= 'f';
                if (!isDigit && !isHexLetter)
                {
                    return false;
                }
            }

            return true;
        }

        private static ReadOnlyDictionary<string, object?> CopyDictionary(IReadOnlyDictionary<string, object?> source)
        {
            var copy = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var item in source)
            {
                copy[item.Key] = item.Value;
            }

            return new ReadOnlyDictionary<string, object?>(copy);
        }

        private static void AddIfNotNull(Dictionary<string, object?> payload, string key, object? value)
        {
            if (value != null)
            {
                payload[key] = value;
            }
        }
    }
}
