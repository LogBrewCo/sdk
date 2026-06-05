package co.logbrew.sdk;

import java.util.Objects;

/**
 * Transport-layer failure with a stable public code and retry hint.
 */
public final class TransportException extends Exception {
    private static final long serialVersionUID = 1L;

    private final String code;
    private final boolean retryable;

    /**
     * Creates a transport failure.
     */
    public TransportException(String code, String message, boolean retryable) {
        super(Objects.requireNonNull(message, "message"));
        this.code = Objects.requireNonNull(code, "code");
        this.retryable = retryable;
    }

    /**
     * Creates a retryable network failure.
     */
    public static TransportException network(String message) {
        return new TransportException("network_failure", message, true);
    }

    /**
     * Returns the stable machine-readable error code.
     */
    public String code() {
        return code;
    }

    /**
     * Returns true when the SDK may retry the failed send.
     */
    public boolean retryable() {
        return retryable;
    }
}
