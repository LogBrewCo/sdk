using System;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;

#pragma warning disable CA1031 // Telemetry lifecycle failures must not change the application lifecycle.

namespace LogBrew
{
    public sealed class LogBrewAspNetCoreHealthSnapshot
    {
        internal LogBrewAspNetCoreHealthSnapshot(
            bool enabled,
            string state,
            string? disabledReason,
            DeliveryHealthSnapshot? delivery,
            int? lastShutdownStatusCode,
            string? lastLifecycleErrorCode)
        {
            Enabled = enabled;
            State = state;
            DisabledReason = disabledReason;
            Delivery = delivery;
            LastShutdownStatusCode = lastShutdownStatusCode;
            LastLifecycleErrorCode = lastLifecycleErrorCode;
        }

        public bool Enabled { get; }

        public string State { get; }

        public string? DisabledReason { get; }

        public DeliveryHealthSnapshot? Delivery { get; }

        public int? LastShutdownStatusCode { get; }

        public string? LastLifecycleErrorCode { get; }
    }

    public sealed class LogBrewAspNetCoreRuntime : IHostedService, IDisposable
    {
        internal const string SdkName = "logbrew-dotnet-aspnetcore";

        internal static string SdkVersion =>
            typeof(LogBrewAspNetCoreRuntime).Assembly.GetName().Version?.ToString(3) ?? "unknown";

        private readonly Lock gate = new();
        private readonly LogBrewAspNetCoreResolvedOptions options;
        private LogBrewActivitySourceListener? dependencyListener;
        private string state;
        private bool started;
        private bool stopped;
        private bool transportDisposed;
        private int? lastShutdownStatusCode;
        private string? lastLifecycleErrorCode;

        internal LogBrewAspNetCoreRuntime(LogBrewAspNetCoreResolvedOptions options)
        {
            this.options = options ?? throw new ArgumentNullException(nameof(options));
            Enabled = options.Enabled;
            state = Enabled ? "configured" : "disabled";
            if (Enabled)
            {
                try
                {
                    Client = LogBrewClient.CreateAutomatic(
                        options.ApiKey!,
                        SdkName,
                        SdkVersion,
                        new LogBrewClientOptions
                        {
                            Context = TelemetryContext.Create()
                                .WithResource(
                                    TelemetryResource.Create()
                                        .WithService(options.ServiceName, options.Release)
                                        .WithDeployment(options.ApplicationEnvironment, options.Release)
                                        .WithFramework("aspnetcore", options.FrameworkVersion)
                                        .Build())
                                .Build()
                        },
                        options.Transport!,
                        options.Delivery);
                }
                catch
                {
                    if (options.OwnsTransport)
                    {
                        try
                        {
                            (options.Transport as IDisposable)?.Dispose();
                        }
                        catch
                        {
                            // Preserve the original configuration failure.
                        }
                    }

                    throw;
                }
            }
        }

        public bool Enabled { get; }

        public LogBrewClient? Client { get; }

        internal LogBrewAspNetCoreResolvedOptions Options => options;

        public Task StartAsync(CancellationToken cancellationToken)
        {
            _ = cancellationToken;
            lock (gate)
            {
                if (!Enabled || started || stopped)
                {
                    return Task.CompletedTask;
                }

                started = true;
                state = "running";
            }

            RunLifecycleAction(RecordApplicationMarkers);
            RunLifecycleAction(StartDependencyTelemetry);

            return Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken cancellationToken)
        {
            _ = cancellationToken;
            StopCore();
            return Task.CompletedTask;
        }

        public LogBrewAspNetCoreHealthSnapshot Health()
        {
            string stateSnapshot;
            int? statusSnapshot;
            string? errorSnapshot;
            lock (gate)
            {
                stateSnapshot = state;
                statusSnapshot = lastShutdownStatusCode;
                errorSnapshot = lastLifecycleErrorCode;
            }

            DeliveryHealthSnapshot? delivery = null;
            if (Client != null)
            {
                try
                {
                    delivery = Client.DeliveryHealth();
                }
                catch (Exception error)
                {
                    errorSnapshot ??= ErrorCode(error);
                }
            }

            return new LogBrewAspNetCoreHealthSnapshot(
                Enabled,
                stateSnapshot,
                options.DisabledReason,
                delivery,
                statusSnapshot,
                errorSnapshot);
        }

