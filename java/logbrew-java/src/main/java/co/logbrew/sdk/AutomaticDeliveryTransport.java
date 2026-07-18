package co.logbrew.sdk;

/** Content-free transport outcome observation for automatic delivery. */
final class AutomaticDeliveryTransport implements Transport {
    enum FailureKind {
        NONE,
        RETRYABLE,
        AUTHENTICATION,
        QUOTA,
        NON_RETRYABLE
    }

    private final Transport delegate;
    private FailureKind failureKind = FailureKind.NON_RETRYABLE;
    private long attempts;

    AutomaticDeliveryTransport(Transport delegate) {
        this.delegate = delegate;
    }

    @Override
    public TransportResponse send(String apiKey, String body) throws TransportException {
        attempts = saturatedAdd(attempts, 1L);
        try {
            TransportResponse response = delegate.send(apiKey, body);
            failureKind = classify(response);
            return response;
        } catch (TransportException error) {
            failureKind = error.retryable() ? FailureKind.RETRYABLE : FailureKind.NON_RETRYABLE;
            throw error;
        }
    }

    FailureKind failureKind() {
        return failureKind;
    }

    long attempts() {
        return attempts;
    }

    private static FailureKind classify(TransportResponse response) {
        if (response == null) {
            return FailureKind.NON_RETRYABLE;
        }
        int status = response.statusCode();
        if (status >= 200 && status < 300) {
            return FailureKind.NONE;
        }
        if (status == 401) {
            return FailureKind.AUTHENTICATION;
        }
        if (status == 429) {
            return FailureKind.QUOTA;
        }
        if (status == 408 || status >= 500) {
            return FailureKind.RETRYABLE;
        }
        return FailureKind.NON_RETRYABLE;
    }

    private static long saturatedAdd(long left, long right) {
        return right > Long.MAX_VALUE - left ? Long.MAX_VALUE : left + right;
    }
}
