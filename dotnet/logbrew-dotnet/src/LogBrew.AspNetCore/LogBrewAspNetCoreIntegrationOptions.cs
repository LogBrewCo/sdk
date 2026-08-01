using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net;
using System.Text;
using Microsoft.AspNetCore.Builder;

namespace LogBrew
{
    public sealed class LogBrewAspNetCoreIntegrationOptions
    {
        private const int MaximumLabelBytes = 255;
        private const int MaximumKeyBytes = 4096;
        private const int MaximumEndpointBytes = 2048;
        private bool? enabled;
        private string? serverApiKey;
        private string? serviceName;
        private string? release;
        private string? applicationEnvironment;
        private Uri? endpoint;
        private TimeSpan? requestTimeout;
        private ITransport? transport;
        private bool disposeTransportOnShutdown;
        private bool captureLogging = true;
        private bool captureRequests = true;
        private bool captureDependencies;
        private Action<AutomaticDeliveryOptions>? deliveryConfiguration;
        private Action<LogBrewLoggerOptions>? loggingConfiguration;
        private Action<LogBrewAspNetCoreOptions>? requestConfiguration;
        private Action<LogBrewActivitySourceListenerOptions>? dependencyConfiguration;
        private Func<DateTimeOffset>? timestampProvider;

        public LogBrewAspNetCoreIntegrationOptions WithEnabled(bool value)
        {
            enabled = value;
            return this;
        }

        public LogBrewAspNetCoreIntegrationOptions WithServerApiKey(string value)
        {
            serverApiKey = value ?? throw new ArgumentNullException(nameof(value));
            return this;
        }

        public LogBrewAspNetCoreIntegrationOptions WithServiceName(string value)
        {
            serviceName = value ?? throw new ArgumentNullException(nameof(value));
            return this;
        }

        public LogBrewAspNetCoreIntegrationOptions WithRelease(string value)
        {
            release = value ?? throw new ArgumentNullException(nameof(value));
            return this;
        }

        public LogBrewAspNetCoreIntegrationOptions WithEnvironment(string value)
        {
            applicationEnvironment = value ?? throw new ArgumentNullException(nameof(value));
            return this;
        }

        public LogBrewAspNetCoreIntegrationOptions WithEndpoint(Uri value)
        {
            endpoint = value ?? throw new ArgumentNullException(nameof(value));
            return this;
        }

        public LogBrewAspNetCoreIntegrationOptions WithRequestTimeout(TimeSpan value)
        {
            requestTimeout = value;
            return this;
        }

        public LogBrewAspNetCoreIntegrationOptions WithTransport(
            ITransport value,
            bool disposeOnShutdown = false)
        {
            transport = value ?? throw new ArgumentNullException(nameof(value));
            disposeTransportOnShutdown = disposeOnShutdown;
            return this;
        }

        public LogBrewAspNetCoreIntegrationOptions WithLogging(bool value)
        {
            captureLogging = value;
            return this;
        }

        public LogBrewAspNetCoreIntegrationOptions WithRequestTelemetry(bool value)
        {
            captureRequests = value;
            return this;
        }

        public LogBrewAspNetCoreIntegrationOptions WithDependencyTelemetry(bool value)
        {
            captureDependencies = value;
            return this;
        }

        public LogBrewAspNetCoreIntegrationOptions ConfigureDelivery(
            Action<AutomaticDeliveryOptions> configure)
        {
            deliveryConfiguration += configure ?? throw new ArgumentNullException(nameof(configure));
            return this;
        }

        public LogBrewAspNetCoreIntegrationOptions ConfigureLogging(
            Action<LogBrewLoggerOptions> configure)
        {
            loggingConfiguration += configure ?? throw new ArgumentNullException(nameof(configure));
            return this;
        }

        public LogBrewAspNetCoreIntegrationOptions ConfigureRequestTelemetry(
            Action<LogBrewAspNetCoreOptions> configure)
        {
            requestConfiguration += configure ?? throw new ArgumentNullException(nameof(configure));
            return this;
        }

