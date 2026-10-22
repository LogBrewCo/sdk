using System;
using System.Collections.Generic;
using System.Threading;

namespace LogBrew
{
    internal sealed class DeliveryEngine : IDurableDeliveryPurgeOwner
    {
        private readonly string apiKey;
        private readonly DeliveryBatchBuilder batchBuilder;
        private readonly int maxRetries;
        private readonly int maxQueueSize;
        private readonly int maxQueueBytes;
        private readonly DeliveryDropReporter dropReporter;
        private readonly ITransport? automaticTransport;
        private readonly AutomaticDeliverySettings? automaticSettings;
        private readonly IDurableDeliverySession? durableSession;
        private readonly DeliveryRetryPolicy retryPolicy = new DeliveryRetryPolicy();
        private readonly List<Event> events = new List<Event>();
        private readonly object gate = new object();
        private readonly int ownerProcessId;
        private readonly Dictionary<Event, int> snapshotTargets = new Dictionary<Event, int>();
        private FrozenBatch? frozenBatch;
        private Thread? worker;
        private bool workerStopRequested;
        private bool wakeRequested;
        private long nextWakeTimestamp;
        private long scheduleGeneration;
        private bool deliveryInFlight;
        private int deliveryOwnerThreadId;
        private int queuedBytes;
        private int unavailableDurableRecords;
        private long unavailableDurableBytes;
        private int retryAttempt;
        private int retryDelayMilliseconds;
        private int consecutiveFailures;
        private long acceptedEvents;
        private long acceptedBatches;
        private DeliveryLifecycleState lifecycle;
        private DeliveryActivityState activity;
        private DeliveryOutcome lastOutcome;
        private DeliveryPauseReason pauseReason;
        private DeliveryRetrySource retrySource;
        private DeliveryStatusClass lastStatusClass;
        private DateTimeOffset? lastOutcomeAt;
        private bool closing;
        private bool closed;

        internal DeliveryEngine(
            string apiKey,
            OrderedJsonObject sdk,
            int maxRetries,
            int maxQueueSize,
            int maxQueueBytes,
            Action<DroppedEvent>? onEventDropped,
            ITransport? automaticTransport,
            AutomaticDeliverySettings? automaticSettings,
            IDurableDeliverySession? durableSession = null)
        {
            this.apiKey = apiKey;
            batchBuilder = new DeliveryBatchBuilder(sdk);
            this.maxRetries = maxRetries;
            this.maxQueueSize = maxQueueSize;
            this.maxQueueBytes = maxQueueBytes;
            dropReporter = new DeliveryDropReporter(onEventDropped);
            this.automaticTransport = automaticTransport;
            this.automaticSettings = automaticSettings;
            this.durableSession = durableSession;
            ownerProcessId = DeliveryRuntimePolicy.CurrentProcessId();
            lifecycle = automaticSettings == null ? DeliveryLifecycleState.Manual : DeliveryLifecycleState.Running;
            activity = DeliveryActivityState.Idle;
            if (durableSession != null)
            {
                var recovered = durableSession.TakeRecoveryState(maxQueueSize, maxQueueBytes);
                if (recovered.RecoveryFailed)
                {
                    lifecycle = DeliveryLifecycleState.Paused;
                    pauseReason = DeliveryPauseReason.Storage;
                    unavailableDurableRecords = recovered.PersistedRecordCount;
                    unavailableDurableBytes = recovered.PersistedBytes;
                }
                else
                {
                    dropReporter.LoadSaved(recovered.UnreportedDrops);
                    events.AddRange(recovered.Events);
                    foreach (var item in recovered.Events)
                    {
                        queuedBytes += item.SerializedByteCount;
                    }

                    frozenBatch = recovered.FrozenBatch;
                }
            }
        }

        internal void StartOwnedDelivery()
        {
            lock (gate)
            {
                if (automaticSettings != null && lifecycle == DeliveryLifecycleState.Running && events.Count > 0)
                {
                    ScheduleLiveWorkLocked();
                    EnsureWorkerStartedLocked();
                }
            }
        }

        internal int PendingEvents()
        {
            lock (gate)
            {
                RequireOwnerProcessLocked();
                return events.Count + unavailableDurableRecords;
            }
        }

