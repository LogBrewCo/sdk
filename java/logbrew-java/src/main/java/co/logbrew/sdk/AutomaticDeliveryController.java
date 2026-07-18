package co.logbrew.sdk;

import java.util.Objects;
import java.util.function.BooleanSupplier;

/** Owns the single lazy scheduler for an automatic client. */
final class AutomaticDeliveryController implements LogBrewClient.DeliveryObserver {
    private final LogBrewClient client;
    private final Transport transport;
    private final AutomaticDeliveryOptions options;
    private final AutomaticDeliveryScheduler.Factory schedulerFactory;
    private final AutomaticDeliveryScheduler.Jitter jitter;
    private final BooleanSupplier processOwnership;
    private AutomaticDeliveryScheduler.Scheduler scheduler;
    private AutomaticDeliveryScheduler.ScheduledTask wake;
    private LogBrewClient.DeliverySession retrySession;
    private long generation;
    private boolean stopping;
    private boolean inFlight;
    private int activeOperations;
    private boolean wakeCoalesced;
    private int retryAttempts;
    private DeliveryHealth.Activity activity = DeliveryHealth.Activity.IDLE;
    private DeliveryHealth.Outcome lastOutcome = DeliveryHealth.Outcome.NONE;
    private DeliveryHealth.PauseReason pauseReason = DeliveryHealth.PauseReason.NONE;
    private DeliveryHealth.DropReason lastDropReason = DeliveryHealth.DropReason.NONE;
    private long automaticAttempts;
    private long transportAttempts;
    private long acceptedBatches;
    private long acceptedEvents;
    private int consecutiveFailures;
    private long scheduledDelayMillis;

    AutomaticDeliveryController(
        LogBrewClient client,
        Transport transport,
        AutomaticDeliveryOptions options
    ) {
        this(
            client,
            transport,
            options,
            AutomaticDeliveryScheduler::createDefault,
            AutomaticDeliveryScheduler::selectJitter,
            currentProcessOwnership()
        );
    }

    AutomaticDeliveryController(
        LogBrewClient client,
        Transport transport,
        AutomaticDeliveryOptions options,
        AutomaticDeliveryScheduler.Factory schedulerFactory,
        AutomaticDeliveryScheduler.Jitter jitter,
        BooleanSupplier processOwnership
    ) {
        this.client = Objects.requireNonNull(client, "client");
        this.transport = Objects.requireNonNull(transport, "transport");
        this.options = Objects.requireNonNull(options, "options");
        this.schedulerFactory = Objects.requireNonNull(schedulerFactory, "schedulerFactory");
        this.jitter = Objects.requireNonNull(jitter, "jitter");
        this.processOwnership = Objects.requireNonNull(processOwnership, "processOwnership");
    }

    void onQueueChanged(int queuedEvents) {
        synchronized (this) {
            if (!ownsProcessLocked() || stopping || isPausedLocked() || queuedEvents <= 0) {
                return;
            }
            if (inFlight) {
                wakeCoalesced = true;
                return;
            }
            if (retrySession != null && wake != null && !wake.isDone()) {
                wakeCoalesced = true;
                return;
            }
            long delayMillis = queuedEvents >= options.queueThreshold()
                ? 0L
                : options.flushIntervalMillis();
            if (wake != null && !wake.isDone() && delayMillis > 0L) {
                return;
            }
            scheduleSafelyLocked(delayMillis, DeliveryHealth.Activity.SCHEDULED);
        }
    }

    void onDropped(String reason) {
        synchronized (this) {
            lastDropReason = "event_too_large".equals(reason)
                ? DeliveryHealth.DropReason.EVENT_TOO_LARGE
                : DeliveryHealth.DropReason.QUEUE_OVERFLOW;
            lastOutcome = DeliveryHealth.Outcome.DROPPED;
        }
    }

    void onQueueCleared() {
        synchronized (this) {
            generation++;
            cancelWakeLocked();
            retrySession = null;
            retryAttempts = 0;
            wakeCoalesced = false;
            scheduledDelayMillis = 0L;
            if (!isPausedLocked()) {
                activity = DeliveryHealth.Activity.IDLE;
            }
        }
    }