        public LogBrewAspNetCoreIntegrationOptions ConfigureDependencyTelemetry(
            Action<LogBrewActivitySourceListenerOptions> configure)
        {
            dependencyConfiguration += configure ?? throw new ArgumentNullException(nameof(configure));
            captureDependencies = true;
            return this;
        }

        public LogBrewAspNetCoreIntegrationOptions WithTimestampProvider(Func<DateTimeOffset> value)
        {
            timestampProvider = value ?? throw new ArgumentNullException(nameof(value));
            return this;
        }

        internal LogBrewAspNetCoreResolvedOptions Resolve(WebApplicationBuilder builder)
        {
            ArgumentNullException.ThrowIfNull(builder);

            var configuredEnabled = enabled ?? ReadBooleanSetting(
                builder,
                "LOGBREW_ENABLED",
                "LogBrew:Enabled");
            if (configuredEnabled == false)
            {
                return Disabled("explicitly_disabled");
            }

            var canonicalKey = serverApiKey == null
                ? ReadSetting(builder, "LOGBREW_SERVER_API_KEY", "LogBrew:ServerApiKey")
                : new SettingValue(true, serverApiKey);
            var key = OptionalText(canonicalKey.Value);
            if (key == null)
            {
                var legacyApiKey = ReadSetting(builder, "LOGBREW_API_KEY", "LogBrew:ApiKey");
                var legacyIngestKey = ReadSetting(builder, "LOGBREW_INGEST_KEY", "LogBrew:IngestKey");
                if (configuredEnabled == true
                    || canonicalKey.IsPresent
                    || OptionalText(legacyApiKey.Value) != null
                    || OptionalText(legacyIngestKey.Value) != null)
                {
                    throw ConfigurationError(
                        "set LOGBREW_SERVER_API_KEY to a non-empty server API key, or set LOGBREW_ENABLED=false");
                }

                return Disabled("missing_server_api_key");
            }

            ValidateServerKey(key);
            var resolvedServiceName = BoundedLabel(
                serviceName
                    ?? ReadSetting(builder, "LOGBREW_SERVICE_NAME", "LogBrew:ServiceName").Value
                    ?? builder.Environment.ApplicationName,
                "LOGBREW_SERVICE_NAME");
            var resolvedEnvironment = BoundedLabel(
                applicationEnvironment
                    ?? ReadSetting(builder, "LOGBREW_ENVIRONMENT", "LogBrew:Environment").Value
                    ?? builder.Environment.EnvironmentName,
                "LOGBREW_ENVIRONMENT");
            var resolvedRelease = OptionalBoundedLabel(
                release ?? ReadSetting(builder, "LOGBREW_RELEASE", "LogBrew:Release").Value,
                "LOGBREW_RELEASE");
            var resolvedEndpoint = ResolveEndpoint(builder);
            var resolvedTimeout = ResolveRequestTimeout(builder);
            var resolvedTransport = transport;
            var ownsTransport = disposeTransportOnShutdown;
            if (resolvedTransport != null && (endpoint != null
                || ReadSetting(builder, "LOGBREW_ENDPOINT", "LogBrew:Endpoint").IsPresent))
            {
                throw ConfigurationError("configure either a LogBrew transport or LOGBREW_ENDPOINT, not both");
            }

            if (resolvedTransport == null)
            {
                resolvedTransport = new HttpTransport(new HttpTransportOptions
                {
                    Endpoint = resolvedEndpoint,
                    Timeout = resolvedTimeout
                });
                ownsTransport = true;
            }

            var delivery = new AutomaticDeliveryOptions
            {
                FlushInterval = TimeSpan.FromMilliseconds(ReadIntegerSetting(
                    builder,
                    "LOGBREW_FLUSH_INTERVAL_MS",
                    "LogBrew:FlushIntervalMs",
                    5000,
                    10,
                    3600000)),
                FlushAtQueueSize = ReadIntegerSetting(
                    builder,
                    "LOGBREW_FLUSH_THRESHOLD",
                    "LogBrew:FlushThreshold",
                    100,
                    1,
                    1000)
            };
            deliveryConfiguration?.Invoke(delivery);

            var metadata = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["service"] = resolvedServiceName,
                ["environment"] = resolvedEnvironment,
                ["framework"] = "aspnetcore",
                ["framework.version"] = AspNetCoreVersion()
            };
            var logger = new LogBrewLoggerOptions
            {
                EventIdPrefix = "dotnet_aspnetcore_log",
                MinimumLevel = Microsoft.Extensions.Logging.LogLevel.Warning,
                Metadata = metadata,
                TimestampProvider = timestampProvider
            };
            if (resolvedRelease != null)
            {
                metadata["release"] = resolvedRelease;
            }
            loggingConfiguration?.Invoke(logger);
            logger.Metadata = MergeMetadata(metadata, logger.Metadata);