        internal int DroppedEvents()
        {
            lock (gate)
            {
                RequireOwnerProcessLocked();
                return dropReporter.Count;
            }
        }

        internal DeliveryHealthSnapshot Health()
        {
            lock (gate)
            {
                RequireOwnerProcessLocked();
                return new DeliveryHealthSnapshot(
                    lifecycle,
                    activity,
                    lastOutcome,
                    pauseReason,
                    retrySource,
                    lastStatusClass,
                    events.Count + unavailableDurableRecords,
                    unavailableDurableBytes > int.MaxValue - queuedBytes ? int.MaxValue : queuedBytes + (int)unavailableDurableBytes,
                    deliveryInFlight,
                    wakeRequested || nextWakeTimestamp != 0,
                    retryAttempt,
                    retryDelayMilliseconds,
                    consecutiveFailures,
                    acceptedEvents,
                    acceptedBatches,
                    dropReporter.Count,
                    lastOutcomeAt);
            }
        }

        internal string PreviewJson()
        {
            lock (gate)
            {
                RequireOwnerProcessLocked();
                return batchBuilder.BuildBody(events);
            }
        }

        internal void Enqueue(Event item)
        {
            var singleBodyBytes = batchBuilder.SingleEventRequestBytes(item);
            DroppedEvent? drop = null;
            var evictions = new List<DroppedEvent>();
            if (durableSession != null)
            {
                durableSession.EnterOperation();
                try
                {
                    var evicted = new List<Event>();
                    lock (gate)
                    {
                        RequireOpenLocked();
                        drop = AdmissionDropLocked(item, singleBodyBytes, evicted);
                    }
                    if (drop == null)
                    {
                        var recordName = string.Empty;
                        try
                        {
                            // Delete evicted records before storing the crash report, so a restart never
                            // recovers more events than the queue bounds allow.
                            if (evicted.Count > 0)
                            {
                                durableSession.Remove(evicted);
                                lock (gate)
                                {
                                    foreach (var removed in evicted)
                                    {
                                        evictions.Add(RecordDropLocked(removed.Id, removed.Type, "evicted_for_fatal"));
                                    }
                                }
                            }

                            recordName = durableSession.Persist(item);
                        }
                        catch (Exception error) when (!DeliveryExceptionPolicy.IsFatal(error))
                        {
                            lock (gate)
                            {
                                drop = RecordDropLocked(item.Id, item.Type, "storage_unavailable");
                                lifecycle = DeliveryLifecycleState.Paused;
                                activity = DeliveryActivityState.Idle;
                                pauseReason = DeliveryPauseReason.Storage;
                                lastStatusClass = DeliveryStatusClass.None;
                            }
                        }
                        if (drop == null)
                        {
                            lock (gate)
                            {
                                var wasEmpty = events.Count == 0;
                                events.Add(item);
                                durableSession.Track(item, recordName);
                                queuedBytes += item.SerializedByteCount;
                                ScheduleCaptureLocked(wasEmpty);
                            }
                        }
                    }
                }
                finally
                {
                    durableSession.ExitOperation();
                }
                ReportDrops(drop, evictions);
                SaveDropCounts(force: false);
                return;
            }
            lock (gate)
            {
                RequireOpenLocked();
                var evicted = new List<Event>();
                drop = AdmissionDropLocked(item, singleBodyBytes, evicted);
                foreach (var removed in evicted)
                {
                    evictions.Add(RecordDropLocked(removed.Id, removed.Type, "evicted_for_fatal"));
                }

                if (drop == null)
                {
                    var wasEmpty = events.Count == 0;
                    events.Add(item);
                    queuedBytes += item.SerializedByteCount;
                    if (automaticSettings != null)
                    {
                        ScheduleCaptureLocked(wasEmpty);
                    }
                }
            }
            ReportDrops(drop, evictions);
        }

