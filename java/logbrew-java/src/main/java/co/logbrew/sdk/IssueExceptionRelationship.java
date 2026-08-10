package co.logbrew.sdk;

/**
 * How one runtime exception relates to its earlier parent node.
 */
public enum IssueExceptionRelationship {
    /** The exception reported by the capture API. */
    REPORTED("reported"),
    /** A causal exception exposed by the runtime. */
    CAUSE("cause"),
    /** Context retained while another exception was handled. */
    CONTEXT("context"),
    /** One member of an aggregate exception. */
    AGGREGATE_MEMBER("aggregate_member"),
    /** A runtime-suppressed exception. */
    SUPPRESSED("suppressed");

    private final String wireName;

    IssueExceptionRelationship(String wireName) {
        this.wireName = wireName;
    }

    String wireName() {
        return wireName;
    }
}
