#nullable enable

using System.Collections.Generic;

namespace LogBrew.Unity
{
    public sealed class MetricAttributes
    {
        private MetricAttributes(string name, string kind, double value, string unit, string temporality)
        {
            Name = name;
            Kind = kind;
            Value = value;
            Unit = unit;
            Temporality = temporality;
        }

        public string Name { get; }

        public string Kind { get; }

        public double Value { get; }

        public string Unit { get; }

        public string Temporality { get; }

        public IDictionary<string, object?>? Metadata { get; private set; }

        internal TelemetryContext? Context { get; private set; }

        public static MetricAttributes Create(string name, string kind, double value, string unit, string temporality)
        {
            return new MetricAttributes(name, kind, value, unit, temporality);
        }

        public MetricAttributes WithMetadata(IDictionary<string, object?> metadata)
        {
            Metadata = metadata ?? throw new System.ArgumentNullException(nameof(metadata));
            return this;
        }

        public MetricAttributes WithContext(TelemetryContext context)
        {
            Context = context ?? throw new System.ArgumentNullException(nameof(context));
            return this;
        }

        internal OrderedJsonObject ToJsonObject()
        {
            Validation.RequireNonEmpty("metric name", Name);
            Validation.RequireAllowedValue("metric kind", Kind, LogBrewClient.MetricKinds);
            if (double.IsNaN(Value) || double.IsInfinity(Value))
            {
                throw new SdkException("validation_error", "metric value must be finite");
            }

            Validation.RequireNonEmpty("metric unit", Unit);
            var allowed = Kind == "gauge" ? LogBrewClient.InstantTemporality : LogBrewClient.DeltaCumulativeTemporalities;
            Validation.RequireAllowedValue("metric temporality for " + Kind, Temporality, allowed);
            if ((Kind == "counter" || Kind == "histogram") && Value < 0)
            {
                throw new SdkException("validation_error", "metric " + Kind + " value must be non-negative");
            }

            var payload = new OrderedJsonObject()
                .Add("name", Name)
                .Add("kind", Kind)
                .Add("value", Value)
                .Add("unit", Unit)
                .Add("temporality", Temporality);
            payload.AddMetadata(Metadata);
            payload.AddIfNotNull("context", Context?.ToJsonObject());
            return payload;
        }
    }
}