    void resume() {
        synchronized (this) {
            requireOwnedProcessLocked();
            if (stopping) {
                throw new SdkException("shutdown_error", "client is shutting down");
            }
            pauseReason = DeliveryHealth.PauseReason.NONE;
            consecutiveFailures = 0;
            retryAttempts = 0;
            generation++;
            cancelWakeLocked();
            activity = DeliveryHealth.Activity.IDLE;
        }
        int queuedEvents = client.pendingEvents();
        synchronized (this) {
            requireOwnedProcessLocked();
            if (stopping || isPausedLocked()) {
                return;
            }
            if (queuedEvents > 0) {
                scheduleSafelyLocked(0L, DeliveryHealth.Activity.SCHEDULED);
            }
        }
    }

    State snapshot() {
        synchronized (this) {
            ownsProcessLocked();
            return new State(
                activity,
                lastOutcome,
                pauseReason,
                lastDropReason,
                stopping,
                inFlight,
                wakeCoalesced,
                automaticAttempts,
                transportAttempts,
                acceptedBatches,
                acceptedEvents,
                consecutiveFailures,
                scheduledDelayMillis
            );
        }
    }

    TransportResponse shutdown() {
        return shutdown(transport);
    }

    TransportResponse flush(Transport explicitTransport) {
        AutomaticDeliveryTransport observed = new AutomaticDeliveryTransport(explicitTransport);
        LogBrewClient.DeliverySession session;
        synchronized (this) {
            requireOwnedProcessLocked();
            if (stopping) {
                throw new SdkException("shutdown_error", "client is shutting down");
            }
            generation++;
            cancelWakeLocked();
            beginOperationLocked();
            activity = DeliveryHealth.Activity.IN_FLIGHT;
            wakeCoalesced = false;
            scheduledDelayMillis = 0L;
            automaticAttempts = saturatedAdd(automaticAttempts, 1L);
            session = retrySession;
        }

        boolean succeeded = false;
        try {
            if (session == null) {
                session = client.beginAutomaticDelivery();
                synchronized (this) {
                    if (retrySession == null) {
                        retrySession = session;
                    }
                    session = retrySession;
                }
            }
            TransportResponse response = client.deliverAutomatically(observed, false, session, this);
            synchronized (this) {
                generation++;
                cancelWakeLocked();
                recordCompletedLocked(response);
                retrySession = null;
                retryAttempts = 0;
                pauseReason = DeliveryHealth.PauseReason.NONE;
            }
            succeeded = true;
            return response;
        } catch (RuntimeException error) {
            synchronized (this) {
                if (stopping) {
                    recordOverlappedFailureLocked(observed.failureKind());
                } else {
                    handleFailureLocked(observed.failureKind());
                }
            }
            throw stableDeliveryFailure(error);
        } finally {
            int queuedEvents = client.pendingEvents();
            synchronized (this) {
                transportAttempts = saturatedAdd(transportAttempts, observed.attempts());
                endOperationLocked();
                if (succeeded && !stopping && !isPausedLocked() && queuedEvents > 0) {
                    scheduleSafelyLocked(
                        queuedEvents >= options.queueThreshold() ? 0L : options.flushIntervalMillis(),
                        DeliveryHealth.Activity.SCHEDULED
                    );
                } else if (succeeded && !stopping) {
                    activity = DeliveryHealth.Activity.IDLE;
                }
            }
        }
    }

