package co.logbrew.sdk;

/** Bounded, content-free Retry-After interpretation retained inside built-in delivery. */
final class RetryAfterDirective {
    enum Outcome {
        NONE,
        ACCEPTED,
        REJECTED
    }

    private static final RetryAfterDirective NONE = new RetryAfterDirective(Outcome.NONE, 0L);
    private static final RetryAfterDirective REJECTED = new RetryAfterDirective(Outcome.REJECTED, 0L);

    private final Outcome outcome;
    private final long delayMillis;

    private RetryAfterDirective(Outcome outcome, long delayMillis) {
        this.outcome = outcome;
        this.delayMillis = delayMillis;
    }

    static RetryAfterDirective none() {
        return NONE;
    }

    static RetryAfterDirective accepted(long delayMillis) {
        if (delayMillis < 0L) {
            throw new IllegalArgumentException("retry delay must be non-negative");
        }
        return new RetryAfterDirective(Outcome.ACCEPTED, delayMillis);
    }

    static RetryAfterDirective rejected() {
        return REJECTED;
    }

    Outcome outcome() {
        return outcome;
    }

    long delayMillis() {
        return delayMillis;
    }
}
