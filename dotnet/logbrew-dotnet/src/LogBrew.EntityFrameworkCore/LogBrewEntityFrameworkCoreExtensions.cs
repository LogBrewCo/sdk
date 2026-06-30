using System;
using Microsoft.EntityFrameworkCore;

namespace LogBrew.EntityFrameworkCore
{
    public static class LogBrewEntityFrameworkCoreExtensions
    {
        public static DbContextOptionsBuilder AddLogBrewCommandTelemetry(
            this DbContextOptionsBuilder builder,
            LogBrewClient client,
            Action<LogBrewEntityFrameworkCoreOptions>? configure = null)
        {
            ArgumentNullException.ThrowIfNull(builder);

            var options = LogBrewEntityFrameworkCoreOptions.Create();
            configure?.Invoke(options);
            return builder.AddInterceptors(new LogBrewEntityFrameworkCoreCommandInterceptor(client, options));
        }
    }
}
