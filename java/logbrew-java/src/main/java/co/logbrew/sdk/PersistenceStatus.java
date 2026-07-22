package co.logbrew.sdk;

/**
 * Content-free status for an opt-in encrypted event store.
 */
public final class PersistenceStatus {
    private final int pendingEvents;
    private final long pendingEventBytes;
    private final int ambiguousFiles;
    private final boolean recoveryRequired;

    PersistenceStatus(
        int pendingEvents,
        long pendingEventBytes,
        int ambiguousFiles,
        boolean recoveryRequired
    ) {
        this.pendingEvents = pendingEvents;
        this.pendingEventBytes = pendingEventBytes;
        this.ambiguousFiles = ambiguousFiles;
        this.recoveryRequired = recoveryRequired;
    }

    /** Returns the number of durable events awaiting acknowledgement. */
    public int pendingEvents() {
        return pendingEvents;
    }

    /** Returns the exact serialized event bytes awaiting acknowledgement. */
    public long pendingEventBytes() {
        return pendingEventBytes;
    }

    /** Returns the number of incomplete atomic writes requiring explicit recovery or purge. */
    public int ambiguousFiles() {
        return ambiguousFiles;
    }

    /** Returns whether a client must recover or purge the store before capture or delivery. */
    public boolean recoveryRequired() {
        return recoveryRequired;
    }
}
