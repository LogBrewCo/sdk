package co.logbrew.sdk;

import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * At most eight parent-first runtime exceptions with explicit omission states.
 */
public final class IssueExceptionChain {
    private final List<IssueExceptionChainEntry> entries;
    private final boolean truncated;

    private IssueExceptionChain(Iterable<IssueExceptionChainEntry> entries, boolean truncated) {
        if (entries == null) {
            throw IssueDiagnostics.validation("issue exceptionChain entries must be provided");
        }
        List<IssueExceptionChainEntry> copied = new ArrayList<>();
        for (IssueExceptionChainEntry entry : entries) {
            if (entry == null) {
                throw IssueDiagnostics.validation("issue exceptionChain entry must be provided");
            }
            copied.add(entry);
        }
        this.entries = copied;
        this.truncated = truncated;
    }

    /**
     * Creates a manually approved exception chain.
     */
    public static IssueExceptionChain create(
        Iterable<IssueExceptionChainEntry> entries,
        boolean truncated
    ) {
        return new IssueExceptionChain(entries, truncated);
    }

    static IssueExceptionChain fromThrowable(
        Throwable error,
        IssueExceptionMechanism rootMechanism,
        IssueDiagnostics.StackEvidence rootStack
    ) {
        Builder builder = new Builder(rootMechanism, rootStack);
        builder.addRoot(error);
        return new IssueExceptionChain(builder.entries, builder.truncated);
    }

    Map<String, Object> toMap(
        IssueException legacyException,
        List<IssueStackFrame> legacyFrames
    ) {
        validate(legacyException, legacyFrames);
        List<Map<String, Object>> mappedEntries = new ArrayList<>();
        for (IssueExceptionChainEntry entry : entries) {
            mappedEntries.add(entry.toMap());
        }
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("entries", mappedEntries);
        value.put("truncated", Boolean.valueOf(truncated));
        return value;
    }

    private void validate(IssueException legacyException, List<IssueStackFrame> legacyFrames) {
        if (entries.isEmpty() || entries.size() > IssueDiagnostics.MAX_EXCEPTIONS) {
            throw IssueDiagnostics.validation(
                "issue exceptionChain entries must contain 1-8 exceptions"
            );
        }
        for (int index = 0; index < entries.size(); index++) {
            IssueExceptionChainEntry entry = entries.get(index);
            if (entry.id() != index) {
                throw IssueDiagnostics.validation(
                    "issue exceptionChain ids must be contiguous and match array order"
                );
            }
            if (index == 0) {
                if (entry.relationship() != IssueExceptionRelationship.REPORTED
                    || entry.parentId() != null) {
                    throw IssueDiagnostics.validation(
                        "issue exceptionChain entry 0 must be the parentless reported exception"
                    );
                }
            } else if (entry.relationship() == IssueExceptionRelationship.REPORTED
                || entry.parentId() == null
                || entry.parentId().intValue() < 0
                || entry.parentId().intValue() >= index) {
                throw IssueDiagnostics.validation(
                    "issue exceptionChain parent relationship is invalid"
                );
            }
        }

        if (legacyException == null) {
            throw IssueDiagnostics.validation(
                "issue exceptionChain reported exception must match exception"
            );
        }
        Map<String, Object> root = entries.get(0).toMap();
        Map<String, Object> reportedException = new LinkedHashMap<>();
        reportedException.put("type", root.get("type"));
        if (root.containsKey("mechanism")) {
            reportedException.put("mechanism", root.get("mechanism"));
        }
        if (!reportedException.equals(legacyException.toMap())) {
            throw IssueDiagnostics.validation(
                "issue exceptionChain reported exception must match exception"
            );
        }

        IssueExceptionChainEntry reported = entries.get(0);
        List<Map<String, Object>> legacyMapped = legacyFrames == null
            ? null
            : mapFrames(legacyFrames);
        if ("not_captured".equals(reported.stackFramesState())) {
            if (legacyMapped != null) {
                throw IssueDiagnostics.validation(
                    "issue exceptionChain reported stack must match stackFrames"
                );
            }
        } else if (!java.util.Objects.equals(reported.mappedStackFrames(), legacyMapped)) {
            throw IssueDiagnostics.validation(
                "issue exceptionChain reported stack must match stackFrames"
            );
        }
    }

    private static List<Map<String, Object>> mapFrames(List<IssueStackFrame> frames) {
        List<Map<String, Object>> mapped = new ArrayList<>();
        for (IssueStackFrame frame : frames) {
            mapped.add(frame.toMap());
        }
        return mapped;
    }

    private static final class Builder {
        private final List<IssueExceptionChainEntry> entries = new ArrayList<>();
        private final Set<Throwable> seen = Collections.newSetFromMap(new IdentityHashMap<>());
        private final IssueExceptionMechanism rootMechanism;
        private final IssueDiagnostics.StackEvidence rootStack;
        private boolean truncated;

        private Builder(
            IssueExceptionMechanism rootMechanism,
            IssueDiagnostics.StackEvidence rootStack
        ) {
            this.rootMechanism = rootMechanism;
            this.rootStack = rootStack;
        }

        private void addRoot(Throwable error) {
            seen.add(error);
            add(error, null, IssueExceptionRelationship.REPORTED, rootMechanism, rootStack);
        }

        private void add(
            Throwable error,
            Integer parentId,
            IssueExceptionRelationship relationship,
            IssueExceptionMechanism mechanism,
            IssueDiagnostics.StackEvidence knownStack
        ) {
            if (entries.size() >= IssueDiagnostics.MAX_EXCEPTIONS) {
                truncated = true;
                return;
            }
            int id = entries.size();
            IssueDiagnostics.StackEvidence stack = knownStack == null
                ? IssueDiagnostics.stackEvidence(error)
                : knownStack;
            IssueExceptionChainEntry entry = IssueExceptionChainEntry
                .create(id, relationship, IssueDiagnostics.safeExceptionType(error))
                .mechanism(mechanism);
            if (parentId != null) {
                entry.parentId(parentId.intValue());
            }
            String module = IssueDiagnostics.safeExceptionModule(error);
            if (module != null) {
                entry.module(module);
            }
            if (IssueDiagnostics.hasExceptionMessage(error)) {
                entry.redactedMessage();
            }
            if (!stack.frames().isEmpty()) {
                entry.stackFrames(stack.frames(), stack.truncated());
            }
            entries.add(entry);
            addChildren(error, id);
        }

        private void addChildren(Throwable error, int parentId) {
            Throwable cause = IssueDiagnostics.safeCause(error);
            if (cause != null) {
                addChild(
                    cause,
                    parentId,
                    IssueExceptionRelationship.CAUSE,
                    "java.cause"
                );
            }
            for (Throwable suppressed : IssueDiagnostics.safeSuppressed(error)) {
                addChild(
                    suppressed,
                    parentId,
                    IssueExceptionRelationship.SUPPRESSED,
                    "java.suppressed"
                );
            }
        }

        private void addChild(
            Throwable child,
            int parentId,
            IssueExceptionRelationship relationship,
            String mechanismType
        ) {
            if (!seen.add(child)) {
                truncated = true;
                return;
            }
            add(
                child,
                Integer.valueOf(parentId),
                relationship,
                IssueExceptionMechanism.create(mechanismType, true),
                null
            );
        }
    }
}
