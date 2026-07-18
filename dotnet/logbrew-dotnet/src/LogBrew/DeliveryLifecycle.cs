using System;

namespace LogBrew
{
    public enum DeliveryLifecycleState
    {
        Manual = 0,
        Running = 1,
        Paused = 2,
        Closing = 3,
        Closed = 4,
    }

    public enum DeliveryActivityState
    {
        Idle = 0,
        Scheduled = 1,
        Sending = 2,
        Retrying = 3,
    }

    public enum DeliveryOutcome
    {
        None = 0,
        Accepted = 1,
        RetryScheduled = 2,
        TerminalFailure = 3,
        RetryExhausted = 4,
        Dropped = 5,
    }

    public enum DeliveryPauseReason
    {
        None = 0,
        Authentication = 1,
        Quota = 2,
        Validation = 3,
        NonRetryable = 4,
        RetryExhausted = 5,
    }

    public enum DeliveryRetrySource
    {
        None = 0,
        Local = 1,
        Server = 2,
    }

    public enum DeliveryStatusClass
    {
        None = 0,
        Success = 1,
        ClientError = 2,
        ServerError = 3,
        Network = 4,
    }

    public sealed class AutomaticDeliveryOptions
    {
        private const int MaximumRetries = 10;

        public TimeSpan FlushInterval { get; set; } = TimeSpan.FromSeconds(5);

        public int FlushAtQueueSize { get; set; } = 100;

        public int MaxQueueSize { get; set; } = 1000;

        public int MaxQueueBytes { get; set; } = 4 * 1024 * 1024;

        public int MaxRetries { get; set; } = 2;

        public TimeSpan RetryBaseDelay { get; set; } = TimeSpan.FromSeconds(1);

        public TimeSpan MaxRetryDelay { get; set; } = TimeSpan.FromSeconds(30);

        internal AutomaticDeliverySettings ValidateAndCopy()
        {
            if (FlushInterval <= TimeSpan.Zero)
            {
                throw new SdkException("validation_error", "automatic flush_interval must be positive");
            }

            if (MaxQueueSize <= 0)
            {
                throw new SdkException("validation_error", "automatic max_queue_size must be positive");
            }

            if (FlushAtQueueSize <= 0 || FlushAtQueueSize > MaxQueueSize)
            {
                throw new SdkException("validation_error", "automatic flush_at_queue_size must be between 1 and max_queue_size");
            }

            if (MaxQueueBytes <= 0)
            {
                throw new SdkException("validation_error", "automatic max_queue_bytes must be positive");
            }

            if (MaxRetries < 0 || MaxRetries > MaximumRetries)
            {
                throw new SdkException("validation_error", "automatic max_retries must be between 0 and 10");
            }

            if (RetryBaseDelay <= TimeSpan.Zero)
            {
                throw new SdkException("validation_error", "automatic retry_base_delay must be positive");
            }

            if (MaxRetryDelay < RetryBaseDelay)
            {
                throw new SdkException("validation_error", "automatic max_retry_delay must be at least retry_base_delay");
            }

            return new AutomaticDeliverySettings(
                FlushInterval,
                FlushAtQueueSize,
                MaxQueueSize,
                MaxQueueBytes,
                MaxRetries,
                RetryBaseDelay,
                MaxRetryDelay);
        }
    }

    public sealed class DeliveryHealthSnapshot
    {
        internal DeliveryHealthSnapshot(
            DeliveryLifecycleState lifecycle,
            DeliveryActivityState activity,
            DeliveryOutcome lastOutcome,
            DeliveryPauseReason pauseReason,
            DeliveryRetrySource retrySource,
            DeliveryStatusClass lastStatusClass,
            int queuedEvents,
            int queuedBytes,
            bool inFlight,
            bool wakePending,
            int retryAttempt,
            int retryDelayMilliseconds,
            int consecutiveFailures,
            long acceptedEvents,
            long acceptedBatches,
            int droppedEvents,
            DateTimeOffset? lastOutcomeAt)
        {
            Lifecycle = lifecycle;
            Activity = activity;
            LastOutcome = lastOutcome;
            PauseReason = pauseReason;
            RetrySource = retrySource;
            LastStatusClass = lastStatusClass;
            QueuedEvents = queuedEvents;
            QueuedBytes = queuedBytes;
            InFlight = inFlight;
            WakePending = wakePending;
            RetryAttempt = retryAttempt;
            RetryDelayMilliseconds = retryDelayMilliseconds;
            ConsecutiveFailures = consecutiveFailures;
            AcceptedEvents = acceptedEvents;
            AcceptedBatches = acceptedBatches;
            DroppedEvents = droppedEvents;
            LastOutcomeAt = lastOutcomeAt;
        }

        public DeliveryLifecycleState Lifecycle { get; }

        public DeliveryActivityState Activity { get; }

        public DeliveryOutcome LastOutcome { get; }

        public DeliveryPauseReason PauseReason { get; }

        public DeliveryRetrySource RetrySource { get; }

        public DeliveryStatusClass LastStatusClass { get; }

        public int QueuedEvents { get; }

        public int QueuedBytes { get; }

        public bool InFlight { get; }

        public bool WakePending { get; }

        public int RetryAttempt { get; }

        public int RetryDelayMilliseconds { get; }

        public int ConsecutiveFailures { get; }

        public long AcceptedEvents { get; }

        public long AcceptedBatches { get; }

        public int DroppedEvents { get; }

        public DateTimeOffset? LastOutcomeAt { get; }
    }

}
