namespace LogBrew
{
    /// <summary>
    /// Runtime path that captured an issue exception and whether it escaped.
    /// </summary>
    public sealed class IssueExceptionMechanism
    {
        private IssueExceptionMechanism(string type, bool handled)
        {
            Type = type;
            Handled = handled;
        }

        /// <summary>
        /// Gets the stable capture mechanism name.
        /// </summary>
        public string Type { get; }

        /// <summary>
        /// Gets whether application code handled the exception.
        /// </summary>
        public bool Handled { get; }

        /// <summary>
        /// Creates a typed issue mechanism with an explicit handled state.
        /// </summary>
        public static IssueExceptionMechanism Create(string type, bool handled)
        {
            return new IssueExceptionMechanism(type, handled);
        }

        internal OrderedJsonObject ToJsonObject()
        {
            return new OrderedJsonObject()
                .Add("type", IssueDiagnostics.RequireMechanismType(Type))
                .Add("handled", Handled);
        }
    }

    /// <summary>
    /// Structured exception identity attached to an issue.
    /// </summary>
    public sealed class IssueExceptionInfo
    {
        private IssueExceptionInfo(string type)
        {
            Type = type;
        }

        /// <summary>
        /// Gets the stable exception type name.
        /// </summary>
        public string Type { get; }

        /// <summary>
        /// Gets the optional capture mechanism.
        /// </summary>
        public IssueExceptionMechanism? Mechanism { get; private set; }

        /// <summary>
        /// Creates exception identity from a stable type name.
        /// </summary>
        public static IssueExceptionInfo Create(string type)
        {
            return new IssueExceptionInfo(type);
        }

        /// <summary>
        /// Sets the optional capture mechanism and handled state.
        /// </summary>
        public IssueExceptionInfo WithMechanism(IssueExceptionMechanism mechanism)
        {
            if (mechanism == null)
            {
                throw IssueDiagnostics.Validation("issue exception mechanism must be provided");
            }

            Mechanism = mechanism;
            return this;
        }

        internal OrderedJsonObject ToJsonObject()
        {
            var value = new OrderedJsonObject().Add("type", IssueDiagnostics.RequireExceptionType(Type));
            value.AddIfNotNull("mechanism", Mechanism?.ToJsonObject());
            return value;
        }
    }
}
