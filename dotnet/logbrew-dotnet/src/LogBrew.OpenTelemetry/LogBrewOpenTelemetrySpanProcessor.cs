using System;
using System.Collections.Generic;
using System.Diagnostics;
using LogBrew;
using OpenTelemetry;
using OpenTelemetry.Trace;

namespace LogBrew.OpenTelemetry
{
    public sealed class LogBrewOpenTelemetrySpanProcessorOptions
    {
        internal LogBrewActivitySpanOptions SpanOptions { get; } = LogBrewActivitySpanOptions.Create();

        public static LogBrewOpenTelemetrySpanProcessorOptions Create()
        {
            return new LogBrewOpenTelemetrySpanProcessorOptions();
        }

        public LogBrewOpenTelemetrySpanProcessorOptions WithEventIdPrefix(string value)
        {
            SpanOptions.WithEventIdPrefix(value);
            return this;
        }

        public LogBrewOpenTelemetrySpanProcessorOptions WithMetadata(IDictionary<string, object?> value)
        {
            SpanOptions.WithMetadata(value);
            return this;
        }

        public LogBrewOpenTelemetrySpanProcessorOptions WithTimestampProvider(Func<string> value)
        {
            SpanOptions.WithTimestampProvider(value);
            return this;
        }

        public LogBrewOpenTelemetrySpanProcessorOptions WithServiceName(string value)
        {
            SpanOptions.WithServiceName(value);
            return this;
        }

        public LogBrewOpenTelemetrySpanProcessorOptions WithServiceVersion(string value)
        {
            SpanOptions.WithServiceVersion(value);
            return this;
        }

        public LogBrewOpenTelemetrySpanProcessorOptions WithDeploymentEnvironment(string value)
        {
            SpanOptions.WithDeploymentEnvironment(value);
            return this;
        }

        public LogBrewOpenTelemetrySpanProcessorOptions OnError(Action<SdkException> value)
        {
            SpanOptions.OnError(value);
            return this;
        }
    }

    public sealed class LogBrewOpenTelemetrySpanProcessor : BaseProcessor<Activity>
    {
        private readonly LogBrewClient client;
        private readonly LogBrewOpenTelemetrySpanProcessorOptions options;

        public LogBrewOpenTelemetrySpanProcessor(
            LogBrewClient client,
            Action<LogBrewOpenTelemetrySpanProcessorOptions>? configure = null)
        {
            this.client = client ?? throw new ArgumentNullException(nameof(client));
            options = LogBrewOpenTelemetrySpanProcessorOptions.Create();
            configure?.Invoke(options);
        }

        public override void OnEnd(Activity data)
        {
            if (data == null || !data.Recorded)
            {
                return;
            }

            LogBrewActivitySpanTelemetry.Capture(client, data, options.SpanOptions);
        }
    }

    public static class LogBrewOpenTelemetryTracerProviderBuilderExtensions
    {
        public static TracerProviderBuilder AddLogBrew(
            this TracerProviderBuilder builder,
            LogBrewClient client,
            Action<LogBrewOpenTelemetrySpanProcessorOptions>? configure = null)
        {
            if (builder == null)
            {
                throw new ArgumentNullException(nameof(builder));
            }

            return builder.AddProcessor(new LogBrewOpenTelemetrySpanProcessor(client, configure));
        }
    }
}
