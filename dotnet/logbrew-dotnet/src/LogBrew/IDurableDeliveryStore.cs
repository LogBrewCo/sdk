using System;
using System.Collections.Generic;

namespace LogBrew
{
    internal interface IDurableDeliveryStore : IDisposable
    {
        DurableStoreSnapshot Load();

        void ValidateOwnership();

        string PersistEvent(Event item);

        void RemoveEvents(IReadOnlyList<string> recordNames);

        void PersistPrefix(string body, IReadOnlyList<string> recordNames);

        void AcknowledgePrefix(IReadOnlyList<string> recordNames);

        // Stores drop counts no request has carried yet; an empty set removes the saved state.
        void SaveClientReport(IReadOnlyDictionary<string, int> unreported);

        void Purge();
    }

    internal sealed class DurableStoreSnapshot
    {
        internal DurableStoreSnapshot(
            IReadOnlyList<DurableStoredEvent> events,
            DurableStoredPrefix? prefix,
            bool recoveryFailed,
            int persistedRecordCount,
            long persistedBytes,
            IReadOnlyDictionary<string, int>? unreportedDrops = null)
        {
            Events = events;
            Prefix = prefix;
            RecoveryFailed = recoveryFailed;
            PersistedRecordCount = persistedRecordCount;
            PersistedBytes = persistedBytes;
            UnreportedDrops = unreportedDrops ?? new Dictionary<string, int>();
        }

        internal IReadOnlyList<DurableStoredEvent> Events { get; }

        internal DurableStoredPrefix? Prefix { get; }

        internal bool RecoveryFailed { get; }

        internal int PersistedRecordCount { get; }

        internal long PersistedBytes { get; }

        internal IReadOnlyDictionary<string, int> UnreportedDrops { get; }
    }

    internal sealed class DurableStoredEvent
    {
        internal DurableStoredEvent(Event item, string recordName, long sequence)
        {
            Item = item;
            RecordName = recordName;
            Sequence = sequence;
        }

        internal Event Item { get; }

        internal string RecordName { get; }

        internal long Sequence { get; }
    }

    internal sealed class DurableStoredPrefix
    {
        internal DurableStoredPrefix(string body, IReadOnlyList<string> recordNames)
        {
            Body = body;
            RecordNames = recordNames;
        }

        internal string Body { get; }

        internal IReadOnlyList<string> RecordNames { get; }
    }
}