    TransportResponse shutdown(Transport shutdownTransport) {
        AutomaticDeliveryScheduler.Scheduler current;
        AutomaticDeliveryTransport observed = new AutomaticDeliveryTransport(shutdownTransport);
        synchronized (this) {
            requireOwnedProcessLocked();
            stopping = true;
            generation++;
            cancelWakeLocked();
            activity = DeliveryHealth.Activity.IN_FLIGHT;
            beginOperationLocked();
            wakeCoalesced = false;
            scheduledDelayMillis = 0L;
            current = scheduler;
            automaticAttempts = saturatedAdd(automaticAttempts, 1L);
        }
        boolean completed = false;
        try {
            TransportResponse response = client.deliverAutomatically(observed, true, null, this);
            synchronized (this) {
                recordCompletedLocked(response);
                retrySession = null;
                activity = DeliveryHealth.Activity.IDLE;
                pauseReason = DeliveryHealth.PauseReason.NONE;
            }
            completed = true;
            return response;
        } catch (RuntimeException error) {
            synchronized (this) {
                recordTerminalLocked(observed.failureKind());
            }
            throw stableDeliveryFailure(error);
        } finally {
            synchronized (this) {
                transportAttempts = saturatedAdd(transportAttempts, observed.attempts());
                endOperationLocked();
                if (!completed) {
                    stopping = false;
                }
            }
            if (completed) {
                stopScheduler(current);
            }
        }
    }

    @Override
    public void onBatchAccepted(int eventCount, int attempts) {
        synchronized (this) {
            acceptedBatches = saturatedAdd(acceptedBatches, 1L);
            acceptedEvents = saturatedAdd(acceptedEvents, eventCount);
        }
    }

    private void runScheduled(long scheduledGeneration) {
        AutomaticDeliveryTransport observed = new AutomaticDeliveryTransport(transport);
        LogBrewClient.DeliverySession session;
        boolean needsSession;
        synchronized (this) {
            if (!ownsProcessLocked() || stopping || isPausedLocked() || scheduledGeneration != generation) {
                return;
            }
            wake = null;
            scheduledDelayMillis = 0L;
            beginOperationLocked();
            activity = DeliveryHealth.Activity.IN_FLIGHT;
            automaticAttempts = saturatedAdd(automaticAttempts, 1L);
            needsSession = retrySession == null;
            session = retrySession;
        }
        boolean succeeded = false;
        try {
            if (needsSession) {
                LogBrewClient.DeliverySession created = client.beginAutomaticDelivery();
                synchronized (this) {
                    if (retrySession == null) {
                        retrySession = created;
                    }
                    session = retrySession;
                }
            }
            TransportResponse response = client.deliverAutomatically(observed, false, session, this);
            synchronized (this) {
                recordCompletedLocked(response);
                retrySession = null;
                retryAttempts = 0;
                pauseReason = DeliveryHealth.PauseReason.NONE;
            }
            succeeded = true;
        } catch (RuntimeException error) {
            synchronized (this) {
                if (stopping) {
                    recordOverlappedFailureLocked(observed.failureKind());
                } else {
                    handleFailureLocked(observed.failureKind());
                }
            }
        } finally {
            int queuedEvents = client.pendingEvents();
            synchronized (this) {
                transportAttempts = saturatedAdd(transportAttempts, observed.attempts());
                endOperationLocked();
                if (succeeded && !stopping && !isPausedLocked() && queuedEvents > 0) {
                    long delayMillis = wakeCoalesced || queuedEvents >= options.queueThreshold()
                        ? 0L
                        : options.flushIntervalMillis();
                    wakeCoalesced = false;
                    scheduleSafelyLocked(delayMillis, DeliveryHealth.Activity.SCHEDULED);
                } else if (succeeded && !stopping) {
                    wakeCoalesced = false;
                    activity = DeliveryHealth.Activity.IDLE;
                }
                if (inFlight) {
                    activity = DeliveryHealth.Activity.IN_FLIGHT;
                }
            }
        }
    }

    private void handleFailureLocked(AutomaticDeliveryTransport.FailureKind failureKind) {
        consecutiveFailures = saturatedIncrement(consecutiveFailures);
        if (failureKind == AutomaticDeliveryTransport.FailureKind.RETRYABLE
            && retryAttempts < options.maxRetryAttempts()) {
            retryAttempts++;
            lastOutcome = DeliveryHealth.Outcome.RETRYABLE_FAILURE;
            pauseReason = DeliveryHealth.PauseReason.NONE;
            scheduleSafelyLocked(retryDelayLocked(), DeliveryHealth.Activity.RETRYING);
            return;
        }
        pauseTerminalLocked(failureKind);
    }

    private void recordTerminalLocked(AutomaticDeliveryTransport.FailureKind failureKind) {
        consecutiveFailures = saturatedIncrement(consecutiveFailures);
        pauseTerminalLocked(failureKind);
    }

