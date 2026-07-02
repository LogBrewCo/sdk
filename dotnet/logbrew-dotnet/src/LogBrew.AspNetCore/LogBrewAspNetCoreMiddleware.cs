using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

#pragma warning disable CA1031 // Middleware diagnostics callbacks must never break app-owned requests.

namespace LogBrew
{
    public sealed class LogBrewAspNetCoreOptions
    {
        private IDictionary<string, object?>? metadata;

        private LogBrewAspNetCoreOptions()
        {
        }

        internal string EventIdPrefix { get; private set; } = "dotnet_aspnetcore";

        internal bool CaptureDurationMetric { get; private set; } = true;

        internal bool CaptureExceptionIssue { get; private set; } = true;

        internal Func<HttpContext, bool>? RequestFilter { get; private set; }

        internal Func<HttpContext, string?>? RouteTemplateSelector { get; private set; }

        internal Func<HttpContext, IDictionary<string, object?>?>? MetadataProvider { get; private set; }

        internal Func<string> TimestampProvider { get; private set; } = DefaultTimestamp;

        internal Action<Exception>? ErrorHandler { get; private set; }

        internal IDictionary<string, object?>? Metadata
        {
            get { return metadata; }
        }

        public static LogBrewAspNetCoreOptions Create()
        {
            return new LogBrewAspNetCoreOptions();
        }

        public LogBrewAspNetCoreOptions WithEventIdPrefix(string value)
        {
            RequireNonEmpty("ASP.NET Core eventIdPrefix", value);
            EventIdPrefix = value.Trim();
            return this;
        }

        public LogBrewAspNetCoreOptions WithCaptureDurationMetric(bool value)
        {
            CaptureDurationMetric = value;
            return this;
        }

        public LogBrewAspNetCoreOptions WithCaptureExceptionIssue(bool value)
        {
            CaptureExceptionIssue = value;
            return this;
        }

        public LogBrewAspNetCoreOptions WithRequestFilter(Func<HttpContext, bool> value)
        {
            RequestFilter = value ?? throw new ArgumentNullException(nameof(value));
            return this;
        }

        public LogBrewAspNetCoreOptions WithRouteTemplateSelector(Func<HttpContext, string?> value)
        {
            RouteTemplateSelector = value ?? throw new ArgumentNullException(nameof(value));
            return this;
        }

        public LogBrewAspNetCoreOptions WithMetadata(IDictionary<string, object?> value)
        {
            metadata = value ?? throw new ArgumentNullException(nameof(value));
            return this;
        }

        public LogBrewAspNetCoreOptions WithMetadataProvider(Func<HttpContext, IDictionary<string, object?>?> value)
        {
            MetadataProvider = value ?? throw new ArgumentNullException(nameof(value));
            return this;
        }

        public LogBrewAspNetCoreOptions WithTimestampProvider(Func<string> value)
        {
            TimestampProvider = value ?? throw new ArgumentNullException(nameof(value));
            return this;
        }

        public LogBrewAspNetCoreOptions OnError(Action<Exception> value)
        {
            ErrorHandler = value ?? throw new ArgumentNullException(nameof(value));
            return this;
        }

        private static string DefaultTimestamp()
        {
            return DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture);
        }

