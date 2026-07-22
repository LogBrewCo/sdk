#if NET8_0_OR_GREATER
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;

namespace LogBrew
{
    internal sealed class DurableDeliverySession : IDurableDeliverySession
    {
        private readonly IDurableDeliveryStore store;
        private readonly object operationGate = new object();
        private readonly Dictionary<Event, string> recordNames = new Dictionary<Event, string>();
        private DurableRecoveryState? recoveryState;
        private bool recoveryFailed;
        private bool disposed;

        internal DurableDeliverySession(IDurableDeliveryStore store)
        {
            this.store = store;
            var snapshot = store.Load();
            if (snapshot.RecoveryFailed)
            {
                recoveryFailed = true;
                recoveryState = new DurableRecoveryState(
                    Array.Empty<Event>(),
                    null,
                    recoveryFailed: true,
                    snapshot.PersistedRecordCount,
                    snapshot.PersistedBytes);
                return;
            }

            foreach (var storedEvent in snapshot.Events)
            {
                recordNames.Add(storedEvent.Item, storedEvent.RecordName);
            }

            FrozenBatch? frozenBatch = null;
            if (snapshot.Prefix != null)
            {
                var frozenEvents = snapshot.Events
                    .Take(snapshot.Prefix.RecordNames.Count)
                    .Select(storedEvent => storedEvent.Item)
                    .ToList();
                frozenBatch = new FrozenBatch(frozenEvents, snapshot.Prefix.Body);
            }

            recoveryState = new DurableRecoveryState(
                snapshot.Events.Select(storedEvent => storedEvent.Item).ToList(),
                frozenBatch,
                recoveryFailed: false,
                snapshot.PersistedRecordCount,
                snapshot.PersistedBytes);
        }

        public void EnterOperation()
        {
            Monitor.Enter(operationGate);
        }

        public void ExitOperation()
        {
            Monitor.Exit(operationGate);
        }

        public string Persist(Event item)
        {
            RequireActive();
            RequireRecovered();
            store.ValidateOwnership();
            return store.PersistEvent(item);
        }

        public void Track(Event item, string recordName)
        {
            RequireActive();
            recordNames.Add(item, recordName);
        }

        public DurableRecoveryState TakeRecoveryState(int maxQueueSize, int maxQueueBytes)
        {
            RequireActive();
            var recovered = recoveryState ?? throw new SdkException("state_error", "durable recovery state was already consumed");
            recoveryState = null;
            var queuedBytes = recovered.Events.Sum(item => (long)item.SerializedByteCount);
            if (recovered.Events.Count > maxQueueSize || queuedBytes > maxQueueBytes)
            {
                recoveryFailed = true;
                return new DurableRecoveryState(
                    Array.Empty<Event>(),
                    null,
                    recoveryFailed: true,
                    recovered.PersistedRecordCount,
                    recovered.PersistedBytes);
            }

            return recovered;
        }

        public void PersistPrefix(FrozenBatch batch)
        {
            RequireActive();
            RequireRecovered();
            store.ValidateOwnership();
            store.PersistPrefix(batch.Body, NamesFor(batch));
        }

        public void Acknowledge(FrozenBatch batch)
        {
            RequireActive();
            RequireRecovered();
            var names = NamesFor(batch);
            store.ValidateOwnership();
            store.AcknowledgePrefix(names);
            foreach (var item in batch.Events)
            {
                recordNames.Remove(item);
            }
        }

        public void Purge(IDurableDeliveryPurgeOwner owner)
        {
            EnterOperation();
            try
            {
                var worker = owner.BeginDurablePurge();
                DeliveryRuntimePolicy.JoinWorker(worker);
                try
                {
                    RequireActive();
                    store.ValidateOwnership();
                    store.Purge();
                }
                catch (Exception error) when (!DeliveryExceptionPolicy.IsFatal(error))
                {
                    owner.FailDurablePurge();
                    throw error is SdkException sdkError && sdkError.Code == "storage_error"
                        ? sdkError
                        : new SdkException("storage_error", "durable delivery storage is unavailable");
                }

                recordNames.Clear();
                recoveryFailed = false;
                recoveryState = null;
                owner.CompleteDurablePurge();
            }
            finally
            {
                ExitOperation();
            }
        }

        public void Dispose()
        {
            EnterOperation();
            try
            {
                if (!disposed)
                {
                    store.Dispose();
                    recordNames.Clear();
                    disposed = true;
                }
            }
            finally
            {
                ExitOperation();
            }
        }

        private void RequireActive()
        {
            if (disposed)
            {
                throw new SdkException("storage_error", "durable delivery storage is unavailable");
            }
        }

        private void RequireRecovered()
        {
            if (recoveryFailed)
            {
                throw new SdkException("storage_error", "durable delivery storage is unavailable");
            }
        }

        private List<string> NamesFor(FrozenBatch batch)
        {
            var names = new List<string>(batch.Events.Count);
            foreach (var item in batch.Events)
            {
                if (!recordNames.TryGetValue(item, out var recordName))
                {
                    throw new SdkException("state_error", "durable delivery record mapping changed");
                }

                names.Add(recordName);
            }

            return names;
        }
    }

}
#endif
