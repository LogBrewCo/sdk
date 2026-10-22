using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;

namespace LogBrew
{
    internal sealed class DeliveryDropReporter
    {
        internal const int MaxClientReportReasons = 16;
        internal const int MaxClientReportCount = 1_000_000_000;

        [ThreadStatic]
        private static DeliveryDropReporter? activeReporter;

        private readonly Action<DroppedEvent>? callback;
        // Drops not yet acknowledged by LogBrew; they ride in the next request as a client report.
        private readonly Dictionary<string, int> unreportedDrops = new Dictionary<string, int>(StringComparer.Ordinal);
        // Drops frozen under one report ID until a 2xx acknowledges a request that carried them.
        private ClientReport? pendingReport;
        private int droppedEvents;
        // Persistent clients save unreported counts at once for a new reason and at most once a second in a burst.
        private bool unsaved;
        private bool saveAtOnce;
        private long savedAtTimestamp;

        internal DeliveryDropReporter(Action<DroppedEvent>? callback)
        {
            this.callback = callback;
        }

        internal int Count
        {
            get { return droppedEvents; }
        }

        internal DroppedEvent Record(string id, string type, string reason)
        {
            droppedEvents = DeliveryRuntimePolicy.SaturatingIncrement(droppedEvents);
            var seen = unreportedDrops.TryGetValue(reason, out var unreported);
            unreportedDrops[reason] = Math.Min(MaxClientReportCount, unreported + 1);
            unsaved = true;
            saveAtOnce |= !seen;
            return new DroppedEvent(id, type, reason, droppedEvents);
        }

        // Returns the report the next request carries. Every resend of it keeps its ID, so LogBrew counts it once.
        internal ClientReport? FreezeReport()
        {
            if (pendingReport == null && unreportedDrops.Count > 0)
            {
                var counts = unreportedDrops.Take(MaxClientReportReasons).ToList();
                foreach (var pair in counts)
                {
                    unreportedDrops.Remove(pair.Key);
                }

                pendingReport = new ClientReport(Guid.NewGuid().ToString("N"), counts);
                unsaved = true;
                saveAtOnce = true;
            }

            return pendingReport;
        }

        // Loads counts saved by an earlier process, so the next request still carries them.
        internal void LoadSaved(IReadOnlyDictionary<string, int> saved)
        {
            foreach (var pair in saved.OrderBy(pair => pair.Key, StringComparer.Ordinal))
            {
                unreportedDrops[pair.Key] = pair.Value;
            }
        }

        // Returns the counts to save, or null when nothing changed or the save can wait for the burst to settle.
        internal IReadOnlyDictionary<string, int>? TakeUnsavedCounts(bool force)
        {
            var now = Stopwatch.GetTimestamp();
            if (!unsaved || (!force && !saveAtOnce && now - savedAtTimestamp < Stopwatch.Frequency))
            {
                return null;
            }

            unsaved = false;
            saveAtOnce = false;
            savedAtTimestamp = now;
            return new Dictionary<string, int>(unreportedDrops, StringComparer.Ordinal);
        }

        // Drops recorded while the acknowledged request was in flight stay pending under a new report ID.
        internal void Acknowledge(ClientReport? report)
        {
            if (report != null && ReferenceEquals(report, pendingReport))
            {
                pendingReport = null;
            }
        }

        internal void Report(DroppedEvent drop)
        {
            if (callback == null || ReferenceEquals(activeReporter, this))
            {
                return;
            }

            var previousReporter = activeReporter;
            try
            {
                activeReporter = this;
                callback(drop);
            }
            catch (Exception error) when (!DeliveryExceptionPolicy.IsFatal(error))
            {
                // Drop callbacks are advisory and must not interrupt application telemetry.
            }
            finally
            {
                activeReporter = previousReporter;
            }
        }
    }

    internal sealed class ClientReport
    {
        internal ClientReport(string id, IReadOnlyList<KeyValuePair<string, int>> droppedEvents)
        {
            Id = id;
            DroppedEvents = droppedEvents;
        }

        internal string Id { get; }

        internal IReadOnlyList<KeyValuePair<string, int>> DroppedEvents { get; }

        internal OrderedJsonObject ToJsonObject()
        {
            var counts = new OrderedJsonObject();
            foreach (var pair in DroppedEvents)
            {
                counts.Add(pair.Key, pair.Value);
            }

            return new OrderedJsonObject().Add("report_id", Id).Add("dropped_events", counts);
        }
    }
}
