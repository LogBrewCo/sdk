using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Threading;

namespace LogBrew
{
    internal sealed class DeliveryEngine
    {
        private readonly string apiKey;
        private readonly DeliveryBatchBuilder batchBuilder;
        private readonly int maxRetries;
        private readonly int maxQueueSize;
        private readonly int maxQueueBytes;
        private readonly Action<DroppedEvent>? onEventDropped;
        private readonly ITransport? automaticTransport;
        private readonly AutomaticDeliverySettings? automaticSettings;
        private readonly DeliveryRetryPolicy retryPolicy = new DeliveryRetryPolicy();
        private readonly List<Event> events = new List<Event>();
        private readonly object gate = new object();
        private readonly int ownerProcessId;
        private FrozenBatch? frozenBatch;
        private Thread? worker;
        private bool workerStopRequested;
        private bool wakeRequested;
        private long nextWakeTimestamp;
        private long scheduleGeneration;
        private bool deliveryInFlight;
        private int deliveryOwnerThreadId;
        private int queuedBytes;
        private int droppedEvents;
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
            AutomaticDeliverySettings? automaticSettings)
        {
            this.apiKey = apiKey;
            batchBuilder = new DeliveryBatchBuilder(sdk);
            this.maxRetries = maxRetries;
            this.maxQueueSize = maxQueueSize;
            this.maxQueueBytes = maxQueueBytes;
            this.onEventDropped = onEventDropped;
            this.automaticTransport = automaticTransport;
            this.automaticSettings = automaticSettings;
            ownerProcessId = CurrentProcessId();
            lifecycle = automaticSettings == null ? DeliveryLifecycleState.Manual : DeliveryLifecycleState.Running;
            activity = DeliveryActivityState.Idle;
        }

        internal int PendingEvents()
        {
            lock (gate)
            {
                RequireOwnerProcessLocked();
                return events.Count;
            }
        }