    private void recordOverlappedFailureLocked(AutomaticDeliveryTransport.FailureKind failureKind) {
        consecutiveFailures = saturatedIncrement(consecutiveFailures);
        lastOutcome = failureKind == AutomaticDeliveryTransport.FailureKind.RETRYABLE
            ? DeliveryHealth.Outcome.RETRYABLE_FAILURE
            : DeliveryHealth.Outcome.TERMINAL_FAILURE;
        activity = DeliveryHealth.Activity.IN_FLIGHT;
    }

    private void pauseTerminalLocked(AutomaticDeliveryTransport.FailureKind failureKind) {
        lastOutcome = DeliveryHealth.Outcome.TERMINAL_FAILURE;
        if (failureKind == AutomaticDeliveryTransport.FailureKind.AUTHENTICATION) {
            pauseReason = DeliveryHealth.PauseReason.AUTHENTICATION;
        } else if (failureKind == AutomaticDeliveryTransport.FailureKind.QUOTA) {
            pauseReason = DeliveryHealth.PauseReason.QUOTA;
        } else if (failureKind == AutomaticDeliveryTransport.FailureKind.RETRYABLE) {
            pauseReason = DeliveryHealth.PauseReason.RETRY_EXHAUSTED;
        } else {
            pauseReason = DeliveryHealth.PauseReason.NON_RETRYABLE;
        }
        activity = DeliveryHealth.Activity.PAUSED;
        wakeCoalesced = false;
        scheduledDelayMillis = 0L;
        cancelWakeLocked();
    }

    private void recordCompletedLocked(TransportResponse response) {
        if (response.acceptedEvents() > 0) {
            lastOutcome = DeliveryHealth.Outcome.ACCEPTED;
        } else {
            lastOutcome = DeliveryHealth.Outcome.EMPTY;
        }
        consecutiveFailures = 0;
    }

    private long retryDelayLocked() {
        long cap = options.initialRetryDelayMillis();
        for (int attempt = 1; attempt < retryAttempts; attempt++) {
            if (cap >= options.maxRetryDelayMillis() / 2L) {
                cap = options.maxRetryDelayMillis();
                break;
            }
            cap *= 2L;
        }
        cap = Math.min(cap, options.maxRetryDelayMillis());
        long minimum = (cap / 2L) + (cap % 2L);
        long selected = jitter.select(minimum, cap);
        if (selected < minimum || selected > cap) {
            return cap;
        }
        return selected;
    }

    private void scheduleLocked(long delayMillis, DeliveryHealth.Activity scheduledActivity) {
        cancelWakeLocked();
        long scheduledGeneration = ++generation;
        wake = schedulerLocked().schedule(() -> runScheduled(scheduledGeneration), delayMillis);
        activity = scheduledActivity;
        scheduledDelayMillis = delayMillis;
    }

    private boolean scheduleSafelyLocked(
        long delayMillis,
        DeliveryHealth.Activity scheduledActivity
    ) {
        try {
            scheduleLocked(delayMillis, scheduledActivity);
            return true;
        } catch (RuntimeException error) {
            recordTerminalLocked(AutomaticDeliveryTransport.FailureKind.NON_RETRYABLE);
            return false;
        }
    }

    private AutomaticDeliveryScheduler.Scheduler schedulerLocked() {
        if (scheduler == null) {
            scheduler = schedulerFactory.create();
            if (scheduler == null) {
                throw new SdkException("automatic_delivery_error", "scheduler factory returned no scheduler");
            }
        }
        return scheduler;
    }

    private void cancelWakeLocked() {
        if (wake != null) {
            wake.cancel();
            wake = null;
        }
    }

    private boolean ownsProcessLocked() {
        if (processOwnership.getAsBoolean()) {
            return true;
        }
        generation++;
        cancelWakeLocked();
        retrySession = null;
        pauseReason = DeliveryHealth.PauseReason.PROCESS_OWNERSHIP;
        lastOutcome = DeliveryHealth.Outcome.TERMINAL_FAILURE;
        activity = DeliveryHealth.Activity.PAUSED;
        scheduledDelayMillis = 0L;
        return false;
    }

