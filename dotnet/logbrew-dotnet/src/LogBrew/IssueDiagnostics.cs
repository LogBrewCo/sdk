using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;

namespace LogBrew
{
    internal static class IssueDiagnostics
    {
        internal const int MaxStackFrames = 32;
        internal const int MaxBreadcrumbs = 64;
        internal const int MaxExceptions = 8;

        private const int MaxExceptionType = 256;
        private const int MaxExceptionMessage = 1024;
        private const int MaxExceptionModule = 512;
        private const int MaxMechanismType = 64;
        private const int MaxFrameFilename = 2048;
        private const int MaxFrameFunction = 256;
        private const int MaxFrameModule = 512;
        private const int MaxBreadcrumbName = 64;
        private const int MaxBreadcrumbMessage = 512;
        private const int MaxBreadcrumbDataFields = 8;
        private const int MaxBreadcrumbDataString = 256;

        internal static string RequireExceptionType(string value)
        {
            return RequireText("issue exception type", value, MaxExceptionType, true);
        }

        internal static string RequireMechanismType(string value)
        {
            return RequireMachineName("issue exception mechanism type", value, MaxMechanismType, true);
        }

        internal static string RequireExceptionMessage(string value)
        {
            return RequireText("issue exceptionChain message", value, MaxExceptionMessage, false);
        }

        internal static string RequireExceptionModule(string value)
        {
            return RequireText("issue exceptionChain module", value, MaxExceptionModule, true);
        }

        internal static string RequireBreadcrumbName(string label, string value, bool allowColon)
        {
            return RequireMachineName(label, value, MaxBreadcrumbName, allowColon);
        }

        internal static string RequireBreadcrumbMessage(string value)
        {
            return RequireText("issue breadcrumb message", value, MaxBreadcrumbMessage, false);
        }

        internal static string RequireFrameFunction(string value)
        {
            return RequireText("issue stack frame function", value, MaxFrameFunction, false);
        }

        internal static string RequireFrameModule(string value)
        {
            return RequireText("issue stack frame module", value, MaxFrameModule, true);
        }

        internal static int RequireCoordinate(string label, int value)
        {
            if (value < 1)
            {
                throw Validation(label + " must be a positive integer");
            }

            return value;
        }

        internal static string NormalizeDebugId(string value)
        {
            var normalized = value == null ? string.Empty : value.Trim();
            if (!Guid.TryParseExact(normalized, "D", out var debugId))
            {
                throw Validation("issue stack frame debugId is invalid");
            }

            return debugId.ToString("D");
        }

        internal static string SanitizeFilename(string value)
        {
            if (value == null)
            {
                throw Validation("issue stack frame filename is invalid");
            }

            var filename = value.Trim();
            var fileUrl = filename.StartsWith("file://", StringComparison.OrdinalIgnoreCase);
            if (fileUrl)
            {
                filename = filename.Substring("file://".Length);
            }

            var query = filename.IndexOf('?');
            var fragment = filename.IndexOf('#');
            var end = filename.Length;
            if (query >= 0)
            {
                end = Math.Min(end, query);
            }

            if (fragment >= 0)
            {
                end = Math.Min(end, fragment);
            }

            filename = filename.Substring(0, end).Trim();
            var absolute = fileUrl
                || TextSearch.StartsWith(filename, '/')
                || TextSearch.StartsWith(filename, '\\')
                || (filename.Length >= 3
                    && IsAsciiLetter(filename[0])
                    && filename[1] == ':'
                    && (filename[2] == '/' || filename[2] == '\\'));
            if (absolute)
            {
                filename = Basename(filename);
            }

            return RequireText("issue stack frame filename", filename, MaxFrameFilename, true);
        }

        internal static void RequireBreadcrumbTimestamp(string value)
        {
            if (!HasRfc3339Shape(value)
                || !DateTimeOffset.TryParse(
                    value,
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.None,
                    out _))
            {
                throw Validation("issue breadcrumb timestamp must be RFC 3339 with an explicit timezone");
            }
        }

        internal static string NormalizeBreadcrumbLevel(string value)
        {
            return value switch
            {
                "trace" or "debug" => "debug",
                "log" or "info" => "info",
                "warn" or "warning" => "warning",
                "error" => "error",
                "fatal" or "critical" => "critical",
                _ => throw Validation(
                    "issue breadcrumb level must be one of: trace, debug, info, log, warn, warning, error, fatal, critical"),
            };
        }