        internal int DroppedEvents()
        {
            lock (gate)
            {
                RequireOwnerProcessLocked();
                return droppedEvents;
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
                    events.Count,
                    queuedBytes,
                    deliveryInFlight,
                    wakeRequested || nextWakeTimestamp != 0,
                    retryAttempt,
                    retryDelayMilliseconds,
                    consecutiveFailures,
                    acceptedEvents,
                    acceptedBatches,
                    droppedEvents,
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
            lock (gate)
            {
                RequireOpenLocked();
                if (singleBodyBytes > DeliveryBatchBuilder.MaxRequestBytes)
                {
                    drop = RecordDropLocked(item.Id, item.Type, "event_too_large");
                }
                else if (events.Count >= maxQueueSize)
                {
                    drop = RecordDropLocked(item.Id, item.Type, "queue_overflow");
                }
                else if (item.SerializedByteCount > maxQueueBytes - queuedBytes)
                {
                    drop = RecordDropLocked(item.Id, item.Type, "queue_bytes_overflow");
                }
                else
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

            if (drop != null)
            {
                ReportDroppedEvent(drop);
            }
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
                targetEvent = LastQueuedEventLocked();
            }

            return FlushSnapshot(transport, targetEvent, allowClosing: false);
        }

        internal TransportResponse Flush()
        {
            return Flush(RequireAutomaticTransport());
        }

        internal TransportResponse Shutdown(ITransport transport)
        {
            if (transport == null)
            {
                throw new SdkException("validation_error", "transport must be non-null");
            }

            Thread? workerToJoin;
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
                scheduleGeneration = SaturatingIncrement(scheduleGeneration);
                workerStopRequested = true;
                wakeRequested = false;
                nextWakeTimestamp = 0;
                Monitor.PulseAll(gate);
                workerToJoin = worker;
            }

            JoinWorker(workerToJoin);

            try
            {
                Event? targetEvent;
                lock (gate)
                {
                    targetEvent = LastQueuedEventLocked();
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

                return response;
            }
#pragma warning disable CA1031
            catch (Exception error) when (!IsFatalException(error))
#pragma warning restore CA1031
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
            return Shutdown(RequireAutomaticTransport());
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
                scheduleGeneration = SaturatingIncrement(scheduleGeneration);
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

        private DroppedEvent RecordDropLocked(string id, string type, string reason)
        {
            droppedEvents = SaturatingIncrement(droppedEvents);
            lastOutcome = DeliveryOutcome.Dropped;
            lastOutcomeAt = DateTimeOffset.UtcNow;
            return new DroppedEvent(id, type, reason, droppedEvents);
        }

        private void ReportDroppedEvent(DroppedEvent drop)
        {
            if (onEventDropped == null)
            {
                return;
            }

            try
            {
                onEventDropped(drop);
            }
#pragma warning disable CA1031
            catch (Exception error) when (!IsFatalException(error))
#pragma warning restore CA1031
            {
                // Drop callbacks are advisory and must not interrupt application telemetry.
            }
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
                    FrozenBatch? batch;
                    lock (gate)
                    {
                        batch = GetOrCreateFrozenBatchLocked(EventsThroughTargetLocked(targetEvent));
                    }

                    if (batch == null)
                    {
                        break;
                    }

                    var response = SendManualBatch(transport, batch.Body);
                    totalAttempts += response.Attempts;
                    statusCode = response.StatusCode;
                    lock (gate)
                    {
                        AcknowledgeBatchLocked(batch, response.StatusCode);
                    }

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

        private TransportResponse SendManualBatch(ITransport transport, string body)
        {
            var attempt = 0;
            while (true)
            {
                attempt++;
                try
                {
                    var response = transport.Send(apiKey, body);
                    if (response.StatusCode >= 200 && response.StatusCode < 300)
                    {
                        return new TransportResponse(response.StatusCode, attempt);
                    }

                    if (DeliveryRetryPolicy.IsRetryableStatus(response.StatusCode) && attempt <= maxRetries)
                    {
                        continue;
                    }

                    throw StatusException(response.StatusCode);
                }
                catch (TransportException error)
                {
                    if (error.Retryable && attempt <= maxRetries)
                    {
                        continue;
                    }

                    throw new SdkException(error.Code, error.Message);
                }
            }
        }

        private FrozenBatch? GetOrCreateFrozenBatchLocked(int targetEvents)
        {
            if (frozenBatch != null)
            {
                return frozenBatch;
            }

            if (events.Count == 0 || targetEvents <= 0)
            {
                return null;
            }

            frozenBatch = batchBuilder.Create(events, targetEvents);
            return frozenBatch;
        }

        private Event? LastQueuedEventLocked()
        {
            return events.Count == 0 ? null : events[events.Count - 1];
        }

        private int EventsThroughTargetLocked(Event? targetEvent)
        {
            if (targetEvent == null)
            {
                return 0;
            }

            for (var index = 0; index < events.Count; index++)
            {
                if (ReferenceEquals(events[index], targetEvent))
                {
                    return index + 1;
                }
            }

            return 0;
        }

        private void AcknowledgeBatchLocked(FrozenBatch batch, int statusCode)
        {
            if (!ReferenceEquals(frozenBatch, batch) || events.Count < batch.Events.Count)
            {
                throw new SdkException("state_error", "delivery prefix changed before acknowledgement");
            }

            for (var index = 0; index < batch.Events.Count; index++)
            {
                if (!ReferenceEquals(events[index], batch.Events[index]))
                {
                    throw new SdkException("state_error", "delivery prefix order changed before acknowledgement");
                }
            }

            for (var index = 0; index < batch.Events.Count; index++)
            {
                queuedBytes -= events[index].SerializedByteCount;
            }

            events.RemoveRange(0, batch.Events.Count);
            frozenBatch = null;
            acceptedEvents = SaturatingAdd(acceptedEvents, batch.Events.Count);
            acceptedBatches = SaturatingIncrement(acceptedBatches);
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
                if (CurrentProcessId() != ownerProcessId)
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
                nextWakeTimestamp = AddMonotonicDelay(automaticSettings.FlushInterval);
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
                            if (workerStopRequested || closing || closed || CurrentProcessId() != ownerProcessId)
                            {
                                return;
                            }

                            if (lifecycle == DeliveryLifecycleState.Paused || events.Count == 0)
                            {
                                activity = DeliveryActivityState.Idle;
                                Monitor.Wait(gate);
                                continue;
                            }

                            if (wakeRequested || IsMonotonicDue(nextWakeTimestamp))
                            {
                                break;
                            }

                            activity = retryAttempt > 0 ? DeliveryActivityState.Retrying : DeliveryActivityState.Scheduled;
                            Monitor.Wait(gate, RemainingMonotonicDelay(nextWakeTimestamp));
                        }

                        wakeRequested = false;
                        nextWakeTimestamp = 0;
                        generation = scheduleGeneration;
                    }

                    RunAutomaticDelivery(generation);
                }
            }
#pragma warning disable CA1031
            catch (Exception error) when (!IsFatalException(error))
#pragma warning restore CA1031
            {
                lock (gate)
                {
                    if (!closed && !closing && CurrentProcessId() == ownerProcessId)
                    {
                        consecutiveFailures = SaturatingIncrement(consecutiveFailures);
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
                lock (gate)
                {
                    batch = GetOrCreateFrozenBatchLocked(events.Count);
                }

                if (batch == null)
                {
                    return;
                }

                try
                {
                    response = automaticTransport!.Send(apiKey, batch.Body);
                }
#pragma warning disable CA1031
                catch (Exception error) when (!IsFatalException(error))
#pragma warning restore CA1031
                {
                    failure = error;
                }

                lock (gate)
                {
                    if (response != null && response.StatusCode >= 200 && response.StatusCode < 300)
                    {
                        AcknowledgeBatchLocked(batch, response.StatusCode);
                        if (generation == scheduleGeneration && lifecycle == DeliveryLifecycleState.Running && !closing)
                        {
                            CompleteAutomaticSuccessLocked();
                        }

                        return;
                    }

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

            scheduleGeneration = SaturatingIncrement(scheduleGeneration);
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
                nextWakeTimestamp = AddMonotonicDelay(automaticSettings.FlushInterval);
            }

            activity = DeliveryActivityState.Scheduled;
            Monitor.PulseAll(gate);
        }

        private void CompleteAutomaticFailureLocked(TransportResponse? response, Exception? failure)
        {
            consecutiveFailures = SaturatingIncrement(consecutiveFailures);
            lastOutcomeAt = DateTimeOffset.UtcNow;
            lastStatusClass = failure is TransportException
                ? DeliveryStatusClass.Network
                : DeliveryRetryPolicy.StatusClass(response?.StatusCode ?? 0);

            var retryable = response != null
                ? DeliveryRetryPolicy.IsRetryableStatus(response.StatusCode)
                : failure is TransportException transportFailure && transportFailure.Retryable;
            if (retryable)
            {
                retryAttempt = SaturatingIncrement(retryAttempt);
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
                nextWakeTimestamp = AddMonotonicDelay(delay);
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

        private ITransport RequireAutomaticTransport()
        {
            if (automaticTransport == null)
            {
                throw new SdkException("configuration_error", "client does not own automatic delivery");
            }

            return automaticTransport;
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
            if (CurrentProcessId() != ownerProcessId)
            {
                throw new SdkException("process_error", "client belongs to another process; create a fresh client after fork");
            }
        }

        private static SdkException StatusException(int statusCode)
        {
            if (statusCode == 401 || statusCode == 403)
            {
                return new SdkException("unauthenticated", "transport rejected the API key");
            }

            return new SdkException(
                "transport_error",
                "unexpected transport status " + statusCode.ToString(CultureInfo.InvariantCulture));
        }

        private static bool IsFatalException(Exception error)
        {
            return error is OutOfMemoryException
                || error is StackOverflowException
                || error is AccessViolationException
                || error is AppDomainUnloadedException
                || error is BadImageFormatException;
        }

        private static int CurrentProcessId()
        {
            using var process = Process.GetCurrentProcess();
            return process.Id;
        }

        private static long AddMonotonicDelay(TimeSpan delay)
        {
            var delta = delay.TotalSeconds * Stopwatch.Frequency;
            var now = Stopwatch.GetTimestamp();
            if (delta >= long.MaxValue - now)
            {
                return long.MaxValue;
            }

            return now + (long)delta;
        }

        private static bool IsMonotonicDue(long timestamp)
        {
            return timestamp != 0 && Stopwatch.GetTimestamp() >= timestamp;
        }

        private static TimeSpan RemainingMonotonicDelay(long timestamp)
        {
            if (timestamp == 0)
            {
                return TimeSpan.FromMilliseconds(100);
            }

            var remaining = timestamp - Stopwatch.GetTimestamp();
            if (remaining <= 0)
            {
                return TimeSpan.Zero;
            }

            var maximumMonitorWait = TimeSpan.FromMilliseconds(int.MaxValue - 1D);
            var remainingSeconds = (double)remaining / Stopwatch.Frequency;
            return remainingSeconds >= maximumMonitorWait.TotalSeconds
                ? maximumMonitorWait
                : TimeSpan.FromSeconds(remainingSeconds);
        }

        private static int SaturatingIncrement(int value)
        {
            return value == int.MaxValue ? value : value + 1;
        }

        private static long SaturatingIncrement(long value)
        {
            return value == long.MaxValue ? value : value + 1;
        }

        private static long SaturatingAdd(long value, int increment)
        {
            return value > long.MaxValue - increment ? long.MaxValue : value + increment;
        }

        private static void JoinWorker(Thread? thread)
        {
            if (thread != null && thread.IsAlive)
            {
                thread.Join();
            }
        }
    }

}