        // Keeps unreported drop counts across restarts. Counts are advisory: a failed save never fails capture.
        private void SaveDropCounts(bool force)
        {
            if (durableSession == null)
            {
                return;
            }

            IReadOnlyDictionary<string, int>? counts;
            lock (gate)
            {
                counts = dropReporter.TakeUnsavedCounts(force);
            }

            if (counts == null)
            {
                return;
            }

            durableSession.EnterOperation();
            try
            {
                durableSession.SaveClientReport(counts);
            }
            catch (Exception error) when (!DeliveryExceptionPolicy.IsFatal(error))
            {
                // Counts stay in memory and ride in the next request.
            }
            finally
            {
                durableSession.ExitOperation();
            }
        }

        private void ReportDrops(DroppedEvent? drop, List<DroppedEvent> evictions)
        {
            if (drop != null)
            {
                dropReporter.Report(drop);
            }

            // Report evictions only after admission so drop callbacks cannot refill the freed room.
            foreach (var eviction in evictions)
            {
                dropReporter.Report(eviction);
            }
        }

        // Removes the oldest events that are not crash reports, not in the frozen batch being sent or
        // retried, and not the last event of a pending flush, only when that makes room.
        private List<Event> EvictForFatalLocked(int itemBytes)
        {
            var indexes = new List<int>();
            var count = events.Count;
            long bytes = (long)queuedBytes + itemBytes;
            for (var index = frozenBatch?.Events.Count ?? 0;
                index < events.Count && DeliveryQueuePolicy.Overflows(count, bytes, maxQueueSize, maxQueueBytes);
                index++)
            {
                var candidate = events[index];
                if (DeliveryQueuePolicy.IsFatal(candidate) || snapshotTargets.ContainsKey(candidate))
                {
                    continue;
                }

                indexes.Add(index);
                count--;
                bytes -= candidate.SerializedByteCount;
            }

            var evicted = new List<Event>();
            if (DeliveryQueuePolicy.Overflows(count, bytes, maxQueueSize, maxQueueBytes))
            {
                return evicted;
            }

            foreach (var index in indexes)
            {
                evicted.Add(events[index]);
            }

            for (var position = indexes.Count - 1; position >= 0; position--)
            {
                queuedBytes -= events[indexes[position]].SerializedByteCount;
                events.RemoveAt(indexes[position]);
            }

            return evicted;
        }

        private void AddSnapshotTargetLocked(Event? target)
        {
            if (target != null)
            {
                snapshotTargets[target] = snapshotTargets.TryGetValue(target, out var holders) ? holders + 1 : 1;
            }
        }

        private void RemoveSnapshotTarget(Event? target)
        {
            if (target == null)
            {
                return;
            }

            lock (gate)
            {
                var holders = snapshotTargets[target];
                if (holders == 1)
                {
                    snapshotTargets.Remove(target);
                }
                else
                {
                    snapshotTargets[target] = holders - 1;
                }
            }
        }

        // Returns the drop for an event that cannot enter the queue. A crash report at a full queue
        // first removes older events into evicted; the caller records them once they are gone.
        private DroppedEvent? AdmissionDropLocked(Event item, int singleBodyBytes, List<Event> evicted)
        {
            var reason = DeliveryQueuePolicy.AdmissionDropReason(
                item, singleBodyBytes, events.Count, queuedBytes, maxQueueSize, maxQueueBytes);
            if ((reason == "queue_overflow" || reason == "queue_bytes_overflow") && DeliveryQueuePolicy.IsFatal(item))
            {
                evicted.AddRange(EvictForFatalLocked(item.SerializedByteCount));
                reason = evicted.Count > 0 ? null : reason;
            }

            return reason == null ? null : RecordDropLocked(item.Id, item.Type, reason);
        }

        internal TransportResponse Flush(ITransport transport)
        {
            if (transport == null)
            {
                throw new SdkException("validation_error", "transport must be non-null");
            }

            Event? targetEvent;
            lock (gate)
            {
                RequireOpenLocked();
                targetEvent = DeliveryQueuePolicy.Last(events);
                AddSnapshotTargetLocked(targetEvent);
            }

            try
            {
                return FlushSnapshot(transport, targetEvent, allowClosing: false);
            }
            finally
            {
                RemoveSnapshotTarget(targetEvent);
            }
        }

        internal TransportResponse Flush()
        {
            return Flush(DeliveryRuntimePolicy.RequireAutomaticTransport(automaticTransport));
        }

