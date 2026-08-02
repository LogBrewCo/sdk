package co.logbrew.sdk;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Structured exception identity attached to an issue.
 */
public final class IssueException {
    private final String type;
    private IssueExceptionMechanism mechanism;

    private IssueException(String type) {
        this.type = type;
    }

    /**
     * Creates exception identity from a stable type name.
     */
    public static IssueException create(String type) {
        return new IssueException(type);
    }

    /**
     * Sets the optional capture mechanism and handled state.
     */
    public IssueException mechanism(IssueExceptionMechanism mechanism) {
        if (mechanism == null) {
            throw new SdkException("validation_error", "issue exception mechanism must be provided");
        }
        this.mechanism = mechanism;
        return this;
    }

    Map<String, Object> toMap() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("type", IssueDiagnostics.requireExceptionType(type));
        if (mechanism != null) {
            value.put("mechanism", mechanism.toMap());
        }
        return value;
    }
}
