package co.logbrew.sdk;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.time.format.DateTimeParseException;
import java.time.format.ResolverStyle;
import java.util.List;
import java.util.Locale;
import java.util.Objects;

/** Strict RFC Retry-After parser for the built-in HTTP transport. */
final class RetryAfterParser {
    private static final DateTimeFormatter IMF_FIXDATE = new DateTimeFormatterBuilder()
        .parseCaseSensitive()
        .appendPattern("EEE, dd MMM uuuu HH:mm:ss 'GMT'")
        .toFormatter(Locale.US)
        .withResolverStyle(ResolverStyle.STRICT)
        .withZone(ZoneOffset.UTC);

    private RetryAfterParser() {
    }

    static RetryAfterDirective parse(
        List<String> values,
        Instant now,
        long maximumDelayMillis
    ) {
        Objects.requireNonNull(values, "values");
        Objects.requireNonNull(now, "now");
        if (maximumDelayMillis <= 0L) {
            throw new IllegalArgumentException("maximum retry delay must be positive");
        }
        if (values.isEmpty()) {
            return RetryAfterDirective.none();
        }
        if (values.size() != 1 || values.get(0) == null) {
            return RetryAfterDirective.rejected();
        }

        String value = values.get(0);
        if (isAsciiDigits(value)) {
            return parseDeltaSeconds(value, maximumDelayMillis);
        }
        return parseImfFixdate(value, now, maximumDelayMillis);
    }

    private static RetryAfterDirective parseDeltaSeconds(String value, long maximumDelayMillis) {
        long seconds = 0L;
        for (int index = 0; index < value.length(); index++) {
            int digit = value.charAt(index) - '0';
            if (seconds > (Long.MAX_VALUE - digit) / 10L) {
                return RetryAfterDirective.accepted(maximumDelayMillis);
            }
            seconds = (seconds * 10L) + digit;
        }
        if (seconds > maximumDelayMillis / 1_000L) {
            return RetryAfterDirective.accepted(maximumDelayMillis);
        }
        long delayMillis = seconds * 1_000L;
        return RetryAfterDirective.accepted(Math.min(delayMillis, maximumDelayMillis));
    }

    private static RetryAfterDirective parseImfFixdate(
        String value,
        Instant now,
        long maximumDelayMillis
    ) {
        try {
            LocalDateTime parsed = LocalDateTime.parse(value, IMF_FIXDATE);
            Instant target = parsed.toInstant(ZoneOffset.UTC);
            if (!value.equals(IMF_FIXDATE.format(target))) {
                return RetryAfterDirective.rejected();
            }
            long delayMillis;
            try {
                delayMillis = Duration.between(now, target).toMillis();
            } catch (ArithmeticException error) {
                return RetryAfterDirective.accepted(maximumDelayMillis);
            }
            if (delayMillis <= 0L) {
                return RetryAfterDirective.rejected();
            }
            return RetryAfterDirective.accepted(Math.min(delayMillis, maximumDelayMillis));
        } catch (DateTimeParseException error) {
            return RetryAfterDirective.rejected();
        }
    }

    private static boolean isAsciiDigits(String value) {
        if (value.isEmpty()) {
            return false;
        }
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character < '0' || character > '9') {
                return false;
            }
        }
        return true;
    }
}
