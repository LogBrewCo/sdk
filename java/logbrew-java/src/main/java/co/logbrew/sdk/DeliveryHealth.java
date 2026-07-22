package co.logbrew.sdk;

/**
 * Fixed, content-free snapshot of local delivery state and bounded accounting.
 */
public final class DeliveryHealth {
    /** Client lifecycle states. */
    public enum Lifecycle {
        /** The client accepts capture and delivery calls. */
        OPEN,
        /** An explicit shutdown is draining queued work. */
        CLOSING,
        /** Shutdown completed and later mutation is rejected. */
        CLOSED
    }

    /** Last completed automatic delivery outcome. */
    public enum Outcome {
        /** No automatic delivery has completed. */
        NONE,
        /** The most recent automatic delivery accepted queued work. */
        ACCEPTED,
        /** A queued event was rejected by a configured bound. */
        DROPPED,
        /** The most recent automatic delivery failed and has a scheduled retry. */
        RETRYABLE_FAILURE,
        /** The most recent automatic delivery paused on a terminal outcome. */
        TERMINAL_FAILURE,
        /** The most recent delivery found no remaining work. */
        EMPTY
    }

    /** Current bounded automatic-delivery activity. */
    public enum Activity {
        /** No automatic send or wake is active. */
        IDLE,
        /** An interval or threshold wake is scheduled. */
        SCHEDULED,
        /** One delivery is currently using the owned transport. */
        IN_FLIGHT,
        /** A bounded retry wake is scheduled. */
        RETRYING,
        /** Automatic sends are paused pending explicit recovery. */
        PAUSED
    }

    /** Fixed reason an automatic client paused delivery. */
    public enum PauseReason {
        /** Automatic delivery is not paused. */
        NONE,
        /** The owned transport returned an authentication rejection. */
        AUTHENTICATION,
        /** The owned transport returned a quota or rate rejection. */
        QUOTA,
        /** The owned transport returned a non-retryable outcome. */
        NON_RETRYABLE,
        /** The configured scheduler-level retry budget was exhausted. */
        RETRY_EXHAUSTED,
        /** The client is running in a process other than its owner. */
        PROCESS_OWNERSHIP
    }

    /** Fixed reason the most recent event was rejected before queueing. */
    public enum DropReason {
        /** No event has been rejected. */
        NONE,
        /** The event itself exceeded a configured byte bound. */
        EVENT_TOO_LARGE,
        /** The configured queue count or byte bound was full. */
        QUEUE_OVERFLOW
    }

    /** Fixed source controlling the active bounded retry delay. */
    public enum RetryDelaySource {
        /** No retry wake is active. */
        NONE,
        /** The client equal-jitter safety delay controls the wake. */
        CLIENT,
        /** Valid bounded server guidance controls the wake. */
        SERVER
    }

    private final Lifecycle lifecycle;
    private final Activity activity;
    private final Outcome lastOutcome;
    private final PauseReason pauseReason;
    private final DropReason lastDropReason;
    private final RetryDelaySource retryDelaySource;
    private final boolean automaticDelivery;
    private final boolean inFlight;
    private final boolean wakeCoalesced;
    private final int queuedEvents;
    private final long queuedBytes;
    private final long droppedEvents;
    private final long droppedBytes;
    private final long automaticAttempts;
    private final long transportAttempts;
    private final long acceptedBatches;
    private final long acceptedEvents;
    private final int consecutiveFailures;
    private final long scheduledDelayMillis;
    private final long acceptedServerRetryHints;
    private final long rejectedServerRetryHints;

