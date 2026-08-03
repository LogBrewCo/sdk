namespace LogBrew
{
    /// <summary>Client-level shared telemetry context options.</summary>
    public sealed class LogBrewClientOptions
    {
        /// <summary>Gets or sets context merged into every event.</summary>
        public TelemetryContext? Context { get; set; }

        /// <summary>
        /// Gets or sets whether the default .NET runtime version, OS family, and architecture context is disabled.
        /// </summary>
        public bool DisableRuntimeContext { get; set; }
    }
}