        internal TransportResponse Shutdown(ITransport transport)
        {
            if (transport == null)
            {
                throw new SdkException("validation_error", "transport must be non-null");
            }

            Thread? workerToJoin;
            durableSession?.EnterOperation();
            try
            {
                lock (gate)
                {
                    RequireOpenLocked();
                    if (deliveryInFlight && deliveryOwnerThreadId == Environment.CurrentManagedThreadId)
                    {
                        throw new SdkException("reentrancy_error", "delivery cannot shut down from its transport callback");
                    }

                    closing = true;
                    lifecycle = DeliveryLifecycleState.Closing;
                    activity = deliveryInFlight ? DeliveryActivityState.Sending : DeliveryActivityState.Idle;
                    scheduleGeneration = DeliveryRuntimePolicy.SaturatingIncrement(scheduleGeneration);
                    workerStopRequested = true;
                    wakeRequested = false;
                    nextWakeTimestamp = 0;
                    Monitor.PulseAll(gate);
                    workerToJoin = worker;
                }
            }
            finally
            {
                durableSession?.ExitOperation();
            }

            DeliveryRuntimePolicy.JoinWorker(workerToJoin);

            try
            {
                Event? targetEvent;
                lock (gate)
                {
                    targetEvent = DeliveryQueuePolicy.Last(events);
                }

                var response = FlushSnapshot(transport, targetEvent, allowClosing: true);
                lock (gate)
                {
                    closed = true;
                    closing = false;
                    lifecycle = DeliveryLifecycleState.Closed;
                    activity = DeliveryActivityState.Idle;
                    worker = null;
                    workerStopRequested = true;
                    wakeRequested = false;
                    nextWakeTimestamp = 0;
                }

                SaveDropCounts(force: true);
                durableSession?.Dispose();

                return response;
            }
            catch (Exception error) when (!DeliveryExceptionPolicy.IsFatal(error))
            {
                lock (gate)
                {
                    closing = false;
                    worker = null;
                    workerStopRequested = false;
                    activity = DeliveryActivityState.Idle;
                    if (automaticSettings == null)
                    {
                        lifecycle = DeliveryLifecycleState.Manual;
                    }
                    else
                    {
                        lifecycle = DeliveryLifecycleState.Paused;
                        if (pauseReason == DeliveryPauseReason.None)
                        {
                            pauseReason = DeliveryPauseReason.NonRetryable;
                        }
                    }
                }

                throw;
            }
        }

        internal TransportResponse Shutdown()
        {
            return Shutdown(DeliveryRuntimePolicy.RequireAutomaticTransport(automaticTransport));
        }

        internal void RecoverAutomaticDelivery()
        {
            lock (gate)
            {
                RequireOwnerProcessLocked();
                if (automaticSettings == null)
                {
                    throw new SdkException("configuration_error", "client does not own automatic delivery");
                }

                if (closed || closing)
                {
                    throw new SdkException("shutdown_error", "client is already shut down");
                }

                if (lifecycle == DeliveryLifecycleState.Running)
                {
                    return;
                }

                lifecycle = DeliveryLifecycleState.Running;
                activity = events.Count == 0 ? DeliveryActivityState.Idle : DeliveryActivityState.Scheduled;
                pauseReason = DeliveryPauseReason.None;
                retrySource = DeliveryRetrySource.None;
                retryAttempt = 0;
                retryDelayMilliseconds = 0;
                consecutiveFailures = 0;
                scheduleGeneration = DeliveryRuntimePolicy.SaturatingIncrement(scheduleGeneration);
                workerStopRequested = false;
                wakeRequested = events.Count > 0;
                nextWakeTimestamp = 0;
                if (events.Count > 0)
                {
                    EnsureWorkerStartedLocked();
                }

                Monitor.PulseAll(gate);
            }
        }

        internal void PurgeDurableDelivery()
        {
            (durableSession ?? throw new SdkException("configuration_error", "client does not own durable delivery"))
                .Purge(this);
        }

