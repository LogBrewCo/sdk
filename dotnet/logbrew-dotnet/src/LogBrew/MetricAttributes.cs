using System.Collections.Generic;

namespace LogBrew
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

        public static MetricAttributes Create(string name, string kind, double value, string unit, string temporality)
        {
            return new MetricAttributes(name, kind, value, unit, temporality);
        }

        public MetricAttributes WithMetadata(IDictionary<string, object?> metadata)
        {
            Metadata = metadata;
            return this;
        }

        internal OrderedJsonObject ToJsonObject()
        {
            Validation.RequireNonEmpty("metric name", Name);
            Validation.RequireAllowedValue("metric kind", Kind, LogBrewClient.MetricKinds);
            Validation.RequireFiniteNumber("metric value", Value);
            Validation.RequireNonEmpty("metric unit", Unit);
            Validation.RequireAllowedValue("metric temporality for " + Kind, Temporality, AllowedTemporalities());
            if (RequiresNonNegativeValue() && Value < 0)
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
            return payload;
        }

        private string[] AllowedTemporalities()
        {
            return Kind == "gauge" ? LogBrewClient.InstantTemporality : LogBrewClient.DeltaCumulativeTemporalities;
        }

        private bool RequiresNonNegativeValue()
        {
            return Kind == "counter" || Kind == "histogram";
        }
    }
}