            return new LogBrewAspNetCoreResolvedOptions(
                enabled: true,
                disabledReason: null,
                apiKey: key,
                serviceName: resolvedServiceName,
                release: resolvedRelease,
                applicationEnvironment: resolvedEnvironment,
                frameworkVersion: AspNetCoreVersion(),
                transport: resolvedTransport,
                ownsTransport: ownsTransport,
                delivery: delivery,
                logger: logger,
                captureLogging: captureLogging,
                captureRequests: captureRequests,
                captureDependencies: captureDependencies,
                requestConfiguration: requestConfiguration,
                dependencyConfiguration: dependencyConfiguration,
                timestampProvider: timestampProvider ?? (() => DateTimeOffset.UtcNow));
        }

        private LogBrewAspNetCoreResolvedOptions Disabled(string reason)
        {
            return new LogBrewAspNetCoreResolvedOptions(
                enabled: false,
                disabledReason: reason,
                apiKey: null,
                serviceName: "disabled",
                release: null,
                applicationEnvironment: "disabled",
                frameworkVersion: AspNetCoreVersion(),
                transport: null,
                ownsTransport: false,
                delivery: new AutomaticDeliveryOptions(),
                logger: new LogBrewLoggerOptions(),
                captureLogging: false,
                captureRequests: false,
                captureDependencies: false,
                requestConfiguration: null,
                dependencyConfiguration: null,
                timestampProvider: timestampProvider ?? (() => DateTimeOffset.UtcNow));
        }

        private Uri ResolveEndpoint(WebApplicationBuilder builder)
        {
            if (endpoint != null)
            {
                return ValidateEndpoint(endpoint);
            }

            var setting = ReadSetting(builder, "LOGBREW_ENDPOINT", "LogBrew:Endpoint");
            var text = OptionalText(setting.Value);
            if (text == null)
            {
                if (setting.IsPresent)
                {
                    throw ConfigurationError("LOGBREW_ENDPOINT must be a valid HTTP URL");
                }

                return HttpTransport.DefaultEndpoint;
            }

            if (Encoding.UTF8.GetByteCount(text) > MaximumEndpointBytes
                || !Uri.TryCreate(text, UriKind.Absolute, out var parsed))
            {
                throw ConfigurationError("LOGBREW_ENDPOINT must be a valid HTTP URL");
            }

            return ValidateEndpoint(parsed);
        }

        private TimeSpan ResolveRequestTimeout(WebApplicationBuilder builder)
        {
            if (requestTimeout != null)
            {
                if (requestTimeout <= TimeSpan.Zero || requestTimeout > TimeSpan.FromMinutes(10))
                {
                    throw ConfigurationError(
                        "LogBrew request timeout must be between 1 millisecond and 10 minutes");
                }

                return requestTimeout.Value;
            }

            return TimeSpan.FromMilliseconds(ReadIntegerSetting(
                builder,
                "LOGBREW_REQUEST_TIMEOUT_MS",
                "LogBrew:RequestTimeoutMs",
                10000,
                1,
                600000));
        }

