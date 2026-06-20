using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Text.RegularExpressions;

namespace LogBrew
{
    internal static class SupportDiagnosticsSanitizer
    {
        private static readonly HashSet<string> SensitiveKeys = new HashSet<string>(StringComparer.Ordinal)
        {
            "apikey",
            "auth",
            "authorization",
            "authtoken",
            "bearer",
            "clientsecret",
            "connectionstring",
            "cookie",
            "credential",
            "credentials",
            "dsn",
            "password",
            "passwd",
            "privatekey",
            "refreshtoken",
            "secret",
            "session",
            "setcookie",
            "token",
        };

        private static readonly string[] SensitiveKeyMarkers =
        {
            "auth",
            "connectionstring",
            "cookie",
            "credential",
            "dsn",
            "password",
            "passwd",
            "privatekey",
            "secret",
            "session",
            "token",
        };

        private static readonly Regex SensitiveAssignmentPattern = new Regex(
            "(?:authorization|api[_-]?key|token|secret|password|passwd|cookie)\\s*[:=]",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant,
            TimeSpan.FromMilliseconds(100));

        private static readonly Regex TokenPattern = new Regex(
            "(?:\\bBearer\\s+[A-Za-z0-9._~+/=-]+|\\blbw_ingest_[A-Za-z0-9._-]+|\\b(?:sk|pk|xox[abprs]?)-[A-Za-z0-9_-]{10,}|\\bAKIA[0-9A-Z]{16}\\b)",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant,
            TimeSpan.FromMilliseconds(100));

        private static readonly Regex UrlPattern = new Regex(
            "https?://[^\\s\"'<>]+",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant,
            TimeSpan.FromMilliseconds(100));

        private static readonly Regex PosixPathPattern = new Regex(
            "(?:^|[^\\w.-])(?:/Users|/home|/var/folders|/private/var|/tmp)/[^\\s\"'<>]+",
            RegexOptions.CultureInvariant,
            TimeSpan.FromMilliseconds(100));

        private static readonly Regex WindowsPathPattern = new Regex(
            "\\b[A-Za-z]:\\\\[^\\s\"'<>]+",
            RegexOptions.CultureInvariant,
            TimeSpan.FromMilliseconds(100));

        private const string Redacted = "[redacted]";
        private const string RedactedPath = "[redacted-path]";
        private const string RedactedUrl = "[redacted-url]";
        private const int MaxDiagnosticDepth = 5;
        private const int MaxDiagnosticItems = 20;
        private const int MaxStringLength = 500;

        internal static IReadOnlyDictionary<string, object?> Sanitize(IReadOnlyDictionary<string, object?>? diagnostics)
        {
            var safe = new Dictionary<string, object?>(StringComparer.Ordinal);
            if (diagnostics == null)
            {
                return new ReadOnlyDictionary<string, object?>(safe);
            }

            foreach (var item in diagnostics)
            {
                if (safe.Count >= MaxDiagnosticItems)
                {
                    break;
                }

                if (string.IsNullOrEmpty(item.Key))
                {
                    continue;
                }

                if (IsSensitiveKey(item.Key))
                {
                    safe[item.Key] = Redacted;
                    continue;
                }

                if (TrySanitizeValue(item.Value, 0, out var sanitized))
                {
                    safe[item.Key] = sanitized;
                }
            }

            return new ReadOnlyDictionary<string, object?>(safe);
        }

