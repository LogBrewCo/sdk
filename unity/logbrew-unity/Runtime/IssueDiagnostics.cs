#nullable enable

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;

namespace LogBrew.Unity
{
    public sealed class IssueExceptionMechanism
    {
        private IssueExceptionMechanism(string type, bool handled)
        {
            Type = type;
            Handled = handled;
        }

        public string Type { get; }

        public bool Handled { get; }

        public static IssueExceptionMechanism Create(string type, bool handled)
        {
            return new IssueExceptionMechanism(type, handled);
        }

        internal OrderedJsonObject ToJsonObject()
        {
            return new OrderedJsonObject()
                .Add("type", IssueDiagnostics.RequireMechanismType(Type))
                .Add("handled", Handled);
        }
    }

    public sealed class IssueExceptionInfo
    {
        private IssueExceptionInfo(string type)
        {
            Type = type;
        }

        public string Type { get; }

        public IssueExceptionMechanism? Mechanism { get; private set; }

        public static IssueExceptionInfo Create(string type)
        {
            return new IssueExceptionInfo(type);
        }

        public IssueExceptionInfo WithMechanism(IssueExceptionMechanism mechanism)
        {
            Mechanism = mechanism ?? throw new ArgumentNullException(nameof(mechanism));
            return this;
        }

        internal OrderedJsonObject ToJsonObject()
        {
            var value = new OrderedJsonObject().Add("type", IssueDiagnostics.RequireExceptionType(Type));
            value.AddIfNotNull("mechanism", Mechanism?.ToJsonObject());
            return value;
        }
    }

    public sealed class IssueStackFrame
    {
        private IssueStackFrame(string filename, int line, int column)
        {
            Filename = filename;
            Line = line;
            Column = column;
        }

        public string Filename { get; }

        public int Line { get; }

        public int Column { get; }

        public string? Function { get; private set; }

        public string? Module { get; private set; }

        public bool? InApp { get; private set; }

        public string? DebugId { get; private set; }

        public static IssueStackFrame Create(string filename, int line, int column)
        {
            return new IssueStackFrame(filename, line, column);
        }

        public IssueStackFrame WithFunction(string function)
        {
            Function = function;
            return this;
        }

        public IssueStackFrame WithModule(string module)
        {
            Module = module;
            return this;
        }

        public IssueStackFrame WithInApp(bool inApp)
        {
            InApp = inApp;
            return this;
        }

        public IssueStackFrame WithDebugId(string debugId)
        {
            DebugId = debugId;
            return this;
        }

        internal OrderedJsonObject ToJsonObject()
        {
            var value = new OrderedJsonObject()
                .Add("filename", IssueDiagnostics.SanitizeFilename(Filename))
                .Add("line", IssueDiagnostics.RequireCoordinate("issue stack frame line", Line))
                .Add("column", IssueDiagnostics.RequireCoordinate("issue stack frame column", Column));
            if (Function != null)
            {
                value.Add("function", IssueDiagnostics.RequireFrameFunction(Function));
            }

            if (Module != null)
            {
                value.Add("module", IssueDiagnostics.RequireFrameModule(Module));
            }

            value.AddIfNotNull("inApp", InApp);
            if (DebugId != null)
            {
                value.Add("debugId", IssueDiagnostics.NormalizeDebugId(DebugId));
            }

            return value;
        }
    }

    public sealed class IssueBreadcrumb
    {
        private IssueBreadcrumb(string timestamp, string category)
        {
            Timestamp = timestamp;
            Category = category;
        }

        public string Timestamp { get; }

        public string Category { get; }

        public string? Type { get; private set; }

        public string? Level { get; private set; }

        public string? Message { get; private set; }

        public IDictionary<string, object?>? Data { get; private set; }

        public static IssueBreadcrumb Create(string timestamp, string category)
        {
            return new IssueBreadcrumb(timestamp, category);
        }

        public IssueBreadcrumb WithType(string type)
        {
            Type = type;
            return this;
        }

        public IssueBreadcrumb WithLevel(string level)
        {
            Level = level;
            return this;
        }

        public IssueBreadcrumb WithMessage(string message)
        {
            Message = message;
            return this;
        }

        public IssueBreadcrumb WithData(IDictionary<string, object?> data)
        {
            Data = IssueDiagnostics.CopyBreadcrumbData(data);
            return this;
        }

