package co.logbrew.sdk;

/** Content-free transport outcome observation for automatic delivery. */
final class AutomaticDeliveryTransport implements Transport {
    enum FailureKind {
        NONE,
        RETRYABLE,
        RATE_LIMITED,
        AUTHENTICATION,
        QUOTA,
        NON_RETRYABLE
    }

    private final Transport delegate;
    private FailureKind failureKind = FailureKind.NON_RETRYABLE;
    private RetryAfterDirective retryAfterDirective = RetryAfterDirective.none();
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
            boolean timed = failureKind == FailureKind.RETRYABLE || failureKind == FailureKind.RATE_LIMITED;
            retryAfterDirective = timed && response != null
                ? response.retryAfterDirective()
                : RetryAfterDirective.none();
            return response;
        } catch (TransportException error) {
            failureKind = error.retryable() ? FailureKind.RETRYABLE : FailureKind.NON_RETRYABLE;
            retryAfterDirective = RetryAfterDirective.none();
            throw error;
        }
    }

    FailureKind failureKind() {
        return failureKind;
    }

    long attempts() {
        return attempts;
    }

    RetryAfterDirective retryAfterDirective() {
        return retryAfterDirective;
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
            String code = response.rateLimitCode();
            boolean timed = !"usage_limit_exceeded".equals(code)
                && ("rate_limited".equals(code)
                    || response.retryAfterDirective().outcome() == RetryAfterDirective.Outcome.ACCEPTED);
            return timed ? FailureKind.RATE_LIMITED : FailureKind.QUOTA;
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
