package co.logbrew.sdk;

/**
 * Stable transport response returned from flush and shutdown operations.
 */
public final class TransportResponse {
    private final int statusCode;
    private final int attempts;

    /**
     * Creates a response with a final HTTP-like status and attempt count.
     */
    public TransportResponse(int statusCode, int attempts) {
        this.statusCode = statusCode;
        this.attempts = attempts;
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
}
