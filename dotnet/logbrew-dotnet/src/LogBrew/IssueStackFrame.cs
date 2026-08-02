namespace LogBrew
{
    /// <summary>
    /// Privacy-bounded code identity for one issue stack frame.
    /// </summary>
    public sealed class IssueStackFrame
    {
        private IssueStackFrame(string filename, int line, int column)
        {
            Filename = filename;
            Line = line;
            Column = column;
        }

        /// <summary>
        /// Gets the source filename or privacy-safe source identity.
        /// </summary>
        public string Filename { get; }

        /// <summary>
        /// Gets the one-based source line.
        /// </summary>
        public int Line { get; }

        /// <summary>
        /// Gets the one-based source column.
        /// </summary>
        public int Column { get; }

        /// <summary>
        /// Gets the optional function or method name.
        /// </summary>
        public string? Function { get; private set; }

        /// <summary>
        /// Gets the optional module or declaring type.
        /// </summary>
        public string? Module { get; private set; }

        /// <summary>
        /// Gets whether application code owns this frame when explicitly known.
        /// </summary>
        public bool? InApp { get; private set; }

        /// <summary>
        /// Gets the optional normalized build Debug ID.
        /// </summary>
        public string? DebugId { get; private set; }

        /// <summary>
        /// Creates a frame with required source identity and positive coordinates.
        /// </summary>
        public static IssueStackFrame Create(string filename, int line, int column)
        {
            return new IssueStackFrame(filename, line, column);
        }

        /// <summary>
        /// Sets the optional function or method name.
        /// </summary>
        public IssueStackFrame WithFunction(string function)
        {
            Function = function;
            return this;
        }

        /// <summary>
        /// Sets the optional module or declaring type.
        /// </summary>
        public IssueStackFrame WithModule(string module)
        {
            Module = module;
            return this;
        }

        /// <summary>
        /// Marks whether application code owns this frame.
        /// </summary>
        public IssueStackFrame WithInApp(bool inApp)
        {
            InApp = inApp;
            return this;
        }

        /// <summary>
        /// Sets an optional build Debug ID.
        /// </summary>
        public IssueStackFrame WithDebugId(string debugId)
        {
            DebugId = debugId;
            return this;
        }

        internal OrderedJsonObject ToJsonObject()
        {
            var value = new OrderedJsonObject()
                .Add("filename", IssueDiagnostics.SanitizeFilename(Filename))
                .Add("line", IssueDiagnostics.RequireCoordinate("issue stack frame line", Line))
                .Add("column", IssueDiagnostics.RequireCoordinate("issue stack frame column", Column));
            if (Function != null)
            {
                value.Add("function", IssueDiagnostics.RequireFrameFunction(Function));
            }

            if (Module != null)
            {
                value.Add("module", IssueDiagnostics.RequireFrameModule(Module));
            }

            value.AddIfNotNull("inApp", InApp);
            if (DebugId != null)
            {
                value.Add("debugId", IssueDiagnostics.NormalizeDebugId(DebugId));
            }

            return value;
        }
    }
}