        private static bool TrySanitizeValue(object? value, int depth, out object? sanitized)
        {
            sanitized = null;
            if (depth > MaxDiagnosticDepth)
            {
                return false;
            }

            if (value == null || value is bool || value is string)
            {
                sanitized = value is string text ? SanitizeString(text) : value;
                return true;
            }

            if (value is byte || value is sbyte || value is short || value is ushort || value is int || value is uint || value is long || value is ulong)
            {
                sanitized = value;
                return true;
            }

            if (value is float floatValue)
            {
                if (float.IsNaN(floatValue) || float.IsInfinity(floatValue))
                {
                    return false;
                }

                sanitized = floatValue;
                return true;
            }

            if (value is double doubleValue)
            {
                if (double.IsNaN(doubleValue) || double.IsInfinity(doubleValue))
                {
                    return false;
                }

                sanitized = doubleValue;
                return true;
            }

            if (value is decimal)
            {
                sanitized = value;
                return true;
            }

            if (value is Exception error)
            {
                sanitized = new ReadOnlyDictionary<string, object?>(
                    new Dictionary<string, object?>(StringComparer.Ordinal) { ["type"] = error.GetType().FullName });
                return true;
            }

            if (value is IDictionary dictionary)
            {
                sanitized = SanitizeDictionary(dictionary, depth);
                return true;
            }

            if (value is IEnumerable enumerable)
            {
                sanitized = SanitizeEnumerable(enumerable, depth);
                return true;
            }

            return false;
        }

        private static IReadOnlyDictionary<string, object?> SanitizeDictionary(IDictionary values, int depth)
        {
            var safe = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (DictionaryEntry entry in values)
            {
                if (safe.Count >= MaxDiagnosticItems)
                {
                    break;
                }

                if (!(entry.Key is string key) || string.IsNullOrEmpty(key))
                {
                    continue;
                }

                if (IsSensitiveKey(key))
                {
                    safe[key] = Redacted;
                    continue;
                }

                if (TrySanitizeValue(entry.Value, depth + 1, out var sanitized))
                {
                    safe[key] = sanitized;
                }
            }

            return new ReadOnlyDictionary<string, object?>(safe);
        }

        private static IReadOnlyList<object?> SanitizeEnumerable(IEnumerable values, int depth)
        {
            var safe = new List<object?>();
            foreach (var value in values)
            {
                if (safe.Count >= MaxDiagnosticItems)
                {
                    break;
                }

                if (TrySanitizeValue(value, depth + 1, out var sanitized))
                {
                    safe.Add(sanitized);
                }
            }

            return new ReadOnlyCollection<object?>(safe);
        }

        private static bool IsSensitiveKey(string key)
        {
            var normalized = NormalizeKey(key);
            if (SensitiveKeys.Contains(normalized))
            {
                return true;
            }

            foreach (var marker in SensitiveKeyMarkers)
            {
                if (normalized.Contains(marker))
                {
                    return true;
                }
            }

            return false;
        }

        private static string NormalizeKey(string key)
        {
            var output = new char[key.Length];
            var count = 0;
            foreach (var character in key)
            {
                var lower = character >= 'A' && character <= 'Z'
                    ? (char)(character + ('a' - 'A'))
                    : character;
                if ((lower >= 'a' && lower <= 'z') || (lower >= '0' && lower <= '9'))
                {
                    output[count] = lower;
                    count++;
                }
            }

            return new string(output, 0, count);
        }

        private static string SanitizeString(string value)
        {
            if (SensitiveAssignmentPattern.IsMatch(value) || TokenPattern.IsMatch(value))
            {
                return Redacted;
            }

            var sanitized = UrlPattern.Replace(value, match => RedactedUrl + PathFromUrl(match.Value));
            sanitized = PosixPathPattern.Replace(sanitized, match =>
            {
                var text = match.Value;
                return text.StartsWith("/", StringComparison.Ordinal)
                    ? RedactedPath
                    : text.Substring(0, 1) + RedactedPath;
            });
            sanitized = WindowsPathPattern.Replace(sanitized, RedactedPath);
            if (sanitized.Length > MaxStringLength)
            {
                return sanitized.Substring(0, MaxStringLength - 3) + "...";
            }

            return sanitized;
        }

        private static string PathFromUrl(string value)
        {
            if (!Uri.TryCreate(value, UriKind.Absolute, out var uri))
            {
                return string.Empty;
            }

            return string.IsNullOrEmpty(uri.AbsolutePath) ? string.Empty : uri.AbsolutePath;
        }
    }
}
