using System;

namespace LogBrew
{
    internal static class DeliveryExceptionPolicy
    {
        internal static bool IsFatal(Exception error)
        {
            return error is OutOfMemoryException
                || error is StackOverflowException
                || error is AccessViolationException
                || error is AppDomainUnloadedException
                || error is BadImageFormatException;
        }
    }
}