        Thread? IDurableDeliveryPurgeOwner.BeginDurablePurge()
        {
            lock (gate)
            {
                RequireOwnerProcessLocked();
                if (closed || closing || deliveryInFlight || lifecycle != DeliveryLifecycleState.Paused)
                {
                    throw new SdkException("state_error", "durable purge requires paused idle delivery");
                }
                workerStopRequested = true;
                wakeRequested = false;
                nextWakeTimestamp = 0;
                Monitor.PulseAll(gate);
                return worker;
            }
        }
        void IDurableDeliveryPurgeOwner.CompleteDurablePurge()
        {
            lock (gate)
            {
                events.Clear();
                frozenBatch = null;
                queuedBytes = 0;
                unavailableDurableRecords = 0;
                unavailableDurableBytes = 0;
                worker = null;
                activity = DeliveryActivityState.Idle;
            }
        }
        void IDurableDeliveryPurgeOwner.FailDurablePurge()
        {
            lock (gate)
            {
                PauseAutomaticLocked(DeliveryPauseReason.Storage, DeliveryOutcome.TerminalFailure);
            }
        }

        private DroppedEvent RecordDropLocked(string id, string type, string reason)
        {
            lastOutcome = DeliveryOutcome.Dropped;
            lastOutcomeAt = DateTimeOffset.UtcNow;
            return dropReporter.Record(id, type, reason);
        }

        private TransportResponse FlushSnapshot(ITransport transport, Event? targetEvent, bool allowClosing)
        {
            EnterDelivery(allowClosing);
            var totalAttempts = 0;
            var statusCode = 204;
            try
            {
                while (true)
                {
                    int targetEvents;
                    lock (gate)
                    {
                        targetEvents = DeliveryQueuePolicy.EventsThrough(events, targetEvent);
                    }

                    var batch = GetOrCreateFrozenBatch(targetEvents);

                    if (batch == null)
                    {
                        break;
                    }

                    var response = DeliveryRuntimePolicy.SendManualBatch(apiKey, transport, batch.Body, maxRetries);
                    totalAttempts += response.Attempts;
                    statusCode = response.StatusCode;
                    AcknowledgeBatch(batch, response.StatusCode);

                }

                lock (gate)
                {
                    CompleteExplicitFlushLocked();
                }

                return new TransportResponse(statusCode, totalAttempts);
            }
            finally
            {
                ExitDelivery();
            }
        }

        private FrozenBatch? GetOrCreateFrozenBatchLocked(int targetEvents)
        {
            frozenBatch = DeliveryQueuePolicy.CreateFrozenBatch(
                frozenBatch,
                batchBuilder,
                events,
                targetEvents,
                dropReporter);
            return frozenBatch;
        }

        private FrozenBatch? GetOrCreateFrozenBatch(int targetEvents)
        {
            if (durableSession == null)
            {
                lock (gate)
                {
                    return GetOrCreateFrozenBatchLocked(targetEvents);
                }
            }

            durableSession.EnterOperation();
            try
            {
                FrozenBatch candidate;
                lock (gate)
                {
                    if (frozenBatch != null)
                    {
                        return frozenBatch;
                    }

                    if (events.Count == 0 || targetEvents <= 0)
                    {
                        return null;
                    }

                    candidate = batchBuilder.Create(events, targetEvents, dropReporter.FreezeReport());
                }

                // Save the counts that left the unreported set first, so a crash never counts them twice.
                SaveDropCounts(force: true);
                durableSession.PersistPrefix(candidate);
                lock (gate)
                {
                    if (frozenBatch != null)
                    {
                        throw new SdkException("state_error", "delivery prefix changed before durable freeze");
                    }

                    frozenBatch = candidate;
                    return frozenBatch;
                }
            }
            catch (Exception error) when (!DeliveryExceptionPolicy.IsFatal(error))
            {
                lock (gate)
                {
                    PauseAutomaticLocked(DeliveryPauseReason.Storage, DeliveryOutcome.TerminalFailure);
                }

                throw error is SdkException sdkError
                    ? sdkError
                    : new SdkException("storage_error", "durable delivery storage is unavailable");
            }
            finally
            {
                durableSession.ExitOperation();
            }
        }

