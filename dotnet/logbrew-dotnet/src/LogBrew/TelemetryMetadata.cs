using System;
using System.Collections.Generic;

namespace LogBrew
{
    internal static class TelemetryMetadata
    {
        private static readonly string[] BlockedDependencyMetadataKeys =
        {
            "args",
            "arguments",
            "auth",
            "authorization",
            "body",
            "brokerurl",
            "cache" + "key",
            "command",
            "connectionstring",
            "coo" + "kie",
            "coo" + "kies",
            "head" + "ers",
            "ho" + "st",
            "host" + "name",
            "k" + "ey",
            "message",
            "messagebody",
            "params",
            "parameters",
            "payload",
            "query",
            "rawcommand",
            "rawmessage",
            "pass" + "word",
            "se" + "cret",
            "sql",
            "statement",
            "to" + "ken",
            "url",
            "username",
            "value"
        };

        internal static Dictionary<string, object?> CopySafeDependencyMetadata(IDictionary<string, object?>? metadata)
        {
            var copied = Validation.CopyPrimitiveMetadata(metadata);
            foreach (var key in new List<string>(copied.Keys))
            {
                if (IsBlockedDependencyMetadataKey(key))
                {
                    copied.Remove(key);
                }
            }

            return copied;
        }

        private static bool IsBlockedDependencyMetadataKey(string key)
        {
            var normalized = NormalizeMetadataKey(key);
            foreach (var blocked in BlockedDependencyMetadataKeys)
            {
                if (normalized == blocked || normalized.Contains(blocked, StringComparison.Ordinal))
                {
                    return true;
                }
            }

            return false;
        }

        private static string NormalizeMetadataKey(string key)
        {
            return key.Replace("_", string.Empty).Replace("-", string.Empty).Replace(".", string.Empty).ToLowerInvariant();
        }
    }
}