        private static Uri ValidateEndpoint(Uri value)
        {
            if (!value.IsAbsoluteUri)
            {
                throw ConfigurationError(
                    "LOGBREW_ENDPOINT must use https, or http on localhost, without user info, query, or fragment data");
            }

            var isHttps = string.Equals(value.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase);
            var isLoopbackHttp = string.Equals(value.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)
                && IsLoopbackHost(value.Host);
            if ((!isHttps && !isLoopbackHttp)
                || !string.IsNullOrEmpty(value.UserInfo)
                || !string.IsNullOrEmpty(value.Query)
                || !string.IsNullOrEmpty(value.Fragment))
            {
                throw ConfigurationError(
                    "LOGBREW_ENDPOINT must use https, or http on localhost, without user info, query, or fragment data");
            }

            return value;
        }

        private static bool IsLoopbackHost(string host)
        {
            if (string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            return IPAddress.TryParse(host, out var address) && IPAddress.IsLoopback(address);
        }

        private static bool? ReadBooleanSetting(
            WebApplicationBuilder builder,
            string environmentName,
            string configurationName)
        {
            var setting = ReadSetting(builder, environmentName, configurationName);
            if (!setting.IsPresent)
            {
                return null;
            }

            var text = OptionalText(setting.Value)?.ToUpperInvariant();
            return text switch
            {
                "TRUE" or "1" or "YES" or "ON" => true,
                "FALSE" or "0" or "NO" or "OFF" => false,
                _ => throw ConfigurationError(environmentName + " must be true or false")
            };
        }

        private static int ReadIntegerSetting(
            WebApplicationBuilder builder,
            string environmentName,
            string configurationName,
            int defaultValue,
            int minimum,
            int maximum)
        {
            var setting = ReadSetting(builder, environmentName, configurationName);
            if (!setting.IsPresent)
            {
                return defaultValue;
            }

            if (!int.TryParse(
                OptionalText(setting.Value),
                NumberStyles.None,
                CultureInfo.InvariantCulture,
                out var value)
                || value < minimum
                || value > maximum)
            {
                throw ConfigurationError(
                    environmentName
                    + " must be an integer between "
                    + minimum.ToString(CultureInfo.InvariantCulture)
                    + " and "
                    + maximum.ToString(CultureInfo.InvariantCulture));
            }

            return value;
        }

        private static SettingValue ReadSetting(
            WebApplicationBuilder builder,
            string environmentName,
            string configurationName)
        {
            var environmentValue = System.Environment.GetEnvironmentVariable(environmentName);
            if (environmentValue != null)
            {
                return new SettingValue(true, environmentValue);
            }

            var configurationValue = builder.Configuration[configurationName];
            return new SettingValue(configurationValue != null, configurationValue);
        }

        private static void ValidateServerKey(string value)
        {
            if (Encoding.UTF8.GetByteCount(value) > MaximumKeyBytes || ContainsControlCharacter(value))
            {
                throw ConfigurationError("LOGBREW_SERVER_API_KEY is invalid");
            }
        }

        private static string BoundedLabel(string? value, string label)
        {
            var text = OptionalText(value)
                ?? throw ConfigurationError(label + " must be non-empty");

            if (Encoding.UTF8.GetByteCount(text) > MaximumLabelBytes || ContainsControlCharacter(text))
            {
                throw ConfigurationError(
                    label
                    + " must be at most "
                    + MaximumLabelBytes.ToString(CultureInfo.InvariantCulture)
                    + " bytes without control characters");
            }

            return text;
        }

        private static string? OptionalBoundedLabel(string? value, string label)
        {
            return OptionalText(value) == null ? null : BoundedLabel(value, label);
        }

        private static string? OptionalText(string? value)
        {
            var text = value?.Trim();
            return string.IsNullOrEmpty(text) ? null : text;
        }

        private static bool ContainsControlCharacter(string value)
        {
            foreach (var character in value)
            {
                if (char.IsControl(character))
                {
                    return true;
                }
            }

            return false;
        }

        private static Dictionary<string, object?> MergeMetadata(
            IDictionary<string, object?> required,
            IDictionary<string, object?>? configured)
        {
            var merged = new Dictionary<string, object?>(required, StringComparer.Ordinal);
            if (configured == null || ReferenceEquals(required, configured))
            {
                return merged;
            }

            foreach (var item in configured)
            {
                merged[item.Key] = item.Value;
            }

            return merged;
        }

        private static string AspNetCoreVersion()
        {
            return typeof(Microsoft.AspNetCore.Http.HttpContext).Assembly.GetName().Version?.ToString()
                ?? "unknown";
        }

        private static SdkException ConfigurationError(string message)
        {
            return new SdkException("configuration_error", message);
        }

        private readonly struct SettingValue
        {
            internal SettingValue(bool isPresent, string? value)
            {
                IsPresent = isPresent;
                Value = value;
            }

            internal bool IsPresent { get; }

            internal string? Value { get; }
        }
    }

