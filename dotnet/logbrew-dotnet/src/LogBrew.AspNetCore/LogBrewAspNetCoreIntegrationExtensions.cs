using System;
using System.Linq;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

#pragma warning disable CA2000 // ASP.NET Core owns the registered runtime and logging provider.

namespace LogBrew
{
    public static class LogBrewAspNetCoreIntegrationExtensions
    {
        private const string RequestTelemetryMarker = "LogBrew.AspNetCore.AutomaticRequestTelemetry";

        public static WebApplicationBuilder AddLogBrew(
            this WebApplicationBuilder builder,
            Action<LogBrewAspNetCoreIntegrationOptions>? configure = null)
        {
            ArgumentNullException.ThrowIfNull(builder);

            if (builder.Services.Any(
                descriptor => descriptor.ServiceType == typeof(LogBrewAspNetCoreRuntime)))
            {
                return builder;
            }

            var integrationOptions = new LogBrewAspNetCoreIntegrationOptions();
            configure?.Invoke(integrationOptions);
            var resolved = integrationOptions.Resolve(builder);
            var runtime = new LogBrewAspNetCoreRuntime(resolved);

            builder.Services.AddSingleton(runtime);
            builder.Services.AddSingleton<IHostedService>(_ => runtime);
            if (runtime.Enabled)
            {
                builder.Services.AddSingleton<LogBrewClient>(runtime.Client!);
                if (resolved.CaptureLogging)
                {
                    builder.Logging.AddProvider(
                        new LogBrewAspNetCoreLoggerProvider(runtime.Client!, resolved.Logger));
                }
            }

            return builder;
        }

        public static IApplicationBuilder UseLogBrew(
            this IApplicationBuilder app,
            Action<LogBrewAspNetCoreOptions>? configure = null)
        {
            ArgumentNullException.ThrowIfNull(app);

            if (app.Properties.ContainsKey(RequestTelemetryMarker))
            {
                return app;
            }

            var runtime = app.ApplicationServices.GetService<LogBrewAspNetCoreRuntime>()
                ?? throw new SdkException(
                    "configuration_error",
                    "call builder.AddLogBrew() before builder.Build() and app.UseLogBrew()");

            app.Properties[RequestTelemetryMarker] = true;
            if (!runtime.Enabled || !runtime.Options.CaptureRequests)
            {
                return app;
            }

            return app.UseLogBrewRequestTelemetry(
                runtime.Client!,
                requestOptions =>
                {
                    requestOptions.WithTimestampProvider(() => runtime.Options.TimestampProvider()
                            .ToUniversalTime()
                            .ToString("O", System.Globalization.CultureInfo.InvariantCulture));
                    runtime.Options.RequestConfiguration?.Invoke(requestOptions);
                    configure?.Invoke(requestOptions);
                    var metadata = runtime.Options.Metadata();
                    if (requestOptions.Metadata != null)
                    {
                        foreach (var item in requestOptions.Metadata)
                        {
                            metadata[item.Key] = item.Value;
                        }
                    }

                    requestOptions.WithMetadata(metadata);
                });
        }

        private sealed class LogBrewAspNetCoreLoggerProvider : ILoggerProvider
        {
            private readonly LogBrewLoggerProvider provider;

            internal LogBrewAspNetCoreLoggerProvider(
                LogBrewClient client,
                LogBrewLoggerOptions options)
            {
                provider = new LogBrewLoggerProvider(client, options);
            }

            public ILogger CreateLogger(string categoryName)
            {
                return provider.CreateLogger(categoryName);
            }

            public void Dispose()
            {
                provider.Dispose();
                GC.SuppressFinalize(this);
            }
        }
    }
}
