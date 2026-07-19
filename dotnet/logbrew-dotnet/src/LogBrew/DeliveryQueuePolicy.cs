using System.Collections.Generic;

namespace LogBrew
{
    internal static class DeliveryQueuePolicy
    {
        internal static string? AdmissionDropReason(
            Event item,
            int singleBodyBytes,
            int eventCount,
            int queuedBytes,
            int maxQueueSize,
            int maxQueueBytes)
        {
            if (singleBodyBytes > DeliveryBatchBuilder.MaxRequestBytes)
            {
                return "event_too_large";
            }

            if (eventCount >= maxQueueSize)
            {
                return "queue_overflow";
            }

            return item.SerializedByteCount > maxQueueBytes - queuedBytes
                ? "queue_bytes_overflow"
                : null;
        }

        internal static Event? Last(IReadOnlyList<Event> events)
        {
            return events.Count == 0 ? null : events[events.Count - 1];
        }

        internal static int EventsThrough(IReadOnlyList<Event> events, Event? targetEvent)
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

        internal static FrozenBatch? CreateFrozenBatch(
            FrozenBatch? current,
            DeliveryBatchBuilder builder,
            IReadOnlyList<Event> events,
            int targetEvents)
        {
            if (current != null || events.Count == 0 || targetEvents <= 0)
            {
                return current;
            }

            return builder.Create(events, targetEvents);
        }

        internal static void RequireCurrentPrefix(
            IReadOnlyList<Event> events,
            FrozenBatch? current,
            FrozenBatch expected)
        {
            if (!ReferenceEquals(current, expected) || events.Count < expected.Events.Count)
            {
                throw new SdkException("state_error", "delivery prefix changed before acknowledgement");
            }

            for (var index = 0; index < expected.Events.Count; index++)
            {
                if (!ReferenceEquals(events[index], expected.Events[index]))
                {
                    throw new SdkException("state_error", "delivery prefix order changed before acknowledgement");
                }
            }
        }

        internal static int RemovePrefix(List<Event> events, FrozenBatch batch)
        {
            var removedBytes = 0;
            for (var index = 0; index < batch.Events.Count; index++)
            {
                removedBytes += events[index].SerializedByteCount;
            }

            events.RemoveRange(0, batch.Events.Count);
            return removedBytes;
        }
    }
}
