using System;
using System.Diagnostics;
using System.Globalization;
using System.Threading;

namespace LogBrew
{
    internal static class DeliveryRuntimePolicy
    {
        internal static TransportResponse SendManualBatch(
            string apiKey,
            ITransport transport,
            string body,
            int maxRetries)
        {
            var attempt = 0;
            while (true)
            {
                attempt++;
                try
                {
                    var response = transport.Send(apiKey, body);
                    if (response.StatusCode >= 200 && response.StatusCode < 300)
                    {
                        return new TransportResponse(response.StatusCode, attempt);
                    }

                    if (DeliveryRetryPolicy.IsRetryableStatus(response.StatusCode) && attempt <= maxRetries)
                    {
                        continue;
                    }

                    throw StatusException(response.StatusCode);
                }
                catch (TransportException error)
                {
                    if (error.Retryable && attempt <= maxRetries)
                    {
                        continue;
                    }

                    throw new SdkException(error.Code, error.Message);
                }
            }
        }

        internal static int CurrentProcessId()
        {
            using var process = Process.GetCurrentProcess();
            return process.Id;
        }

        internal static void RequireOwnerProcess(int ownerProcessId)
        {
            if (CurrentProcessId() != ownerProcessId)
            {
                throw new SdkException("process_error", "client belongs to another process; create a fresh client after fork");
            }
        }

        internal static long AddMonotonicDelay(TimeSpan delay)
        {
            var delta = delay.TotalSeconds * Stopwatch.Frequency;
            var now = Stopwatch.GetTimestamp();
            if (delta >= long.MaxValue - now)
            {
                return long.MaxValue;
            }

            return now + (long)delta;
        }

        internal static bool IsMonotonicDue(long timestamp)
        {
            return timestamp != 0 && Stopwatch.GetTimestamp() >= timestamp;
        }

        internal static TimeSpan RemainingMonotonicDelay(long timestamp)
        {
            if (timestamp == 0)
            {
                return TimeSpan.FromMilliseconds(100);
            }

            var remaining = timestamp - Stopwatch.GetTimestamp();
            if (remaining <= 0)
            {
                return TimeSpan.Zero;
            }

            var maximumMonitorWait = TimeSpan.FromMilliseconds(int.MaxValue - 1D);
            var remainingSeconds = (double)remaining / Stopwatch.Frequency;
            return remainingSeconds >= maximumMonitorWait.TotalSeconds
                ? maximumMonitorWait
                : TimeSpan.FromSeconds(remainingSeconds);
        }

        internal static int SaturatingIncrement(int value)
        {
            return value == int.MaxValue ? value : value + 1;
        }

        internal static long SaturatingIncrement(long value)
        {
            return value == long.MaxValue ? value : value + 1;
        }

        internal static long SaturatingAdd(long value, int increment)
        {
            return value > long.MaxValue - increment ? long.MaxValue : value + increment;
        }

        internal static void JoinWorker(Thread? thread)
        {
            if (thread != null && thread.IsAlive)
            {
                thread.Join();
            }
        }

        internal static ITransport RequireAutomaticTransport(ITransport? transport)
        {
            return transport ?? throw new SdkException("configuration_error", "client does not own automatic delivery");
        }

        private static SdkException StatusException(int statusCode)
        {
            if (statusCode == 401 || statusCode == 403)
            {
                return new SdkException("unauthenticated", "transport rejected the API key");
            }

            return new SdkException(
                "transport_error",
                "unexpected transport status " + statusCode.ToString(CultureInfo.InvariantCulture));
        }
    }
}
