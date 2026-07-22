package co.logbrew.sdk;

import java.time.Duration;
import java.util.Objects;

/**
 * Immutable scheduling bounds for explicit client-owned automatic delivery.
 */
public final class AutomaticDeliveryOptions {
    /** Largest supported interval or retry delay for one scheduler wake. */
    public static final Duration MAX_SCHEDULE_DELAY = Duration.ofHours(1);
    /** Default delay before a non-threshold automatic flush. */
    public static final Duration DEFAULT_FLUSH_INTERVAL = Duration.ofSeconds(5);
    /** Default queued event count that requests an immediate automatic flush. */
    public static final int DEFAULT_QUEUE_THRESHOLD = 100;
    /** Default initial scheduler-level retry delay. */
    public static final Duration DEFAULT_INITIAL_RETRY_DELAY = Duration.ofMillis(250);
    /** Default maximum scheduler-level retry delay. */
    public static final Duration DEFAULT_MAX_RETRY_DELAY = Duration.ofSeconds(30);
    /** Default scheduler-level retry count after an exhausted flush. */
    public static final int DEFAULT_MAX_RETRY_ATTEMPTS = 5;
    /** Largest supported scheduler-level retry count after an exhausted flush. */
    public static final int MAX_RETRY_ATTEMPTS = 100;

    private final Duration flushInterval;
    private final int queueThreshold;
    private final Duration initialRetryDelay;
    private final Duration maxRetryDelay;
    private final int maxRetryAttempts;

    private AutomaticDeliveryOptions(Builder builder) {
        this.flushInterval = builder.flushInterval;
        this.queueThreshold = builder.queueThreshold;
        this.initialRetryDelay = builder.initialRetryDelay;
        this.maxRetryDelay = builder.maxRetryDelay;
        this.maxRetryAttempts = builder.maxRetryAttempts;
    }

    /** Returns a builder initialized with bounded production defaults. */
    public static Builder builder() {
        return new Builder();
    }

    /** Returns the maximum interval before queued work requests delivery. */
    public Duration flushInterval() {
        return flushInterval;
    }

    /** Returns the queued event count that requests immediate delivery. */
    public int queueThreshold() {
        return queueThreshold;
    }

    /** Returns the initial delay before retrying an exhausted automatic flush. */
    public Duration initialRetryDelay() {
        return initialRetryDelay;
    }

    /** Returns the maximum delay before retrying an exhausted automatic flush. */
    public Duration maxRetryDelay() {
        return maxRetryDelay;
    }

    /** Returns the scheduler-level retry count after an exhausted automatic flush. */
    public int maxRetryAttempts() {
        return maxRetryAttempts;
    }

    long flushIntervalMillis() {
        return flushInterval.toMillis();
    }

    long initialRetryDelayMillis() {
        return initialRetryDelay.toMillis();
    }

    long maxRetryDelayMillis() {
        return maxRetryDelay.toMillis();
    }

    /** Builder for explicit automatic-delivery scheduling bounds. */
    public static final class Builder {
        private Duration flushInterval = DEFAULT_FLUSH_INTERVAL;
        private int queueThreshold = DEFAULT_QUEUE_THRESHOLD;
        private Duration initialRetryDelay = DEFAULT_INITIAL_RETRY_DELAY;
        private Duration maxRetryDelay = DEFAULT_MAX_RETRY_DELAY;
        private int maxRetryAttempts = DEFAULT_MAX_RETRY_ATTEMPTS;

        private Builder() {
        }

        /** Sets the maximum interval before queued work requests delivery. */
        public Builder flushInterval(Duration value) {
            this.flushInterval = Objects.requireNonNull(value, "flushInterval");
            return this;
        }

        /** Sets the queued event count that requests immediate delivery. */
        public Builder queueThreshold(int value) {
            this.queueThreshold = value;
            return this;
        }

        /** Sets the initial delay before retrying an exhausted automatic flush. */
        public Builder initialRetryDelay(Duration value) {
            this.initialRetryDelay = Objects.requireNonNull(value, "initialRetryDelay");
            return this;
        }

        /** Sets the maximum delay before retrying an exhausted automatic flush. */
        public Builder maxRetryDelay(Duration value) {
            this.maxRetryDelay = Objects.requireNonNull(value, "maxRetryDelay");
            return this;
        }

        /** Sets the scheduler-level retry count after an exhausted automatic flush. */
        public Builder maxRetryAttempts(int value) {
            this.maxRetryAttempts = value;
            return this;
        }

        /** Builds validated immutable automatic-delivery options. */
        public AutomaticDeliveryOptions build() {
            long intervalMillis;
            try {
                intervalMillis = flushInterval.toMillis();
            } catch (ArithmeticException error) {
                throw new SdkException("validation_error", "flush_interval is too large");
            }
            if (flushInterval.isNegative() || flushInterval.isZero() || intervalMillis <= 0L) {
                throw new SdkException("validation_error", "flush_interval must be at least one millisecond");
            }
            if (flushInterval.compareTo(MAX_SCHEDULE_DELAY) > 0) {
                throw new SdkException("validation_error", "flush_interval exceeds the supported maximum");
            }
            long initialRetryMillis = requirePositiveMillis("initial_retry_delay", initialRetryDelay);
            long maxRetryMillis = requirePositiveMillis("max_retry_delay", maxRetryDelay);
            if (initialRetryDelay.compareTo(MAX_SCHEDULE_DELAY) > 0
                || maxRetryDelay.compareTo(MAX_SCHEDULE_DELAY) > 0) {
                throw new SdkException("validation_error", "retry delay exceeds the supported maximum");
            }
            if (queueThreshold <= 0) {
                throw new SdkException("validation_error", "queue_threshold must be positive");
            }
            if (initialRetryMillis > maxRetryMillis) {
                throw new SdkException(
                    "validation_error",
                    "initial_retry_delay must not exceed max_retry_delay"
                );
            }
            if (maxRetryAttempts < 0) {
                throw new SdkException("validation_error", "max_retry_attempts must be non-negative");
            }
            if (maxRetryAttempts > MAX_RETRY_ATTEMPTS) {
                throw new SdkException("validation_error", "max_retry_attempts exceeds the supported maximum");
            }
            return new AutomaticDeliveryOptions(this);
        }

        private static long requirePositiveMillis(String name, Duration value) {
            long millis;
            try {
                millis = value.toMillis();
            } catch (ArithmeticException error) {
                throw new SdkException("validation_error", name + " is too large");
            }
            if (value.isNegative() || value.isZero() || millis <= 0L) {
                throw new SdkException("validation_error", name + " must be at least one millisecond");
            }
            return millis;
        }
    }
}