    DeliveryHealth(
        Lifecycle lifecycle,
        Activity activity,
        Outcome lastOutcome,
        PauseReason pauseReason,
        DropReason lastDropReason,
        RetryDelaySource retryDelaySource,
        boolean automaticDelivery,
        boolean inFlight,
        boolean wakeCoalesced,
        int queuedEvents,
        long queuedBytes,
        long droppedEvents,
        long droppedBytes,
        long automaticAttempts,
        long transportAttempts,
        long acceptedBatches,
        long acceptedEvents,
        int consecutiveFailures,
        long scheduledDelayMillis,
        long acceptedServerRetryHints,
        long rejectedServerRetryHints
    ) {
        this.lifecycle = lifecycle;
        this.activity = activity;
        this.lastOutcome = lastOutcome;
        this.pauseReason = pauseReason;
        this.lastDropReason = lastDropReason;
        this.retryDelaySource = retryDelaySource;
        this.automaticDelivery = automaticDelivery;
        this.inFlight = inFlight;
        this.wakeCoalesced = wakeCoalesced;
        this.queuedEvents = queuedEvents;
        this.queuedBytes = queuedBytes;
        this.droppedEvents = droppedEvents;
        this.droppedBytes = droppedBytes;
        this.automaticAttempts = automaticAttempts;
        this.transportAttempts = transportAttempts;
        this.acceptedBatches = acceptedBatches;
        this.acceptedEvents = acceptedEvents;
        this.consecutiveFailures = consecutiveFailures;
        this.scheduledDelayMillis = scheduledDelayMillis;
        this.acceptedServerRetryHints = acceptedServerRetryHints;
        this.rejectedServerRetryHints = rejectedServerRetryHints;
    }

    /** Returns the client lifecycle state. */
    public Lifecycle lifecycle() {
        return lifecycle;
    }

    /** Returns the current bounded automatic-delivery activity. */
    public Activity activity() {
        return activity;
    }

    /** Returns the last completed automatic delivery outcome. */
    public Outcome lastOutcome() {
        return lastOutcome;
    }

    /** Returns the fixed reason automatic delivery is paused. */
    public PauseReason pauseReason() {
        return pauseReason;
    }

    /** Returns the fixed reason the most recent event was rejected before queueing. */
    public DropReason lastDropReason() {
        return lastDropReason;
    }

    /** Returns the fixed source controlling the active retry wake. */
    public RetryDelaySource retryDelaySource() {
        return retryDelaySource;
    }

    /** Returns whether this client explicitly owns automatic delivery. */
    public boolean automaticDelivery() {
        return automaticDelivery;
    }

    /** Returns whether one owned delivery is currently in flight. */
    public boolean inFlight() {
        return inFlight;
    }

    /** Returns whether one additional wake was coalesced during delivery. */
    public boolean wakeCoalesced() {
        return wakeCoalesced;
    }

    /** Returns the currently queued event count. */
    public int queuedEvents() {
        return queuedEvents;
    }

    /** Returns the currently queued serialized event bytes. */
    public long queuedBytes() {
        return queuedBytes;
    }

    /** Returns the monotonic event-drop count. */
    public long droppedEvents() {
        return droppedEvents;
    }

    /** Returns the monotonic serialized bytes rejected before queueing. */
    public long droppedBytes() {
        return droppedBytes;
    }

    /** Returns the monotonic automatic flush-cycle count. */
    public long automaticAttempts() {
        return automaticAttempts;
    }

    /** Returns the monotonic owned-transport attempt count. */
    public long transportAttempts() {
        return transportAttempts;
    }

    /** Returns the monotonic accepted request-batch count. */
    public long acceptedBatches() {
        return acceptedBatches;
    }

    /** Returns the monotonic accepted event count for automatic delivery. */
    public long acceptedEvents() {
        return acceptedEvents;
    }

    /** Returns consecutive failed automatic flush cycles, saturated at {@link Integer#MAX_VALUE}. */
    public int consecutiveFailures() {
        return consecutiveFailures;
    }

    /** Returns the bounded delay of the active wake, or zero when none is scheduled. */
    public long scheduledDelayMillis() {
        return scheduledDelayMillis;
    }

    /** Returns the monotonic count of valid bounded server retry hints used by this process. */
    public long acceptedServerRetryHints() {
        return acceptedServerRetryHints;
    }

    /** Returns the monotonic count of rejected server retry hints observed by this process. */
    public long rejectedServerRetryHints() {
        return rejectedServerRetryHints;
    }
}
