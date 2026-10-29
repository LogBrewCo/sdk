package co.logbrew.sdk;

import java.time.Duration;

/**
 * Stable transport response returned from flush and shutdown operations.
 */
public final class TransportResponse {
    private final int statusCode;
    private final int attempts;
    private final int batches;
    private final int acceptedEvents;
    private final RetryAfterDirective retryAfterDirective;
    private final String rateLimitCode;

    /**
     * Creates a response with a final HTTP-like status and attempt count.
     */
    public TransportResponse(int statusCode, int attempts) {
        this(statusCode, attempts, RetryAfterDirective.none(), null);
    }

    /**
     * Creates a response that also carries a {@code 429} response's {@code Retry-After} delay and the
     * {@code code} string from its JSON body, so custom transports can request a timed wait. Either value
     * may be null when the response did not include it.
     */
    public TransportResponse(int statusCode, int attempts, Duration retryAfter, String code) {
        this(statusCode, attempts, rateLimitDirective(retryAfter), code);
    }

    TransportResponse(int statusCode, int attempts, RetryAfterDirective retryAfterDirective) {
        this(statusCode, attempts, retryAfterDirective, null);
    }

    TransportResponse(int statusCode, int attempts, RetryAfterDirective retryAfterDirective, String code) {
        this(
            statusCode,
            attempts,
            statusCode >= 200 && statusCode < 300 && attempts > 0 ? 1 : 0,
            0,
            retryAfterDirective,
            code
        );
    }

    /**
     * Creates a response with aggregate delivery accounting.
     */
    TransportResponse(int statusCode, int attempts, int batches, int acceptedEvents) {
        this(statusCode, attempts, batches, acceptedEvents, RetryAfterDirective.none(), null);
    }

    private TransportResponse(
        int statusCode,
        int attempts,
        int batches,
        int acceptedEvents,
        RetryAfterDirective retryAfterDirective,
        String rateLimitCode
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
        this.rateLimitCode = rateLimitCode;
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

    String rateLimitCode() {
        return rateLimitCode;
    }

    private static RetryAfterDirective rateLimitDirective(Duration retryAfter) {
        if (retryAfter == null) {
            return RetryAfterDirective.none();
        }
        if (retryAfter.isNegative()) {
            throw new IllegalArgumentException("retry delay must be non-negative");
        }
        Duration maximum = AutomaticDeliveryOptions.MAX_SCHEDULE_DELAY;
        return RetryAfterDirective.accepted((retryAfter.compareTo(maximum) > 0 ? maximum : retryAfter).toMillis());
    }
}