        internal static IDictionary<string, object?> CopyBreadcrumbData(IDictionary<string, object?> input)
        {
            if (input == null)
            {
                throw Validation("issue breadcrumb data must be provided");
            }

            if (input.Count > MaxBreadcrumbDataFields)
            {
                throw Validation("issue breadcrumb data must contain at most 8 fields");
            }

            var copied = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var item in input)
            {
                var key = RequireMachineName(
                    "issue breadcrumb data key",
                    item.Key,
                    MaxBreadcrumbName,
                    false);
                copied[key] = CopyBreadcrumbDataValue(key, item.Value);
            }

            return copied;
        }

        internal static OrderedJsonObject BreadcrumbDataToJson(IDictionary<string, object?> input)
        {
            var copied = CopyBreadcrumbData(input);
            var value = new OrderedJsonObject();
            foreach (var item in copied)
            {
                value.Add(item.Key, item.Value);
            }

            return value;
        }

        internal static string SafeExceptionType(Exception error)
        {
            if (error == null)
            {
                throw Validation("issue error must be provided");
            }

            var type = error.GetType();
            return SafeText(type.FullName ?? type.Name, MaxExceptionType, true, "System.Exception")!;
        }

        internal static IReadOnlyList<IssueStackFrame> StackFrames(Exception error)
        {
            return StackEvidence(error).Frames;
        }

        internal static IssueStackEvidence StackEvidence(Exception error)
        {
            if (error == null)
            {
                throw Validation("issue error must be provided");
            }

            var stackTrace = new StackTrace(error, true);
            var sourceFrames = stackTrace.GetFrames();
            var result = new List<IssueStackFrame>();
            if (sourceFrames == null)
            {
                return new IssueStackEvidence(result.AsReadOnly(), false);
            }

            foreach (var sourceFrame in sourceFrames)
            {
                if (result.Count == MaxStackFrames)
                {
                    break;
                }

                var method = sourceFrame.GetMethod();
                var module = SafeText(method?.DeclaringType?.FullName, MaxFrameModule, true, null);
                var function = SafeText(method?.Name, MaxFrameFunction, false, null);
                var filename = GeneratedFilename(sourceFrame.GetFileName(), method?.DeclaringType?.Name);
                var line = sourceFrame.GetFileLineNumber();
                var column = sourceFrame.GetFileColumnNumber();
                var frame = IssueStackFrame.Create(filename, line > 0 ? line : 1, column > 0 ? column : 1);
                if (function != null)
                {
                    frame.WithFunction(function);
                }

                if (module != null)
                {
                    frame.WithModule(module);
                }

                result.Add(frame);
            }

            return new IssueStackEvidence(
                result.AsReadOnly(),
                sourceFrames.Length > MaxStackFrames);
        }

        internal static string? SafeExceptionModule(Exception error)
        {
            var type = error.GetType();
            return SafeText(type.Namespace, MaxExceptionModule, true, null);
        }

        internal static bool HasExceptionMessage(Exception error)
        {
            try
            {
                return !string.IsNullOrWhiteSpace(error.Message);
            }
            catch (Exception failure) when (!DeliveryExceptionPolicy.IsFatal(failure))
            {
                return false;
            }
        }

        internal static SdkException Validation(string message)
        {
            return new SdkException("validation_error", message);
        }

        private static object? CopyBreadcrumbDataValue(string key, object? value)
        {
            if (value == null || value is bool || value is byte || value is short || value is int || value is long || value is decimal)
            {
                return value;
            }

            if (value is double doubleValue)
            {
                if (double.IsNaN(doubleValue) || double.IsInfinity(doubleValue))
                {
                    throw BreadcrumbPrimitiveError(key);
                }

                return doubleValue;
            }

            if (value is float floatValue)
            {
                if (float.IsNaN(floatValue) || float.IsInfinity(floatValue))
                {
                    throw BreadcrumbPrimitiveError(key);
                }

                return floatValue;
            }

            if (value is string text)
            {
                return RequireText(
                    "issue breadcrumb data value for " + key,
                    text,
                    MaxBreadcrumbDataString,
                    false);
            }

            throw BreadcrumbPrimitiveError(key);
        }

        private static string GeneratedFilename(string? sourceFilename, string? declaringTypeName)
        {
            if (!string.IsNullOrWhiteSpace(sourceFilename))
            {
                return Basename(SanitizeFilename(sourceFilename!));
            }

            var leaf = SafeText(declaringTypeName, 240, false, "Exception") ?? "Exception";
            return leaf + ".cs";
        }