        internal OrderedJsonObject ToJsonObject()
        {
            IssueDiagnostics.RequireBreadcrumbTimestamp(Timestamp);
            var value = new OrderedJsonObject()
                .Add("timestamp", Timestamp)
                .Add("category", IssueDiagnostics.RequireBreadcrumbName("issue breadcrumb category", Category, true));
            if (Type != null)
            {
                value.Add("type", IssueDiagnostics.RequireBreadcrumbName("issue breadcrumb type", Type, true));
            }

            if (Level != null)
            {
                value.Add("level", IssueDiagnostics.NormalizeBreadcrumbLevel(Level));
            }

            if (Message != null)
            {
                value.Add("message", IssueDiagnostics.RequireBreadcrumbMessage(Message));
            }

            if (Data != null)
            {
                value.Add("data", IssueDiagnostics.BreadcrumbDataToJson(Data));
            }

            return value;
        }
    }

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

            var query = IndexOfCharacter(filename, '?');
            var fragment = IndexOfCharacter(filename, '#');
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
                || (filename.Length > 0 && (filename[0] == '/' || filename[0] == '\\'))
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
                || !DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.None, out _))
            {
                throw Validation("issue breadcrumb timestamp must be RFC 3339 with an explicit timezone");
            }
        }

        internal static string NormalizeBreadcrumbLevel(string value)
        {
            switch (value)
            {
                case "trace":
                case "debug":
                    return "debug";
                case "log":
                case "info":
                    return "info";
                case "warn":
                case "warning":
                    return "warning";
                case "error":
                    return "error";
                case "fatal":
                case "critical":
                    return "critical";
                default:
                    throw Validation("issue breadcrumb level is unsupported");
            }
        }

        internal static IDictionary<string, object?> CopyBreadcrumbData(IDictionary<string, object?> input)
        {
            if (input == null)
            {
                throw new ArgumentNullException(nameof(input));
            }

            if (input.Count > MaxBreadcrumbDataFields)
            {
                throw Validation("issue breadcrumb data must contain at most 8 fields");
            }

            var copied = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var item in input)
            {
                var key = RequireMachineName("issue breadcrumb data key", item.Key, MaxBreadcrumbName, false);
                copied[key] = CopyBreadcrumbDataValue(key, item.Value);
            }

            return copied;
        }

        internal static OrderedJsonObject BreadcrumbDataToJson(IDictionary<string, object?> input)
        {
            var value = new OrderedJsonObject();
            foreach (var item in CopyBreadcrumbData(input))
            {
                value.Add(item.Key, item.Value);
            }

            return value;
        }

        internal static string SafeExceptionType(Exception error)
        {
            if (error == null)
            {
                throw new ArgumentNullException(nameof(error));
            }

            var type = error.GetType();
            return SafeText(type.FullName ?? type.Name, MaxExceptionType, true, "System.Exception")!;
        }

        internal static string UnityExceptionType(string title)
        {
            if (string.IsNullOrWhiteSpace(title))
            {
                return "UnityException";
            }

            var normalized = title.Trim();
            var separator = IndexOfCharacter(normalized, ':');
            var candidate = separator > 0 ? normalized.Substring(0, separator).Trim() : normalized;
            if (candidate.Length == 0 || candidate.Length > MaxExceptionType || !IsAsciiLetter(candidate[0]))
            {
                return "UnityException";
            }

            for (var index = 1; index < candidate.Length; index++)
            {
                var character = candidate[index];
                if (!IsAsciiLetter(character)
                    && !IsAsciiDigit(character)
                    && character != '_'
                    && character != '.'
                    && character != '+'
                    && character != '`')
                {
                    return "UnityException";
                }
            }

            return candidate;
        }

        internal static IReadOnlyList<IssueStackFrame> StackFrames(Exception error)
        {
            return StackEvidence(error).Frames;
        }

        internal static IssueStackEvidence StackEvidence(Exception error)
        {
            if (error == null)
            {
                throw new ArgumentNullException(nameof(error));
            }

            var sourceFrames = new StackTrace(error, true).GetFrames();
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

        internal static IReadOnlyList<IssueStackFrame> StackFramesFromUnityStackTrace(string stackTrace)
        {
            return StackEvidenceFromUnityStackTrace(stackTrace).Frames;
        }

        internal static IssueStackEvidence StackEvidenceFromUnityStackTrace(string stackTrace)
        {
            var result = new List<IssueStackFrame>();
            if (string.IsNullOrWhiteSpace(stackTrace))
            {
                return new IssueStackEvidence(result.AsReadOnly(), false);
            }

            var truncated = false;
            var lines = stackTrace.Replace('\r', '\n').Split('\n');
            foreach (var rawLine in lines)
            {
                if (!TryUnityStackFrame(rawLine, out var frame))
                {
                    continue;
                }

                if (result.Count == MaxStackFrames)
                {
                    truncated = true;
                    continue;
                }

                result.Add(frame);
            }

            return new IssueStackEvidence(result.AsReadOnly(), truncated);
        }

        private static bool TryUnityStackFrame(string rawLine, out IssueStackFrame frame)
        {
            frame = null!;
            var line = rawLine.Trim();
            var locationStart = line.LastIndexOf("(at ", StringComparison.Ordinal);
            var locationEnd = locationStart >= 0 ? line.LastIndexOf(')') : -1;
            var location = string.Empty;
            var functionText = string.Empty;
            if (locationStart >= 0 && locationEnd > locationStart + 4)
            {
                location = line.Substring(locationStart + 4, locationEnd - locationStart - 4);
                functionText = line.Substring(0, locationStart).Trim();
            }
            else
            {
                ParseDotNetStackLocation(line, out location, out functionText);
            }

            if (!TrySplitLocation(location, out var filename, out var sourceLine))
            {
                return false;
            }

            frame = IssueStackFrame.Create(filename, sourceLine, 1);
            AddUnityFrameFunction(frame, functionText);
            return true;
        }

        private static void ParseDotNetStackLocation(
            string line,
            out string location,
            out string functionText)
        {
            location = string.Empty;
            functionText = string.Empty;
            var inMarker = line.LastIndexOf(" in ", StringComparison.Ordinal);
            var lineMarker = line.LastIndexOf(":line ", StringComparison.Ordinal);
            if (inMarker < 0 || lineMarker <= inMarker + 4)
            {
                return;
            }

            var locationPath = line.Substring(inMarker + 4, lineMarker - inMarker - 4);
            var locationLine = line.Substring(lineMarker + 6).Trim();
            location = string.Join(":", new[] { locationPath, locationLine });
            functionText = line.Substring(0, inMarker).Trim();
        }

        private static void AddUnityFrameFunction(IssueStackFrame frame, string functionText)
        {
            var function = SafeText(NormalizeUnityFunction(functionText), MaxFrameFunction, false, null);
            if (function == null)
            {
                return;
            }

            frame.WithFunction(function);
            var separator = function.LastIndexOf('.');
            if (separator <= 0)
            {
                return;
            }

            var module = SafeText(function.Substring(0, separator), MaxFrameModule, true, null);
            if (module != null)
            {
                frame.WithModule(module);
            }
        }

        internal static SdkException Validation(string message)
        {
            return new SdkException("validation_error", message);
        }

        private static bool TrySplitLocation(string location, out string filename, out int sourceLine)
        {
            filename = string.Empty;
            sourceLine = 0;
            var separator = location.LastIndexOf(':');
            if (separator <= 0 || separator == location.Length - 1)
            {
                return false;
            }

            if (!TryParsePositiveInteger(location, separator + 1, out sourceLine))
            {
                return false;
            }

            try
            {
                filename = SanitizeFilename(location.Substring(0, separator));
                return true;
            }
            catch (SdkException)
            {
                filename = string.Empty;
                sourceLine = 0;
                return false;
            }
        }

        private static string NormalizeUnityFunction(string value)
        {
            var normalized = value.Trim();
            if (normalized.StartsWith("at ", StringComparison.Ordinal))
            {
                normalized = normalized.Substring(3).Trim();
            }

            var parameters = normalized.IndexOf(" (", StringComparison.Ordinal);
            if (parameters > 0)
            {
                normalized = normalized.Substring(0, parameters).Trim();
            }

            return normalized;
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
                return RequireText("issue breadcrumb data value for " + key, text, MaxBreadcrumbDataString, false);
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
            if (normalized.Length == 0 || normalized.Length > maximum || !IsAsciiLetter(normalized[0]))
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
                || (rejectLocationText && (ContainsCharacter(normalized, '?') || ContainsCharacter(normalized, '#'))))
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
            while (normalized.Length > 1 && normalized[normalized.Length - 1] == '/')
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

        private static int IndexOfCharacter(string value, char expected)
        {
            for (var index = 0; index < value.Length; index++)
            {
                if (value[index] == expected)
                {
                    return index;
                }
            }

            return -1;
        }

        private static bool ContainsCharacter(string value, char expected)
        {
            return IndexOfCharacter(value, expected) >= 0;
        }

        private static bool TryParsePositiveInteger(string value, int start, out int parsed)
        {
            parsed = 0;
            if (start < 0 || start >= value.Length)
            {
                return false;
            }

            for (var index = start; index < value.Length; index++)
            {
                var character = value[index];
                if (!IsAsciiDigit(character))
                {
                    return false;
                }

                var digit = character - '0';
                if (parsed > (int.MaxValue - digit) / 10)
                {
                    return false;
                }

                parsed = (parsed * 10) + digit;
            }

            return parsed > 0;
        }

        private static SdkException BreadcrumbPrimitiveError(string key)
        {
            return Validation("issue breadcrumb data value for " + key + " must be a finite primitive");
        }
    }
}