        public void Dispose()
        {
            StopCore();
            GC.SuppressFinalize(this);
        }

        private void RecordApplicationMarkers()
        {
            if (Client == null)
            {
                return;
            }

            Client.Environment(
                "dotnet_aspnetcore_environment_" + Guid.NewGuid().ToString("N"),
                Timestamp(),
                EnvironmentAttributes.Create(options.ApplicationEnvironment)
                    .WithMetadata(options.Metadata()));
            if (options.Release != null)
            {
                Client.Release(
                    "dotnet_aspnetcore_release_" + Guid.NewGuid().ToString("N"),
                    Timestamp(),
                    ReleaseAttributes.Create(options.Release)
                        .WithMetadata(options.Metadata()));
            }
        }

        private void StartDependencyTelemetry()
        {
            if (!options.CaptureDependencies || Client == null)
            {
                return;
            }

            var listener = LogBrewActivitySourceListener.Start(
                Client,
                dependencyOptions =>
                {
                    dependencyOptions
                        .WithHttpClientSources()
                        .WithEntityFrameworkCoreSources()
                        .WithSqlClientSources()
                        .WithStackExchangeRedisSources()
                        .WithServiceName(options.ServiceName)
                        .WithDeploymentEnvironment(options.ApplicationEnvironment)
                        .WithMetadata(options.Metadata())
                        .WithTimestampProvider(Timestamp);
                    if (options.Release != null)
                    {
                        dependencyOptions.WithServiceVersion(options.Release);
                    }

                    options.DependencyConfiguration?.Invoke(dependencyOptions);
                });

            lock (gate)
            {
                if (stopped)
                {
                    listener.Dispose();
                    return;
                }

                dependencyListener = listener;
            }
        }

        private void StopCore()
        {
            LogBrewActivitySourceListener? listener;
            lock (gate)
            {
                if (!Enabled || stopped)
                {
                    return;
                }

                stopped = true;
                state = "stopping";
                listener = dependencyListener;
                dependencyListener = null;
            }

            try
            {
                listener?.Dispose();
            }
            catch (Exception error)
            {
                RecordLifecycleError(error);
            }

            try
            {
                if (Client != null)
                {
                    var response = Client.Shutdown();
                    lock (gate)
                    {
                        lastShutdownStatusCode = response.StatusCode;
                    }
                }
            }
            catch (Exception error)
            {
                RecordLifecycleError(error);
            }
            finally
            {
                DisposeOwnedTransport();
                lock (gate)
                {
                    state = "stopped";
                }
            }
        }

        private void DisposeOwnedTransport()
        {
            if (!options.OwnsTransport || transportDisposed)
            {
                return;
            }

            transportDisposed = true;
            try
            {
                (options.Transport as IDisposable)?.Dispose();
            }
            catch (Exception error)
            {
                RecordLifecycleError(error);
            }
        }

        private void RecordLifecycleError(Exception error)
        {
            lock (gate)
            {
                lastLifecycleErrorCode = ErrorCode(error);
            }
        }

        private void RunLifecycleAction(Action action)
        {
            try
            {
                action();
            }
            catch (Exception error)
            {
                RecordLifecycleError(error);
            }
        }

        private static string ErrorCode(Exception error)
        {
            if (error is SdkException sdkError)
            {
                return sdkError.Code;
            }

            if (error is TransportException transportError)
            {
                return transportError.Code;
            }

            return "lifecycle_error";
        }

        private string Timestamp()
        {
            return options.TimestampProvider().ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);
        }
    }
}

#pragma warning restore CA1031
