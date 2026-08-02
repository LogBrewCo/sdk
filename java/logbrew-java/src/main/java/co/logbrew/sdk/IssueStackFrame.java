package co.logbrew.sdk;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Privacy-bounded code identity for one issue stack frame.
 */
public final class IssueStackFrame {
    private final String filename;
    private final int line;
    private final int column;
    private String function;
    private String module;
    private Boolean inApp;
    private String debugId;

    private IssueStackFrame(String filename, int line, int column) {
        this.filename = filename;
        this.line = line;
        this.column = column;
    }

    /**
     * Creates a frame with required source identity and positive coordinates.
     */
    public static IssueStackFrame create(String filename, int line, int column) {
        return new IssueStackFrame(filename, line, column);
    }

    /**
     * Sets the optional function or method name.
     */
    public IssueStackFrame function(String function) {
        this.function = function;
        return this;
    }

    /**
     * Sets the optional module or class name.
     */
    public IssueStackFrame module(String module) {
        this.module = module;
        return this;
    }

    /**
     * Marks whether the application owns this frame.
     */
    public IssueStackFrame inApp(boolean inApp) {
        this.inApp = Boolean.valueOf(inApp);
        return this;
    }

    /**
     * Sets an optional build Debug ID.
     */
    public IssueStackFrame debugId(String debugId) {
        this.debugId = debugId;
        return this;
    }

    Map<String, Object> toMap() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("filename", IssueDiagnostics.sanitizeFilename(filename));
        value.put("line", Integer.valueOf(IssueDiagnostics.requireCoordinate("issue stack frame line", line)));
        value.put("column", Integer.valueOf(IssueDiagnostics.requireCoordinate("issue stack frame column", column)));
        if (function != null) {
            value.put("function", IssueDiagnostics.requireFrameFunction(function));
        }
        if (module != null) {
            value.put("module", IssueDiagnostics.requireFrameModule(module));
        }
        if (inApp != null) {
            value.put("inApp", inApp);
        }
        if (debugId != null) {
            value.put("debugId", IssueDiagnostics.normalizeDebugId(debugId));
        }
        return value;
    }
}
