package co.logbrew.sdk;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * One parent-first runtime exception with its own bounded stack evidence.
 */
public final class IssueExceptionChainEntry {
    private final int id;
    private final IssueExceptionRelationship relationship;
    private final String type;
    private Integer parentId;
    private String message;
    private String messageState = "not_captured";
    private String module;
    private IssueExceptionMechanism mechanism;
    private List<IssueStackFrame> stackFrames;
    private String stackFramesState = "not_captured";

    private IssueExceptionChainEntry(int id, IssueExceptionRelationship relationship, String type) {
        this.id = id;
        this.relationship = relationship;
        this.type = type;
    }

    /**
     * Creates one exception node. IDs must match parent-first array order.
     */
    public static IssueExceptionChainEntry create(
        int id,
        IssueExceptionRelationship relationship,
        String type
    ) {
        if (relationship == null) {
            throw IssueDiagnostics.validation("issue exceptionChain relationship must be provided");
        }
        return new IssueExceptionChainEntry(id, relationship, type);
    }

    /**
     * References an earlier parent node.
     */
    public IssueExceptionChainEntry parentId(int parentId) {
        this.parentId = Integer.valueOf(parentId);
        return this;
    }

    /**
     * Sets an approved captured message and whether the value was truncated.
     */
    public IssueExceptionChainEntry message(String message, boolean truncated) {
        this.message = IssueDiagnostics.requireExceptionMessage(message);
        this.messageState = truncated ? "truncated" : "captured";
        return this;
    }

    /**
     * Reports that a message existed but was deliberately redacted.
     */
    public IssueExceptionChainEntry redactedMessage() {
        message = null;
        messageState = "redacted";
        return this;
    }

    /**
     * Sets the optional runtime module or namespace.
     */
    public IssueExceptionChainEntry module(String module) {
        this.module = IssueDiagnostics.requireExceptionModule(module);
        return this;
    }

    /**
     * Sets the capture mechanism and handled state for this node.
     */
    public IssueExceptionChainEntry mechanism(IssueExceptionMechanism mechanism) {
        if (mechanism == null) {
            throw IssueDiagnostics.validation("issue exceptionChain mechanism must be provided");
        }
        this.mechanism = mechanism;
        return this;
    }

    /**
     * Sets 1-32 bounded frames and whether more frames existed.
     */
    public IssueExceptionChainEntry stackFrames(Iterable<IssueStackFrame> frames, boolean truncated) {
        if (frames == null) {
            throw IssueDiagnostics.validation("issue exceptionChain stackFrames must be provided");
        }
        List<IssueStackFrame> copied = new ArrayList<>();
        for (IssueStackFrame frame : frames) {
            if (frame == null) {
                throw IssueDiagnostics.validation("issue exceptionChain stack frame must be provided");
            }
            copied.add(frame);
            if (copied.size() > IssueDiagnostics.MAX_STACK_FRAMES) {
                throw IssueDiagnostics.validation(
                    "issue exceptionChain stackFrames must contain 1-32 frames"
                );
            }
        }
        if (copied.isEmpty()) {
            throw IssueDiagnostics.validation(
                "issue exceptionChain stackFrames must contain 1-32 frames"
            );
        }
        stackFrames = copied;
        stackFramesState = truncated ? "truncated" : "captured";
        return this;
    }

    Map<String, Object> toMap() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("id", Integer.valueOf(id));
        if (parentId != null) {
            value.put("parentId", parentId);
        }
        value.put("relationship", relationship.wireName());
        value.put("type", IssueDiagnostics.requireExceptionType(type));
        if (message != null) {
            value.put("message", IssueDiagnostics.requireExceptionMessage(message));
        }
        value.put("messageState", messageState);
        if (module != null) {
            value.put("module", IssueDiagnostics.requireExceptionModule(module));
        }
        if (mechanism != null) {
            value.put("mechanism", mechanism.toMap());
        }
        if (stackFrames != null) {
            value.put("stackFrames", mapFrames(stackFrames));
        }
        value.put("stackFramesState", stackFramesState);
        return value;
    }

    int id() {
        return id;
    }

    Integer parentId() {
        return parentId;
    }

    IssueExceptionRelationship relationship() {
        return relationship;
    }

    String stackFramesState() {
        return stackFramesState;
    }

    List<Map<String, Object>> mappedStackFrames() {
        return stackFrames == null ? null : mapFrames(stackFrames);
    }

    private static List<Map<String, Object>> mapFrames(List<IssueStackFrame> frames) {
        List<Map<String, Object>> mapped = new ArrayList<>();
        for (IssueStackFrame frame : frames) {
            mapped.add(frame.toMap());
        }
        return mapped;
    }
}
