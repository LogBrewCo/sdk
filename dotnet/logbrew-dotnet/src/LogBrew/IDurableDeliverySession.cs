using System;
using System.Collections.Generic;
using System.Threading;

namespace LogBrew
{
    internal interface IDurableDeliverySession : IDisposable
    {
        void EnterOperation();

        void ExitOperation();

        string Persist(Event item);

        void Track(Event item, string recordName);

        DurableRecoveryState TakeRecoveryState(int maxQueueSize, int maxQueueBytes);

        void PersistPrefix(FrozenBatch batch);

        void Acknowledge(FrozenBatch batch);

        void Purge(IDurableDeliveryPurgeOwner owner);
    }

    internal interface IDurableDeliveryPurgeOwner
    {
        Thread? BeginDurablePurge();

        void CompleteDurablePurge();

        void FailDurablePurge();
    }

    internal sealed class DurableRecoveryState
    {
        internal DurableRecoveryState(
            IReadOnlyList<Event> events,
            FrozenBatch? frozenBatch,
            bool recoveryFailed,
            int persistedRecordCount,
            long persistedBytes)
        {
            Events = events;
            FrozenBatch = frozenBatch;
            RecoveryFailed = recoveryFailed;
            PersistedRecordCount = persistedRecordCount;
            PersistedBytes = persistedBytes;
        }

        internal IReadOnlyList<Event> Events { get; }

        internal FrozenBatch? FrozenBatch { get; }

        internal bool RecoveryFailed { get; }

        internal int PersistedRecordCount { get; }

        internal long PersistedBytes { get; }
    }
}