        private void AcknowledgeBatch(FrozenBatch batch, int statusCode)
        {
            if (durableSession == null)
            {
                lock (gate)
                {
                    DeliveryQueuePolicy.RequireCurrentPrefix(events, frozenBatch, batch);
                    RetireBatchLocked(batch, statusCode);
                }

                return;
            }

            durableSession.EnterOperation();
            try
            {
                lock (gate)
                {
                    DeliveryQueuePolicy.RequireCurrentPrefix(events, frozenBatch, batch);
                }

                durableSession.Acknowledge(batch);
                lock (gate)
                {
                    RetireBatchLocked(batch, statusCode);
                }
            }
            catch (Exception error) when (!DeliveryExceptionPolicy.IsFatal(error))
            {
                lock (gate)
                {
                    PauseAutomaticLocked(DeliveryPauseReason.Storage, DeliveryOutcome.TerminalFailure);
                }

                throw error is SdkException sdkError && sdkError.Code == "storage_error"
                    ? sdkError
                    : new SdkException("storage_error", "durable delivery storage is unavailable");
            }
            finally
            {
                durableSession.ExitOperation();
            }
        }

        private void RetireBatchLocked(FrozenBatch batch, int statusCode)
        {
            queuedBytes -= DeliveryQueuePolicy.RemovePrefix(events, batch);
            frozenBatch = null;
            dropReporter.Acknowledge(batch.Report);
            acceptedEvents = DeliveryRuntimePolicy.SaturatingAdd(acceptedEvents, batch.Events.Count);
            acceptedBatches = DeliveryRuntimePolicy.SaturatingIncrement(acceptedBatches);
            lastOutcome = DeliveryOutcome.Accepted;
            lastStatusClass = DeliveryRetryPolicy.StatusClass(statusCode);
            lastOutcomeAt = DateTimeOffset.UtcNow;
        }

        private void EnterDelivery(bool allowClosing)
        {
            lock (gate)
            {
                RequireOwnerProcessLocked();
                if (deliveryInFlight && deliveryOwnerThreadId == Environment.CurrentManagedThreadId)
                {
                    throw new SdkException("reentrancy_error", "delivery cannot reenter its transport callback");
                }

                while (deliveryInFlight)
                {
                    Monitor.Wait(gate);
                    RequireOwnerProcessLocked();
                }

                if (closed || (closing && !allowClosing))
                {
                    throw new SdkException("shutdown_error", "client is already shut down");
                }

                deliveryInFlight = true;
                deliveryOwnerThreadId = Environment.CurrentManagedThreadId;
                activity = DeliveryActivityState.Sending;
            }
        }

        private bool TryEnterAutomaticDelivery(long generation)
        {
            lock (gate)
            {
                if (DeliveryRuntimePolicy.CurrentProcessId() != ownerProcessId)
                {
                    return false;
                }

                while (deliveryInFlight && !workerStopRequested && lifecycle == DeliveryLifecycleState.Running)
                {
                    Monitor.Wait(gate);
                }

                if (workerStopRequested
                    || closing
                    || closed
                    || lifecycle != DeliveryLifecycleState.Running
                    || generation != scheduleGeneration)
                {
                    return false;
                }

                deliveryInFlight = true;
                deliveryOwnerThreadId = Environment.CurrentManagedThreadId;
                activity = DeliveryActivityState.Sending;
                return true;
            }
        }

        private void ExitDelivery()
        {
            lock (gate)
            {
                deliveryInFlight = false;
                deliveryOwnerThreadId = 0;
                if (activity == DeliveryActivityState.Sending)
                {
                    activity = DeliveryActivityState.Idle;
                }

                Monitor.PulseAll(gate);
            }
        }

        private void ScheduleCaptureLocked(bool wasEmpty)
        {
            if (automaticSettings == null || lifecycle != DeliveryLifecycleState.Running)
            {
                return;
            }

            EnsureWorkerStartedLocked();
            if (frozenBatch != null && retryAttempt > 0)
            {
                activity = DeliveryActivityState.Retrying;
                return;
            }

            if (events.Count >= automaticSettings.FlushAtQueueSize)
            {
                wakeRequested = true;
                nextWakeTimestamp = 0;
            }
            else if (wasEmpty && nextWakeTimestamp == 0)
            {
                nextWakeTimestamp = DeliveryRuntimePolicy.AddMonotonicDelay(automaticSettings.FlushInterval);
            }

            activity = DeliveryActivityState.Scheduled;
            Monitor.PulseAll(gate);
        }

