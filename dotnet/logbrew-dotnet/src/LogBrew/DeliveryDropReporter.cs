using System;

namespace LogBrew
{
    internal sealed class DeliveryDropReporter
    {
        [ThreadStatic]
        private static DeliveryDropReporter? activeReporter;

        private readonly Action<DroppedEvent>? callback;
        private int droppedEvents;

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
            return new DroppedEvent(id, type, reason, droppedEvents);
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
}
