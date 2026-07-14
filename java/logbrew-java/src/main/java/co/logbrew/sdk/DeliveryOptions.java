package co.logbrew.sdk;

/**
 * Immutable in-memory delivery bounds for {@link LogBrewClient}.
 *
 * <p>Delivery remains caller-driven: these options do not create timers, threads, or persistent
 * storage.</p>
 */
public final class DeliveryOptions {
    /** Default retry count after the first transport attempt. */
    public static final int DEFAULT_MAX_RETRIES = 2;
    /** Default maximum number of queued events. */
    public static final int DEFAULT_MAX_QUEUE_EVENTS = 1000;
    /** Default maximum serialized event bytes retained in memory. */
    public static final long DEFAULT_MAX_QUEUE_BYTES = 4L * 1024L * 1024L;
    /** Default maximum number of events in one request. */
    public static final int DEFAULT_MAX_BATCH_EVENTS = 100;
    /** Default maximum UTF-8 bytes in one serialized request. */
    public static final int DEFAULT_MAX_BATCH_BYTES = 512 * 1024;

    private final int maxRetries;
    private final int maxQueueEvents;
    private final long maxQueueBytes;
    private final int maxBatchEvents;
    private final int maxBatchBytes;
    private final LogBrewClient.EventDroppedHandler eventDroppedHandler;

    private DeliveryOptions(Builder builder) {
        this.maxRetries = builder.maxRetries;
        this.maxQueueEvents = builder.maxQueueEvents;
        this.maxQueueBytes = builder.maxQueueBytes;
        this.maxBatchEvents = builder.maxBatchEvents;
        this.maxBatchBytes = builder.maxBatchBytes;
        this.eventDroppedHandler = builder.eventDroppedHandler;
    }

    /**
     * Returns a builder initialized with bounded production defaults.
     */
    public static Builder builder() {
        return new Builder();
    }

    /** Returns the number of retries after the first transport attempt. */
    public int maxRetries() {
        return maxRetries;
    }

    /** Returns the maximum number of queued events. */
    public int maxQueueEvents() {
        return maxQueueEvents;
    }

    /** Returns the maximum serialized event bytes retained in memory. */
    public long maxQueueBytes() {
        return maxQueueBytes;
    }

    /** Returns the maximum number of events sent in one request. */
    public int maxBatchEvents() {
        return maxBatchEvents;
    }

    /** Returns the maximum UTF-8 bytes sent in one serialized request. */
    public int maxBatchBytes() {
        return maxBatchBytes;
    }

    LogBrewClient.EventDroppedHandler eventDroppedHandler() {
        return eventDroppedHandler;
    }

    /**
     * Builder for explicit delivery bounds.
     */
    public static final class Builder {
        private int maxRetries = DEFAULT_MAX_RETRIES;
        private int maxQueueEvents = DEFAULT_MAX_QUEUE_EVENTS;
        private long maxQueueBytes = DEFAULT_MAX_QUEUE_BYTES;
        private int maxBatchEvents = DEFAULT_MAX_BATCH_EVENTS;
        private int maxBatchBytes = DEFAULT_MAX_BATCH_BYTES;
        private LogBrewClient.EventDroppedHandler eventDroppedHandler;

        private Builder() {
        }

        /** Sets the number of retries after the first transport attempt. */
        public Builder maxRetries(int value) {
            this.maxRetries = value;
            return this;
        }

        /** Sets the maximum number of queued events. */
        public Builder maxQueueEvents(int value) {
            this.maxQueueEvents = value;
            return this;
        }

        /** Sets the maximum serialized event bytes retained in memory. */
        public Builder maxQueueBytes(long value) {
            this.maxQueueBytes = value;
            return this;
        }

        /** Sets the maximum number of events sent in one request. */
        public Builder maxBatchEvents(int value) {
            this.maxBatchEvents = value;
            return this;
        }

        /** Sets the maximum UTF-8 bytes sent in one serialized request. */
        public Builder maxBatchBytes(int value) {
            this.maxBatchBytes = value;
            return this;
        }

        /** Sets an advisory callback for events rejected before queueing. */
        public Builder onEventDropped(LogBrewClient.EventDroppedHandler value) {
            this.eventDroppedHandler = value;
            return this;
        }

        /** Builds validated immutable delivery options. */
        public DeliveryOptions build() {
            if (maxRetries < 0) {
                throw new SdkException("validation_error", "max_retries must be non-negative");
            }
            if (maxQueueEvents <= 0) {
                throw new SdkException("validation_error", "max_queue_events must be positive");
            }
            if (maxQueueBytes <= 0L) {
                throw new SdkException("validation_error", "max_queue_bytes must be positive");
            }
            if (maxBatchEvents <= 0) {
                throw new SdkException("validation_error", "max_batch_events must be positive");
            }
            if (maxBatchBytes <= 0) {
                throw new SdkException("validation_error", "max_batch_bytes must be positive");
            }
            return new DeliveryOptions(this);
        }
    }
}