        private void EnsureWorkerStartedLocked()
        {
            if (worker != null && worker.IsAlive)
            {
                return;
            }

            workerStopRequested = false;
            worker = new Thread(WorkerLoop)
            {
                IsBackground = true,
                Name = "LogBrew automatic delivery",
            };
            worker.Start();
        }

        private void WorkerLoop()
        {
            try
            {
                while (true)
                {
                    long generation;
                    lock (gate)
                    {
                        while (true)
                        {
                            if (workerStopRequested || closing || closed || DeliveryRuntimePolicy.CurrentProcessId() != ownerProcessId)
                            {
                                return;
                            }

                            if (lifecycle == DeliveryLifecycleState.Paused || events.Count == 0)
                            {
                                activity = DeliveryActivityState.Idle;
                                Monitor.Wait(gate);
                                continue;
                            }

                            if (wakeRequested || DeliveryRuntimePolicy.IsMonotonicDue(nextWakeTimestamp))
                            {
                                break;
                            }

                            activity = retryAttempt > 0 ? DeliveryActivityState.Retrying : DeliveryActivityState.Scheduled;
                            Monitor.Wait(gate, DeliveryRuntimePolicy.RemainingMonotonicDelay(nextWakeTimestamp));
                        }

                        wakeRequested = false;
                        nextWakeTimestamp = 0;
                        generation = scheduleGeneration;
                    }

                    RunAutomaticDelivery(generation);
                }
            }
            catch (Exception error) when (!DeliveryExceptionPolicy.IsFatal(error))
            {
                lock (gate)
                {
                    if (!closed
                        && !closing
                        && lifecycle == DeliveryLifecycleState.Running
                        && DeliveryRuntimePolicy.CurrentProcessId() == ownerProcessId)
                    {
                        consecutiveFailures = DeliveryRuntimePolicy.SaturatingIncrement(consecutiveFailures);
                        lastStatusClass = DeliveryStatusClass.None;
                        lastOutcomeAt = DateTimeOffset.UtcNow;
                        PauseAutomaticLocked(DeliveryPauseReason.NonRetryable, DeliveryOutcome.TerminalFailure);
                    }

                    Monitor.PulseAll(gate);
                }
            }
            finally
            {
                lock (gate)
                {
                    if (ReferenceEquals(worker, Thread.CurrentThread))
                    {
                        worker = null;
                    }

                    if (!closed && !closing && lifecycle == DeliveryLifecycleState.Running)
                    {
                        activity = events.Count == 0 ? DeliveryActivityState.Idle : DeliveryActivityState.Scheduled;
                    }

                    Monitor.PulseAll(gate);
                }
            }
        }

        private void RunAutomaticDelivery(long generation)
        {
            if (!TryEnterAutomaticDelivery(generation))
            {
                return;
            }

            FrozenBatch? batch = null;
            TransportResponse? response = null;
            Exception? failure = null;
            try
            {
                int targetEvents;
                lock (gate)
                {
                    targetEvents = events.Count;
                }

                batch = GetOrCreateFrozenBatch(targetEvents);

                if (batch == null)
                {
                    return;
                }

                try
                {
                    response = automaticTransport!.Send(apiKey, batch.Body);
                }
                catch (Exception error) when (!DeliveryExceptionPolicy.IsFatal(error))
                {
                    failure = error;
                }

                if (response != null && response.StatusCode >= 200 && response.StatusCode < 300)
                {
                    AcknowledgeBatch(batch, response.StatusCode);
                    lock (gate)
                    {
                        if (generation == scheduleGeneration && lifecycle == DeliveryLifecycleState.Running && !closing)
                        {
                            CompleteAutomaticSuccessLocked();
                        }
                    }

                    return;
                }

                lock (gate)
                {
                    if (generation != scheduleGeneration || lifecycle != DeliveryLifecycleState.Running || closing)
                    {
                        return;
                    }

                    CompleteAutomaticFailureLocked(response, failure);
                }
            }
            finally
            {
                ExitDelivery();
            }
        }

