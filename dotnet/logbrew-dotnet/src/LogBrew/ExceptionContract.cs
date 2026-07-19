using System;

namespace LogBrew
{
    internal static class ExceptionContract
    {
        internal static void ThrowIfNull(object? value, string parameterName)
        {
#if NET8_0_OR_GREATER
            ArgumentNullException.ThrowIfNull(value, parameterName);
#else
            if (value == null)
            {
                throw new ArgumentNullException(parameterName);
            }
#endif
        }

        internal static void ThrowIfDisposed(bool disposed, string objectName)
        {
            if (!disposed)
            {
                return;
            }

            ThrowObjectDisposedWithLegacyName(objectName);
        }

        // Framework ThrowIf overloads derive a type name and cannot preserve this public exception contract.
        private static void ThrowObjectDisposedWithLegacyName(string objectName)
        {
            throw new ObjectDisposedException(objectName);
        }
    }
}