    private void requireOwnedProcessLocked() {
        if (!ownsProcessLocked()) {
            throw new SdkException(
                "process_ownership_error",
                "automatic delivery belongs to a different process"
            );
        }
    }

    private boolean isPausedLocked() {
        return pauseReason != DeliveryHealth.PauseReason.NONE;
    }

    private void beginOperationLocked() {
        if (activeOperations < Integer.MAX_VALUE) {
            activeOperations++;
        }
        inFlight = true;
    }

    private void endOperationLocked() {
        if (activeOperations > 0) {
            activeOperations--;
        }
        inFlight = activeOperations > 0;
    }

    private static void stopScheduler(AutomaticDeliveryScheduler.Scheduler current) {
        if (current == null) {
            return;
        }
        try {
            current.shutdown();
            if (!current.awaitTermination(5_000L)) {
                current.shutdownNow();
                current.awaitTermination(5_000L);
            }
        } catch (InterruptedException error) {
            stopSchedulerNow(current);
            Thread.currentThread().interrupt();
        } catch (RuntimeException error) {
            stopSchedulerNow(current);
        }
    }

    private static void stopSchedulerNow(AutomaticDeliveryScheduler.Scheduler current) {
        try {
            current.shutdownNow();
        } catch (RuntimeException ignored) {
            // A completed shutdown remains authoritative even if scheduler teardown fails.
        }
    }

    private static long saturatedAdd(long left, long right) {
        return right > Long.MAX_VALUE - left ? Long.MAX_VALUE : left + right;
    }

    private static int saturatedIncrement(int value) {
        return value == Integer.MAX_VALUE ? value : value + 1;
    }

    private static BooleanSupplier currentProcessOwnership() {
        ProcessHandle owner = ProcessHandle.current();
        return () -> ProcessHandle.current().equals(owner);
    }

    private static SdkException stableDeliveryFailure(RuntimeException error) {
        if (error instanceof SdkException) {
            return (SdkException) error;
        }
        return new SdkException("transport_error", "automatic transport callback failed");
    }

    static final class State {
        final DeliveryHealth.Activity activity;
        final DeliveryHealth.Outcome lastOutcome;
        final DeliveryHealth.PauseReason pauseReason;
        final DeliveryHealth.DropReason lastDropReason;
        final boolean stopping;
        final boolean inFlight;
        final boolean wakeCoalesced;
        final long automaticAttempts;
        final long transportAttempts;
        final long acceptedBatches;
        final long acceptedEvents;
        final int consecutiveFailures;
        final long scheduledDelayMillis;

        State(
            DeliveryHealth.Activity activity,
            DeliveryHealth.Outcome lastOutcome,
            DeliveryHealth.PauseReason pauseReason,
            DeliveryHealth.DropReason lastDropReason,
            boolean stopping,
            boolean inFlight,
            boolean wakeCoalesced,
            long automaticAttempts,
            long transportAttempts,
            long acceptedBatches,
            long acceptedEvents,
            int consecutiveFailures,
            long scheduledDelayMillis
        ) {
            this.activity = activity;
            this.lastOutcome = lastOutcome;
            this.pauseReason = pauseReason;
            this.lastDropReason = lastDropReason;
            this.stopping = stopping;
            this.inFlight = inFlight;
            this.wakeCoalesced = wakeCoalesced;
            this.automaticAttempts = automaticAttempts;
            this.transportAttempts = transportAttempts;
            this.acceptedBatches = acceptedBatches;
            this.acceptedEvents = acceptedEvents;
            this.consecutiveFailures = consecutiveFailures;
            this.scheduledDelayMillis = scheduledDelayMillis;
        }

        static State manual() {
            return new State(
                DeliveryHealth.Activity.IDLE,
                DeliveryHealth.Outcome.NONE,
                DeliveryHealth.PauseReason.NONE,
                DeliveryHealth.DropReason.NONE,
                false,
                false,
                false,
                0L,
                0L,
                0L,
                0L,
                0,
                0L
            );
        }
    }

}