        private void CompleteAutomaticSuccessLocked()
        {
            retryAttempt = 0;
            retryDelayMilliseconds = 0;
            consecutiveFailures = 0;
            retrySource = DeliveryRetrySource.None;
            pauseReason = DeliveryPauseReason.None;
            ScheduleLiveWorkLocked();
        }

        private void CompleteExplicitFlushLocked()
        {
            if (automaticSettings == null
                || lifecycle != DeliveryLifecycleState.Running
                || closing
                || closed)
            {
                return;
            }

            scheduleGeneration = DeliveryRuntimePolicy.SaturatingIncrement(scheduleGeneration);
            retryAttempt = 0;
            retryDelayMilliseconds = 0;
            consecutiveFailures = 0;
            retrySource = DeliveryRetrySource.None;
            pauseReason = DeliveryPauseReason.None;
            ScheduleLiveWorkLocked();
        }

        private void ScheduleLiveWorkLocked()
        {
            if (events.Count == 0)
            {
                wakeRequested = false;
                nextWakeTimestamp = 0;
                activity = DeliveryActivityState.Idle;
                return;
            }

            if (events.Count >= automaticSettings!.FlushAtQueueSize)
            {
                wakeRequested = true;
                nextWakeTimestamp = 0;
            }
            else
            {
                wakeRequested = false;
                nextWakeTimestamp = DeliveryRuntimePolicy.AddMonotonicDelay(automaticSettings.FlushInterval);
            }

            activity = DeliveryActivityState.Scheduled;
            Monitor.PulseAll(gate);
        }

        private void CompleteAutomaticFailureLocked(TransportResponse? response, Exception? failure)
        {
            consecutiveFailures = DeliveryRuntimePolicy.SaturatingIncrement(consecutiveFailures);
            lastOutcomeAt = DateTimeOffset.UtcNow;
            lastStatusClass = failure is TransportException
                ? DeliveryStatusClass.Network
                : DeliveryRetryPolicy.StatusClass(response?.StatusCode ?? 0);

            var retryable = response != null
                ? DeliveryRetryPolicy.IsRetryableStatus(response.StatusCode)
                : failure is TransportException transportFailure && transportFailure.Retryable;
            if (retryable)
            {
                retryAttempt = DeliveryRuntimePolicy.SaturatingIncrement(retryAttempt);
                if (retryAttempt > automaticSettings!.MaxRetries)
                {
                    PauseAutomaticLocked(DeliveryPauseReason.RetryExhausted, DeliveryOutcome.RetryExhausted);
                    return;
                }

                var delay = retryPolicy.Delay(response?.RetryAfter, retryAttempt, automaticSettings, out var source);
                retryDelayMilliseconds = DeliveryRetryPolicy.BoundedMilliseconds(delay);
                retrySource = source;
                lastOutcome = DeliveryOutcome.RetryScheduled;
                activity = DeliveryActivityState.Retrying;
                wakeRequested = false;
                nextWakeTimestamp = DeliveryRuntimePolicy.AddMonotonicDelay(delay);
                Monitor.PulseAll(gate);
                return;
            }

            var reason = response == null
                ? DeliveryPauseReason.NonRetryable
                : DeliveryRetryPolicy.PauseReason(response.StatusCode);
            PauseAutomaticLocked(reason, DeliveryOutcome.TerminalFailure);
        }

        private void PauseAutomaticLocked(DeliveryPauseReason reason, DeliveryOutcome outcome)
        {
            lifecycle = DeliveryLifecycleState.Paused;
            activity = DeliveryActivityState.Idle;
            pauseReason = reason;
            retrySource = DeliveryRetrySource.None;
            retryDelayMilliseconds = 0;
            lastOutcome = outcome;
            wakeRequested = false;
            nextWakeTimestamp = 0;
        }

        private void RequireOpenLocked()
        {
            RequireOwnerProcessLocked();
            if (closed || closing)
            {
                throw new SdkException("shutdown_error", "client is already shut down");
            }
        }

        private void RequireOwnerProcessLocked()
        {
            DeliveryRuntimePolicy.RequireOwnerProcess(ownerProcessId);
        }

    }
}