        private static void RequireNonEmpty(string field, string value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                throw new SdkException("validation_error", field + " must be non-empty");
            }
        }
    }

    public static class LogBrewAspNetCoreApplicationBuilderExtensions
    {
        private const string DependencyActivitySourceListenerKey = "LogBrew.DependencyActivitySourceListener";

        public static IApplicationBuilder UseLogBrewRequestTelemetry(
            this IApplicationBuilder app,
            LogBrewClient client,
            Action<LogBrewAspNetCoreOptions>? configure = null)
        {
            ArgumentNullException.ThrowIfNull(app);
            ArgumentNullException.ThrowIfNull(client);

            var options = LogBrewAspNetCoreOptions.Create();
            configure?.Invoke(options);
            return app.UseMiddleware<LogBrewAspNetCoreMiddleware>(client, options);
        }

        public static IApplicationBuilder UseLogBrewDependencyActivitySourceTelemetry(
            this IApplicationBuilder app,
            LogBrewClient client,
            Action<LogBrewActivitySourceListenerOptions>? configure = null)
        {
            ArgumentNullException.ThrowIfNull(app);
            ArgumentNullException.ThrowIfNull(client);

            if (app.Properties.ContainsKey(DependencyActivitySourceListenerKey))
            {
                return app;
            }

            var lifetime = app.ApplicationServices.GetService<IHostApplicationLifetime>();
            if (lifetime == null)
            {
                throw new SdkException(
                    "validation_error",
                    "ASP.NET Core host application lifetime service is required for LogBrew ActivitySource telemetry disposal");
            }

            var listener = LogBrewActivitySourceListener.Start(
                client,
                options =>
                {
                    options
                        .WithHttpClientSources()
                        .WithEntityFrameworkCoreSources()
                        .WithSqlClientSources()
                        .WithStackExchangeRedisSources();
                    configure?.Invoke(options);
                });
            app.Properties[DependencyActivitySourceListenerKey] = listener;
            lifetime.ApplicationStopping.Register(listener.Dispose);
            return app;
        }
    }

    public sealed class LogBrewAspNetCoreMiddleware
    {
        private const string TraceparentHeader = "traceparent";

        private readonly RequestDelegate next;
        private readonly LogBrewClient client;
        private readonly LogBrewAspNetCoreOptions options;

        public LogBrewAspNetCoreMiddleware(
            RequestDelegate next,
            LogBrewClient client,
            LogBrewAspNetCoreOptions options)
        {
            this.next = next ?? throw new ArgumentNullException(nameof(next));
            this.client = client ?? throw new ArgumentNullException(nameof(client));
            this.options = options ?? throw new ArgumentNullException(nameof(options));
        }

        public async Task InvokeAsync(HttpContext context)
        {
            ArgumentNullException.ThrowIfNull(context);

            if (!ShouldCapture(context))
            {
                await next(context).ConfigureAwait(false);
                return;
            }

            var routeTemplate = SelectRouteTemplate(context);
            var incomingTraceparent = context.Request.Headers[TraceparentHeader].ToString();
            var serverOptions = LogBrewServerRequestOptions.Create()
                .WithEventIdPrefix(options.EventIdPrefix)
                .WithCaptureDurationMetric(options.CaptureDurationMetric)
                .WithCaptureExceptionIssue(options.CaptureExceptionIssue)
                .WithTimestampProvider(options.TimestampProvider)
                .WithCaptureFailureHandler(ReportError);
            var metadata = BuildMetadata(context);
            if (metadata != null)
            {
                serverOptions.WithMetadata(metadata);
            }

            await LogBrewServerRequestTelemetry.CaptureAsync(
                client,
                context.Request.Method,
                routeTemplate,
                incomingTraceparent,
                async _ =>
                {
                    await next(context).ConfigureAwait(false);
                    return NormalizeStatusCode(context.Response.StatusCode);
                },
                serverOptions).ConfigureAwait(false);
        }

        private bool ShouldCapture(HttpContext context)
        {
            if (options.RequestFilter == null)
            {
                return true;
            }

            try
            {
                return options.RequestFilter(context);
            }
            catch (Exception error)
            {
                ReportError(error);
                return false;
            }
        }

        private string SelectRouteTemplate(HttpContext context)
        {
            if (options.RouteTemplateSelector != null)
            {
                try
                {
                    var selected = options.RouteTemplateSelector(context);
                    if (!string.IsNullOrWhiteSpace(selected))
                    {
                        return NormalizeRouteCandidate(selected!);
                    }
                }
                catch (Exception error)
                {
                    ReportError(error);
                }
            }

            if (context.GetEndpoint() is RouteEndpoint endpoint
                && !string.IsNullOrWhiteSpace(endpoint.RoutePattern.RawText))
            {
                return NormalizeRouteCandidate(endpoint.RoutePattern.RawText!);
            }

            var path = context.Request.PathBase.Add(context.Request.Path).Value;
            return string.IsNullOrWhiteSpace(path) ? "/" : path!;
        }

        private Dictionary<string, object?>? BuildMetadata(HttpContext context)
        {
            Dictionary<string, object?>? result = null;
            if (options.Metadata != null)
            {
                result = new Dictionary<string, object?>(options.Metadata, StringComparer.Ordinal);
            }

            if (options.MetadataProvider == null)
            {
                return result;
            }

            try
            {
                var provided = options.MetadataProvider(context);
                if (provided == null)
                {
                    return result;
                }

                result ??= new Dictionary<string, object?>(StringComparer.Ordinal);
                foreach (var item in provided)
                {
                    result[item.Key] = item.Value;
                }
            }
            catch (Exception error)
            {
                ReportError(error);
            }

            return result;
        }

        private void ReportError(Exception error)
        {
            if (options.ErrorHandler == null)
            {
                return;
            }

            try
            {
                options.ErrorHandler(error);
            }
            catch
            {
                // Diagnostics callbacks must never change the app-owned request pipeline.
            }
        }

        private static int NormalizeStatusCode(int statusCode)
        {
            return statusCode >= 100 && statusCode <= 599 ? statusCode : StatusCodes.Status200OK;
        }

        private static string NormalizeRouteCandidate(string routeTemplate)
        {
            var value = routeTemplate.Trim();
            if (Uri.TryCreate(value, UriKind.Absolute, out _))
            {
                return value;
            }

            return value.Length > 0 && value[0] == '/' ? value : "/" + value;
        }
    }
}
