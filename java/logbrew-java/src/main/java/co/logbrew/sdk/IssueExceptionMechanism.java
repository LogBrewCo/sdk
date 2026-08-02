package co.logbrew.sdk;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Runtime path that captured an issue exception and whether it escaped.
 */
public final class IssueExceptionMechanism {
    private final String type;
    private final boolean handled;

    private IssueExceptionMechanism(String type, boolean handled) {
        this.type = type;
        this.handled = handled;
    }

    /**
     * Creates a typed issue mechanism with an explicit handled state.
     */
    public static IssueExceptionMechanism create(String type, boolean handled) {
        return new IssueExceptionMechanism(type, handled);
    }

    Map<String, Object> toMap() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("type", IssueDiagnostics.requireMechanismType(type));
        value.put("handled", Boolean.valueOf(handled));
        return value;
    }
}
