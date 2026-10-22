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

        internal string BuildBody(IEnumerable<Event> events, ClientReport? report = null)
        {
            var body = new OrderedJsonObject()
                .Add("sdk", sdk)
                .Add("events", events.Select(item => item.ToJsonObject()).ToList());
            body.AddIfNotNull("client_report", report?.ToJsonObject());
            return JsonWriter.Write(body);
        }

        internal FrozenBatch Create(IReadOnlyList<Event> events, int targetEvents, ClientReport? report)
        {
            // A report never pushes a request over the byte limit; it waits for a request with room.
            return (report == null ? null : TryCreate(events, targetEvents, report))
                ?? TryCreate(events, targetEvents, null)
                ?? throw new SdkException("serialization_error", "queued event exceeds request byte limit");
        }

        private FrozenBatch? TryCreate(IReadOnlyList<Event> events, int targetEvents, ClientReport? report)
        {
            var selected = new List<Event>();
            string? selectedBody = null;
            var limit = Math.Min(Math.Min(events.Count, targetEvents), MaxRequestEvents);
            for (var index = 0; index < limit; index++)
            {
                selected.Add(events[index]);
                var candidate = BuildBody(selected, report);
                if (Encoding.UTF8.GetByteCount(candidate) > MaxRequestBytes)
                {
                    selected.RemoveAt(selected.Count - 1);
                    break;
                }

                selectedBody = candidate;
            }

            return selectedBody == null ? null : new FrozenBatch(selected, selectedBody, report);
        }
    }

    internal sealed class FrozenBatch
    {
        internal FrozenBatch(IReadOnlyList<Event> events, string body, ClientReport? report = null)
        {
            Events = events;
            Body = body;
            Report = report;
        }

        internal IReadOnlyList<Event> Events { get; }

        internal string Body { get; }

        internal ClientReport? Report { get; }
    }
}
