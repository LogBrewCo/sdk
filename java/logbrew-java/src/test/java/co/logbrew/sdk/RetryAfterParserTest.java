package co.logbrew.sdk;

import java.time.Instant;
import java.util.Arrays;
import java.util.Collections;

/** Strict Retry-After parsing contracts for built-in HTTP delivery. */
public final class RetryAfterParserTest {
    private static final Instant NOW = Instant.parse("2026-06-02T10:00:00Z");
    private int testsRun;

    public static void main(String[] args) {
        new RetryAfterParserTest().run();
    }

    private void run() {
        testExactDeltaSeconds();
        testExactImfFixdate();
        testMalformedDuplicatePastAndUnsupportedValuesAreRejected();
        testLargeValuesClampWithoutOverflow();
        System.out.println("java Retry-After parser tests ok (" + testsRun + " tests)");
    }

    private void testExactDeltaSeconds() {
        RetryAfterDirective directive = RetryAfterParser.parse(
            Collections.singletonList("120"),
            NOW,
            300_000L
        );
        assertEquals(RetryAfterDirective.Outcome.ACCEPTED, directive.outcome(), "delta outcome");
        assertEquals(120_000L, directive.delayMillis(), "delta delay");
        testsRun++;
    }

    private void testExactImfFixdate() {
        RetryAfterDirective directive = RetryAfterParser.parse(
            Collections.singletonList("Tue, 02 Jun 2026 10:00:05 GMT"),
            NOW,
            300_000L
        );
        assertEquals(RetryAfterDirective.Outcome.ACCEPTED, directive.outcome(), "date outcome");
        assertEquals(5_000L, directive.delayMillis(), "date delay");
        testsRun++;
    }

    private void testMalformedDuplicatePastAndUnsupportedValuesAreRejected() {
        assertRejected(Arrays.asList("1", "2"), "duplicate fields");
        assertRejected(Collections.singletonList("1, 2"), "ambiguous value");
        assertRejected(Collections.singletonList("1.5"), "fractional delta");
        assertRejected(Collections.singletonList("+1"), "signed delta");
        assertRejected(Collections.singletonList(" 1"), "whitespace delta");
        assertRejected(
            Collections.singletonList("Tuesday, 02-Jun-26 10:00:05 GMT"),
            "unsupported date"
        );
        assertRejected(
            Collections.singletonList("Tue, 02 Jun 2026 09:59:59 GMT"),
            "past date"
        );
        assertEquals(
            RetryAfterDirective.Outcome.NONE,
            RetryAfterParser.parse(Collections.emptyList(), NOW, 300_000L).outcome(),
            "missing header"
        );
        testsRun++;
    }

    private void testLargeValuesClampWithoutOverflow() {
        RetryAfterDirective directive = RetryAfterParser.parse(
            Collections.singletonList("999999999999999999999999999999999999"),
            NOW,
            30_000L
        );
        assertEquals(RetryAfterDirective.Outcome.ACCEPTED, directive.outcome(), "clamped outcome");
        assertEquals(30_000L, directive.delayMillis(), "clamped delay");
        testsRun++;
    }

    private static void assertRejected(java.util.List<String> values, String label) {
        RetryAfterDirective directive = RetryAfterParser.parse(values, NOW, 300_000L);
        assertEquals(RetryAfterDirective.Outcome.REJECTED, directive.outcome(), label);
        assertEquals(0L, directive.delayMillis(), label + " delay");
    }

    private static void assertEquals(Object expected, Object actual, String label) {
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new AssertionError(label + ": expected " + expected + ", got " + actual);
        }
    }
}
