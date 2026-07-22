package co.logbrew.sdk;

/**
 * Stable transport response returned from flush and shutdown operations.
 */
public final class TransportResponse {
    private final int statusCode;
    private final int attempts;
    private final int batches;
    private final int acceptedEvents;
    private final RetryAfterDirective retryAfterDirective;

    /**
     * Creates a response with a final HTTP-like status and attempt count.
     */
    public TransportResponse(int statusCode, int attempts) {
        this(
            statusCode,
            attempts,
            statusCode >= 200 && statusCode < 300 && attempts > 0 ? 1 : 0,
            0,
            RetryAfterDirective.none()
        );
    }

    TransportResponse(int statusCode, int attempts, RetryAfterDirective retryAfterDirective) {
        this(
            statusCode,
            attempts,
            statusCode >= 200 && statusCode < 300 && attempts > 0 ? 1 : 0,
            0,
            retryAfterDirective
        );
    }

    /**
     * Creates a response with aggregate delivery accounting.
     */
    TransportResponse(int statusCode, int attempts, int batches, int acceptedEvents) {
        this(statusCode, attempts, batches, acceptedEvents, RetryAfterDirective.none());
    }

    private TransportResponse(
        int statusCode,
        int attempts,
        int batches,
        int acceptedEvents,
        RetryAfterDirective retryAfterDirective
    ) {
        if (attempts < 0 || batches < 0 || acceptedEvents < 0) {
            throw new IllegalArgumentException("delivery accounting values must be non-negative");
        }
        this.statusCode = statusCode;
        this.attempts = attempts;
        this.batches = batches;
        this.acceptedEvents = acceptedEvents;
        this.retryAfterDirective = retryAfterDirective == null
            ? RetryAfterDirective.none()
            : retryAfterDirective;
    }

    /**
     * Returns the final HTTP-like status returned by the transport.
     */
    public int statusCode() {
        return statusCode;
    }

    /**
     * Returns the number of transport attempts used for the flush.
     */
    public int attempts() {
        return attempts;
    }

    /**
     * Returns the number of accepted request batches.
     */
    public int batches() {
        return batches;
    }

    /**
     * Returns the number of events acknowledged by accepted request batches.
     */
    public int acceptedEvents() {
        return acceptedEvents;
    }

    RetryAfterDirective retryAfterDirective() {
        return retryAfterDirective;
    }
}
