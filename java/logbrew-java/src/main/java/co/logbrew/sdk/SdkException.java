package co.logbrew.sdk;

import java.util.Objects;

/**
 * Stable public SDK failure with a parseable code and message.
 */
public final class SdkException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    private final String code;
    private final String detailMessage;

    /**
     * Creates a public SDK exception.
     */
    public SdkException(String code, String message) {
        super(Objects.requireNonNull(code, "code") + ": " + Objects.requireNonNull(message, "message"));
        this.code = code;
        this.detailMessage = message;
    }

    /**
     * Returns the stable machine-readable error code.
     */
    public String code() {
        return code;
    }

    /**
     * Returns the human-readable error message without the code prefix.
     */
    public String detailMessage() {
        return detailMessage;
    }
}
