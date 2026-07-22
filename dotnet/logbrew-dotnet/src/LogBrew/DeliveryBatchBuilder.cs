using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace LogBrew
{
    internal sealed class DeliveryBatchBuilder
    {
        internal const int MaxRequestEvents = 100;
        internal const int MaxRequestBytes = 256 * 1024;
        private readonly OrderedJsonObject sdk;

        internal DeliveryBatchBuilder(OrderedJsonObject sdk)
        {
            this.sdk = sdk;
        }

        internal int SingleEventRequestBytes(Event item)
        {
            return Encoding.UTF8.GetByteCount(BuildBody(new[] { item }));
        }

        internal string BuildBody(IEnumerable<Event> events)
        {
            return JsonWriter.Write(new OrderedJsonObject()
                .Add("sdk", sdk)
                .Add("events", events.Select(item => item.ToJsonObject()).ToList()));
        }

        internal FrozenBatch Create(IReadOnlyList<Event> events, int targetEvents)
        {
            var selected = new List<Event>();
            string? selectedBody = null;
            var limit = Math.Min(Math.Min(events.Count, targetEvents), MaxRequestEvents);
            for (var index = 0; index < limit; index++)
            {
                selected.Add(events[index]);
                var candidate = BuildBody(selected);
                if (Encoding.UTF8.GetByteCount(candidate) > MaxRequestBytes)
                {
                    selected.RemoveAt(selected.Count - 1);
                    break;
                }

                selectedBody = candidate;
            }

            if (selected.Count == 0 || selectedBody == null)
            {
                throw new SdkException("serialization_error", "queued event exceeds request byte limit");
            }

            return new FrozenBatch(selected, selectedBody);
        }
    }

    internal sealed class FrozenBatch
    {
        internal FrozenBatch(IReadOnlyList<Event> events, string body)
        {
            Events = events;
            Body = body;
        }

        internal IReadOnlyList<Event> Events { get; }

        internal string Body { get; }
    }
}