        private static string RequireMachineName(string label, string value, int maximum, bool allowColon)
        {
            var normalized = value == null ? string.Empty : value.Trim();
            if (normalized.Length == 0
                || normalized.Length > maximum
                || !IsAsciiLetter(normalized[0]))
            {
                throw Validation(label + " must be a stable machine name");
            }

            for (var index = 1; index < normalized.Length; index++)
            {
                var character = normalized[index];
                if (!IsAsciiLetter(character)
                    && !IsAsciiDigit(character)
                    && character != '_'
                    && character != '.'
                    && character != '-'
                    && (!allowColon || character != ':'))
                {
                    throw Validation(label + " must be a stable machine name");
                }
            }

            return normalized;
        }

        private static string RequireText(string label, string value, int maximum, bool rejectLocationText)
        {
            var normalized = value == null ? string.Empty : value.Trim();
            if (normalized.Length == 0
                || normalized.Length > maximum
                || HasControlCharacter(normalized)
                || (rejectLocationText
                    && (TextSearch.Contains(normalized, '?')
                        || TextSearch.Contains(normalized, '#'))))
            {
                throw Validation(label + " is invalid or exceeds " + maximum.ToString(CultureInfo.InvariantCulture) + " characters");
            }

            return normalized;
        }

        private static string? SafeText(string? value, int maximum, bool rejectLocationText, string? fallback)
        {
            try
            {
                return RequireText("issue diagnostic identity", value!, maximum, rejectLocationText);
            }
            catch (SdkException)
            {
                return fallback;
            }
        }

        private static bool HasRfc3339Shape(string? value)
        {
            if (value == null || value.Length < 20)
            {
                return false;
            }

            if (!Digits(value, 0, 4)
                || value[4] != '-'
                || !Digits(value, 5, 2)
                || value[7] != '-'
                || !Digits(value, 8, 2)
                || value[10] != 'T'
                || !Digits(value, 11, 2)
                || value[13] != ':'
                || !Digits(value, 14, 2)
                || value[16] != ':'
                || !Digits(value, 17, 2))
            {
                return false;
            }

            var timezoneIndex = 19;
            if (value[timezoneIndex] == '.')
            {
                timezoneIndex++;
                var fractionStart = timezoneIndex;
                while (timezoneIndex < value.Length && IsAsciiDigit(value[timezoneIndex]))
                {
                    timezoneIndex++;
                }

                if (timezoneIndex == fractionStart)
                {
                    return false;
                }
            }

            if (timezoneIndex >= value.Length)
            {
                return false;
            }

            if (value[timezoneIndex] == 'Z')
            {
                return timezoneIndex == value.Length - 1;
            }

            return (value[timezoneIndex] == '+' || value[timezoneIndex] == '-')
                && value.Length == timezoneIndex + 6
                && Digits(value, timezoneIndex + 1, 2)
                && value[timezoneIndex + 3] == ':'
                && Digits(value, timezoneIndex + 4, 2);
        }

        private static bool Digits(string value, int start, int count)
        {
            if (start < 0 || count < 1 || start + count > value.Length)
            {
                return false;
            }

            for (var index = start; index < start + count; index++)
            {
                if (!IsAsciiDigit(value[index]))
                {
                    return false;
                }
            }

            return true;
        }

        private static bool HasControlCharacter(string value)
        {
            foreach (var character in value)
            {
                if (character <= 31 || (character >= 127 && character <= 159))
                {
                    return true;
                }
            }

            return false;
        }

        private static string Basename(string value)
        {
            var normalized = value.Replace('\\', '/');
            while (TextSearch.EndsWith(normalized, '/') && normalized.Length > 1)
            {
                normalized = normalized.Substring(0, normalized.Length - 1);
            }

            var separator = normalized.LastIndexOf('/');
            return separator >= 0 ? normalized.Substring(separator + 1) : normalized;
        }

        private static bool IsAsciiLetter(char value)
        {
            return (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z');
        }

        private static bool IsAsciiDigit(char value)
        {
            return value >= '0' && value <= '9';
        }

        private static SdkException BreadcrumbPrimitiveError(string key)
        {
            return Validation("issue breadcrumb data value for " + key + " must be a finite primitive");
        }
    }
}