    internal sealed class LogBrewAspNetCoreResolvedOptions
    {
        internal LogBrewAspNetCoreResolvedOptions(
            bool enabled,
            string? disabledReason,
            string? apiKey,
            string serviceName,
            string? release,
            string applicationEnvironment,
            string frameworkVersion,
            ITransport? transport,
            bool ownsTransport,
            AutomaticDeliveryOptions delivery,
            LogBrewLoggerOptions logger,
            bool captureLogging,
            bool captureRequests,
            bool captureDependencies,
            Action<LogBrewAspNetCoreOptions>? requestConfiguration,
            Action<LogBrewActivitySourceListenerOptions>? dependencyConfiguration,
            Func<DateTimeOffset> timestampProvider)
        {
            Enabled = enabled;
            DisabledReason = disabledReason;
            ApiKey = apiKey;
            ServiceName = serviceName;
            Release = release;
            ApplicationEnvironment = applicationEnvironment;
            FrameworkVersion = frameworkVersion;
            Transport = transport;
            OwnsTransport = ownsTransport;
            Delivery = delivery;
            Logger = logger;
            CaptureLogging = captureLogging;
            CaptureRequests = captureRequests;
            CaptureDependencies = captureDependencies;
            RequestConfiguration = requestConfiguration;
            DependencyConfiguration = dependencyConfiguration;
            TimestampProvider = timestampProvider;
        }

        internal bool Enabled { get; }

        internal string? DisabledReason { get; }

        internal string? ApiKey { get; }

        internal string ServiceName { get; }

        internal string? Release { get; }

        internal string ApplicationEnvironment { get; }

        internal string FrameworkVersion { get; }

        internal ITransport? Transport { get; }

        internal bool OwnsTransport { get; }

        internal AutomaticDeliveryOptions Delivery { get; }

        internal LogBrewLoggerOptions Logger { get; }

        internal bool CaptureLogging { get; }

        internal bool CaptureRequests { get; }

        internal bool CaptureDependencies { get; }

        internal Action<LogBrewAspNetCoreOptions>? RequestConfiguration { get; }

        internal Action<LogBrewActivitySourceListenerOptions>? DependencyConfiguration { get; }

        internal Func<DateTimeOffset> TimestampProvider { get; }

        internal IDictionary<string, object?> Metadata()
        {
            var metadata = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["service"] = ServiceName,
                ["environment"] = ApplicationEnvironment,
                ["framework"] = "aspnetcore",
                ["framework.version"] = FrameworkVersion
            };
            if (Release != null)
            {
                metadata["release"] = Release;
            }

            return metadata;
        }
    }
}
