using System;

namespace LogBrew
{
    internal static class TextSearch
    {
        internal static bool Contains(string source, char value)
        {
#if NET8_0_OR_GREATER
            return source.Contains(value);
#else
            return source.IndexOf(value) >= 0;
#endif
        }

        internal static bool Contains(string source, string value, StringComparison comparison)
        {
#if NET8_0_OR_GREATER
            return source.Contains(value, comparison);
#else
            return source.IndexOf(value, comparison) >= 0;
#endif
        }

        internal static bool StartsWith(string source, char value)
        {
#if NET8_0_OR_GREATER
            return source.StartsWith(value);
#else
            return source.StartsWith(value.ToString(), StringComparison.Ordinal);
#endif
        }

        internal static bool EndsWith(string source, char value)
        {
#if NET8_0_OR_GREATER
            return source.EndsWith(value);
#else
            return source.EndsWith(value.ToString(), StringComparison.Ordinal);
#endif
        }
    }
}
