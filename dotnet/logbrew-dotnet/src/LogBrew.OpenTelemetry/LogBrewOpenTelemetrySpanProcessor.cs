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

    public sealed class LogBrewOpenTelemetrySpanExporterOptions
    {
        internal LogBrewActivitySpanOptions SpanOptions { get; } = LogBrewActivitySpanOptions.Create();

        public static LogBrewOpenTelemetrySpanExporterOptions Create()
        {
            return new LogBrewOpenTelemetrySpanExporterOptions();
        }

        public LogBrewOpenTelemetrySpanExporterOptions WithEventIdPrefix(string value)
        {
            SpanOptions.WithEventIdPrefix(value);
            return this;
        }

        public LogBrewOpenTelemetrySpanExporterOptions WithMetadata(IDictionary<string, object?> value)
        {
            SpanOptions.WithMetadata(value);
            return this;
        }

        public LogBrewOpenTelemetrySpanExporterOptions WithTimestampProvider(Func<string> value)
        {
            SpanOptions.WithTimestampProvider(value);
            return this;
        }

        public LogBrewOpenTelemetrySpanExporterOptions WithServiceName(string value)
        {
            SpanOptions.WithServiceName(value);
            return this;
        }

        public LogBrewOpenTelemetrySpanExporterOptions WithServiceVersion(string value)
        {
            SpanOptions.WithServiceVersion(value);
            return this;
        }

        public LogBrewOpenTelemetrySpanExporterOptions WithDeploymentEnvironment(string value)
        {
            SpanOptions.WithDeploymentEnvironment(value);
            return this;
        }

        public LogBrewOpenTelemetrySpanExporterOptions OnError(Action<SdkException> value)
        {
            SpanOptions.OnError(value);
            return this;
        }
    }

    public sealed class LogBrewOpenTelemetrySpanExporter : BaseExporter<Activity>
    {
        private readonly LogBrewClient client;
        private readonly LogBrewOpenTelemetrySpanExporterOptions options;

        public LogBrewOpenTelemetrySpanExporter(
            LogBrewClient client,
            Action<LogBrewOpenTelemetrySpanExporterOptions>? configure = null)
        {
            this.client = client ?? throw new ArgumentNullException(nameof(client));
            options = LogBrewOpenTelemetrySpanExporterOptions.Create();
            configure?.Invoke(options);
        }

        public override ExportResult Export(in Batch<Activity> batch)
        {
            var failed = false;
            foreach (var activity in batch)
            {
                if (activity == null || !activity.Recorded)
                {
                    continue;
                }

                if (!LogBrewActivitySpanTelemetry.Capture(client, activity, options.SpanOptions))
                {
                    failed = true;
                }
            }

            return failed ? ExportResult.Failure : ExportResult.Success;
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
