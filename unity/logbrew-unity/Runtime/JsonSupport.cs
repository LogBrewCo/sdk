#nullable enable

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;

namespace LogBrew.Unity
{
    internal sealed class OrderedJsonObject
    {
        private readonly List<KeyValuePair<string, object?>> values = new List<KeyValuePair<string, object?>>();

        internal IReadOnlyList<KeyValuePair<string, object?>> Values
        {
            get { return values.AsReadOnly(); }
        }

        internal OrderedJsonObject Add(string key, object? value)
        {
            values.Add(new KeyValuePair<string, object?>(key, value));
            return this;
        }

        internal void AddIfNotNull(string key, object? value)
        {
            if (value != null)
            {
                Add(key, value);
            }
        }

        internal void AddMetadata(IDictionary<string, object?>? metadata)
        {
            if (metadata == null || metadata.Count == 0)
            {
                return;
            }

            Add("metadata", Validation.CopyMetadata(metadata));
        }
    }

    internal static class Validation
    {
        private static readonly char[] TimestampDateTimeSeparators = { 'T' };

        internal static void RequireNonEmpty(string label, string value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                throw new SdkException("validation_error", label + " must be non-empty");
            }
        }

        internal static void RequireTimestamp(string value)
        {
            RequireNonEmpty("event timestamp", value);
            if (!HasTimezoneOffset(value))
            {
                throw new SdkException("validation_error", "event timestamp must be an ISO-8601 timestamp with timezone");
            }

            if (!DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out _))
            {
                throw new SdkException("validation_error", "event timestamp must be a valid ISO-8601 timestamp");
            }
        }

        internal static void RequireAllowedValue(string label, string value, IEnumerable<string> allowed)
        {
            RequireNonEmpty(label, value);
            if (!allowed.Contains(value))
            {
                throw new SdkException("validation_error", label + " has unsupported value " + value);
            }
        }

        internal static object? RequireMetadataValue(string key, object? value)
        {
            if (value == null || value is string || value is bool || value is int || value is long || value is float || value is double || value is decimal)
            {
                return value;
            }

            throw new SdkException("validation_error", "metadata value for " + key + " must be a string, number, boolean, or null");
        }

        internal static OrderedJsonObject CopyMetadata(IDictionary<string, object?> metadata)
        {
            var payload = new OrderedJsonObject();
            foreach (var item in metadata)
            {
                RequireNonEmpty("metadata key", item.Key);
                payload.Add(item.Key, RequireMetadataValue(item.Key, item.Value));
            }

            return payload;
        }

        private static bool HasTimezoneOffset(string value)
        {
            if (value.EndsWith('Z'))
            {
                return true;
            }

            var parts = value.Split(TimestampDateTimeSeparators, 2);
            if (parts.Length < 2)
            {
                return false;
            }

            var timePortion = parts[1];
            for (var index = 0; index < timePortion.Length; index++)
            {
                var character = timePortion[index];
                if (character == '+')
                {
                    return true;
                }

                if (character == '-' && index > 0)
                {
                    return true;
                }
            }

            return false;
        }
    }

    internal static class JsonWriter
    {
        internal static string Write(OrderedJsonObject value)
        {
            var builder = new StringBuilder();
            WriteValue(builder, value, 0);
            return builder.ToString();
        }

        private static void WriteValue(StringBuilder builder, object? value, int indent)
        {
            if (value == null)
            {
                builder.Append("null");
                return;
            }

            if (value is string text)
            {
                WriteString(builder, text);
                return;
            }

            if (value is bool boolean)
            {
                builder.Append(boolean ? "true" : "false");
                return;
            }

            if (value is int || value is long || value is float || value is double || value is decimal)
            {
                builder.Append(Convert.ToString(value, CultureInfo.InvariantCulture));
                return;
            }

            if (value is OrderedJsonObject jsonObject)
            {
                WriteObject(builder, jsonObject, indent);
                return;
            }

            if (value is IEnumerable<OrderedJsonObject> jsonObjects)
            {
                WriteArray(builder, jsonObjects.ToList(), indent);
                return;
            }

            throw new SdkException("validation_error", "unsupported JSON value");
        }

        private static void WriteObject(StringBuilder builder, OrderedJsonObject value, int indent)
        {
            builder.Append('{');
            if (value.Values.Count == 0)
            {
                builder.Append('}');
                return;
            }

            builder.Append('\n');
            for (var index = 0; index < value.Values.Count; index++)
            {
                var item = value.Values[index];
                Indent(builder, indent + 2);
                WriteString(builder, item.Key);
                builder.Append(": ");
                WriteValue(builder, item.Value, indent + 2);
                if (index < value.Values.Count - 1)
                {
                    builder.Append(',');
                }

                builder.Append('\n');
            }

            Indent(builder, indent);
            builder.Append('}');
        }

        private static void WriteArray(StringBuilder builder, List<OrderedJsonObject> values, int indent)
        {
            builder.Append('[');
            if (values.Count == 0)
            {
                builder.Append(']');
                return;
            }

            builder.Append('\n');
            for (var index = 0; index < values.Count; index++)
            {
                Indent(builder, indent + 2);
                WriteValue(builder, values[index], indent + 2);
                if (index < values.Count - 1)
                {
                    builder.Append(',');
                }

                builder.Append('\n');
            }

            Indent(builder, indent);
            builder.Append(']');
        }

        private static void WriteString(StringBuilder builder, string value)
        {
            builder.Append('"');
            foreach (var character in value)
            {
                switch (character)
                {
                    case '"':
                        builder.Append("\\\"");
                        break;
                    case '\\':
                        builder.Append("\\\\");
                        break;
                    case '\b':
                        builder.Append("\\b");
                        break;
                    case '\f':
                        builder.Append("\\f");
                        break;
                    case '\n':
                        builder.Append("\\n");
                        break;
                    case '\r':
                        builder.Append("\\r");
                        break;
                    case '\t':
                        builder.Append("\\t");
                        break;
                    default:
                        if (char.IsControl(character))
                        {
                            builder.Append("\\u");
                            builder.Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            builder.Append(character);
                        }

                        break;
                }
            }

            builder.Append('"');
        }

        private static void Indent(StringBuilder builder, int count)
        {
            builder.Append(' ', count);
        }
    }
}
