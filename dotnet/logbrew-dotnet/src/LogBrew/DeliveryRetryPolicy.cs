using System;

namespace LogBrew
{
    internal sealed class DeliveryRetryPolicy
    {
        private static readonly TimeSpan MinimumRateLimitWait = TimeSpan.FromSeconds(1);
        private static readonly TimeSpan MaximumRateLimitWait = TimeSpan.FromHours(1);
        private readonly Random random = new Random();

        internal TimeSpan Delay(
            TimeSpan? serverDelay,
            int attempt,
            AutomaticDeliverySettings settings,
            out DeliveryRetrySource source)
        {
            var maximum = settings.MaxRetryDelay;
            var exponent = Math.Min(attempt - 1, 30);
            var multiplier = 1L << exponent;
            var baseTicks = settings.RetryBaseDelay.Ticks;
            var cappedTicks = baseTicks > maximum.Ticks / multiplier
                ? maximum.Ticks
                : Math.Min(maximum.Ticks, baseTicks * multiplier);
            var minimumTicks = cappedTicks / 2;
            var localTicks = minimumTicks + (long)((cappedTicks - minimumTicks) * random.NextDouble());
            var selectedTicks = localTicks;
            source = DeliveryRetrySource.Local;
            if (serverDelay > TimeSpan.Zero)
            {
                var serverTicks = Math.Min(serverDelay.Value.Ticks, maximum.Ticks);
                if (serverTicks > selectedTicks)
                {
                    selectedTicks = serverTicks;
                    source = DeliveryRetrySource.Server;
                }
            }

            return TimeSpan.FromTicks(selectedTicks);
        }

        // A 429 waits on its own when it has Retry-After or code "rate_limited", unless the usage limit was hit.
        internal static bool IsTimedRateLimit(TransportResponse response)
        {
            return response.StatusCode == 429
                && !string.Equals(response.Code, "usage_limit_exceeded", StringComparison.Ordinal)
                && (response.RetryAfter.HasValue || string.Equals(response.Code, "rate_limited", StringComparison.Ordinal));
        }

        internal TimeSpan RateLimitDelay(
            TimeSpan? retryAfter,
            int consecutiveFailures,
            AutomaticDeliverySettings settings,
            out DeliveryRetrySource source)
        {
            var delay = retryAfter ?? Delay(null, consecutiveFailures, settings, out _);
            source = retryAfter.HasValue ? DeliveryRetrySource.Server : DeliveryRetrySource.Local;
            var ticks = Math.Min(Math.Max(delay.Ticks, MinimumRateLimitWait.Ticks), MaximumRateLimitWait.Ticks);
            ticks += (long)(ticks / 10 * random.NextDouble());
            return TimeSpan.FromTicks(Math.Min(ticks, MaximumRateLimitWait.Ticks));
        }

        internal static bool IsRetryableStatus(int statusCode)
        {
            return statusCode == 408 || (statusCode >= 500 && statusCode <= 599);
        }

        internal static DeliveryPauseReason PauseReason(int statusCode)
        {
            if (statusCode == 401 || statusCode == 403)
            {
                return DeliveryPauseReason.Authentication;
            }

            if (statusCode == 429)
            {
                return DeliveryPauseReason.Quota;
            }

            return statusCode >= 400 && statusCode < 500
                ? DeliveryPauseReason.Validation
                : DeliveryPauseReason.NonRetryable;
        }

        internal static DeliveryStatusClass StatusClass(int statusCode)
        {
            if (statusCode >= 200 && statusCode < 300)
            {
                return DeliveryStatusClass.Success;
            }

            if (statusCode >= 400 && statusCode < 500)
            {
                return DeliveryStatusClass.ClientError;
            }

            return statusCode >= 500 && statusCode <= 599
                ? DeliveryStatusClass.ServerError
                : DeliveryStatusClass.None;
        }

        internal static int BoundedMilliseconds(TimeSpan delay)
        {
            return delay.TotalMilliseconds >= int.MaxValue
                ? int.MaxValue
                : (int)Math.Ceiling(delay.TotalMilliseconds);
        }
    }

    internal sealed class AutomaticDeliverySettings
    {
        internal AutomaticDeliverySettings(
            TimeSpan flushInterval,
            int flushAtQueueSize,
            int maxQueueSize,
            int maxQueueBytes,
            int maxRetries,
            TimeSpan retryBaseDelay,
            TimeSpan maxRetryDelay)
        {
            FlushInterval = flushInterval;
            FlushAtQueueSize = flushAtQueueSize;
            MaxQueueSize = maxQueueSize;
            MaxQueueBytes = maxQueueBytes;
            MaxRetries = maxRetries;
            RetryBaseDelay = retryBaseDelay;
            MaxRetryDelay = maxRetryDelay;
        }

        internal TimeSpan FlushInterval { get; }

        internal int FlushAtQueueSize { get; }

        internal int MaxQueueSize { get; }

        internal int MaxQueueBytes { get; }

        internal int MaxRetries { get; }

        internal TimeSpan RetryBaseDelay { get; }

        internal TimeSpan MaxRetryDelay { get; }
    }
}
