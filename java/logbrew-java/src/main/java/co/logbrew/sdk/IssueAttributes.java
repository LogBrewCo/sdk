package co.logbrew.sdk;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Public payload fields for an issue event.
 */
public final class IssueAttributes {
    private final String title;
    private final String level;
    private String message;
    private Map<String, ?> metadata;
    private TelemetryContext context;
    private IssueException exception;
    private List<IssueStackFrame> stackFrames;
    private List<IssueBreadcrumb> breadcrumbs;
    private boolean breadcrumbsTruncated;

    private IssueAttributes(String title, String level) {
        this.title = title;
        this.level = level;
    }

    /**
     * Creates issue attributes with the required title and level.
     */
    public static IssueAttributes create(String title, String level) {
        return new IssueAttributes(title, level);
    }

    /**
     * Creates an error-level issue from a handled Java exception.
     *
     * <p>The projection includes type, mechanism, handled state, and bounded
     * structured frames. It deliberately omits the exception message and raw
     * stack text; applications can add an approved message explicitly.</p>
     */
    public static IssueAttributes fromThrowable(Throwable error) {
        return fromThrowable(error, "java.exception", true);
    }

    /**
     * Creates an error-level issue from a Java exception and explicit capture mechanism.
     */
    public static IssueAttributes fromThrowable(Throwable error, String mechanismType, boolean handled) {
        String exceptionType = IssueDiagnostics.safeExceptionType(error);
        return fromThrowable(exceptionType, error, mechanismType, handled);
    }

    static IssueAttributes fromThrowable(
        String title,
        Throwable error,
        String mechanismType,
        boolean handled
    ) {
        String exceptionType = IssueDiagnostics.safeExceptionType(error);
        IssueAttributes attributes = create(title, "error")
            .exception(
                IssueException.create(exceptionType)
                    .mechanism(IssueExceptionMechanism.create(mechanismType, handled))
            );
        List<IssueStackFrame> frames = IssueDiagnostics.stackFrames(error);
        if (!frames.isEmpty()) {
            attributes.stackFrames(frames);
        }
        return attributes;
    }

    /**
     * Sets the optional issue message.
     */
    public IssueAttributes message(String message) {
        this.message = message;
        return this;
    }

    /**
     * Sets optional public metadata values.
     */
    public IssueAttributes metadata(Map<String, ?> metadata) {
        this.metadata = Validation.copyMetadata(metadata);
        return this;
    }

    /** Sets shared resource and correlation context. */
    public IssueAttributes context(TelemetryContext context) {
        this.context = Validation.requireTelemetryContext(context);
        return this;
    }

    /**
     * Sets optional structured exception identity.
     */
    public IssueAttributes exception(IssueException exception) {
        if (exception == null) {
            throw new SdkException("validation_error", "issue exception must be provided");
        }
        this.exception = exception;
        return this;
    }

    /**
     * Adds one optional privacy-bounded stack frame.
     */
    public IssueAttributes stackFrame(IssueStackFrame frame) {
        if (frame == null) {
            throw new SdkException("validation_error", "issue stack frame must be provided");
        }
        if (stackFrames == null) {
            stackFrames = new ArrayList<>();
        }
        requireStackFrameLimit(stackFrames.size() + 1);
        stackFrames.add(frame);
        return this;
    }

    /**
     * Sets 1-32 optional privacy-bounded newest-first stack frames.
     */
    public IssueAttributes stackFrames(Iterable<IssueStackFrame> frames) {
        if (frames == null) {
            throw new SdkException("validation_error", "issue stackFrames must be provided");
        }
        List<IssueStackFrame> copied = new ArrayList<>();
        for (IssueStackFrame frame : frames) {
            if (frame == null) {
                throw new SdkException("validation_error", "issue stack frame must be provided");
            }
            copied.add(frame);
            requireStackFrameLimit(copied.size());
        }
        if (copied.isEmpty()) {
            throw new SdkException("validation_error", "issue stackFrames must contain 1-32 frames");
        }
        stackFrames = copied;
        return this;
    }

    /**
     * Adds one optional privacy-bounded breadcrumb.
     */
    public IssueAttributes breadcrumb(IssueBreadcrumb breadcrumb) {
        if (breadcrumb == null) {
            throw new SdkException("validation_error", "issue breadcrumb must be provided");
        }
        if (breadcrumbs == null) {
            breadcrumbs = new ArrayList<>();
        }
        requireBreadcrumbLimit(breadcrumbs.size() + 1);
        breadcrumbs.add(breadcrumb);
        return this;
    }

    /**
     * Sets 1-64 optional oldest-to-newest privacy-bounded breadcrumbs.
     */
    public IssueAttributes breadcrumbs(Iterable<IssueBreadcrumb> values) {
        if (values == null) {
            throw new SdkException("validation_error", "issue breadcrumbs must be provided");
        }
        List<IssueBreadcrumb> copied = new ArrayList<>();
        for (IssueBreadcrumb breadcrumb : values) {
            if (breadcrumb == null) {
                throw new SdkException("validation_error", "issue breadcrumb must be provided");
            }
            copied.add(breadcrumb);
            requireBreadcrumbLimit(copied.size());
        }
        if (copied.isEmpty()) {
            throw new SdkException("validation_error", "issue breadcrumbs must contain 1-64 entries");
        }
        breadcrumbs = copied;
        return this;
    }

    /**
     * Marks that older breadcrumbs were evicted before this snapshot.
     */
    public IssueAttributes breadcrumbsTruncated(boolean truncated) {
        breadcrumbsTruncated = truncated;
        return this;
    }

    Map<String, Object> toMap() {
        Validation.requireNonEmpty("issue title", title);
        String normalizedLevel = Validation.normalizeSeverity("issue level", level);
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("title", title);
        value.put("level", normalizedLevel);
        Validation.putOptionalString(value, "message", message);
        if (exception != null) {
            value.put("exception", exception.toMap());
        }
        if (stackFrames != null) {
            List<Map<String, Object>> mappedFrames = new ArrayList<>();
            for (IssueStackFrame frame : stackFrames) {
                mappedFrames.add(frame.toMap());
            }
            value.put("stackFrames", mappedFrames);
        }
        if (breadcrumbs != null) {
            List<Map<String, Object>> mappedBreadcrumbs = new ArrayList<>();
            for (IssueBreadcrumb breadcrumb : breadcrumbs) {
                mappedBreadcrumbs.add(breadcrumb.toMap());
            }
            value.put("breadcrumbs", mappedBreadcrumbs);
        }
        if (breadcrumbsTruncated) {
            value.put("breadcrumbsTruncated", Boolean.TRUE);
        }
        Validation.putOptionalMetadata(value, metadata);
        Validation.putOptionalContext(value, context);
        return value;
    }

    private static void requireStackFrameLimit(int count) {
        if (count > IssueDiagnostics.MAX_STACK_FRAMES) {
            throw new SdkException("validation_error", "issue stackFrames must contain 1-32 frames");
        }
    }

    private static void requireBreadcrumbLimit(int count) {
        if (count > IssueDiagnostics.MAX_BREADCRUMBS) {
            throw new SdkException("validation_error", "issue breadcrumbs must contain 1-64 entries");
        }
    }
}
