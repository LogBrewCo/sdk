using System.Collections.Generic;
using System.Linq;

namespace LogBrew
{
    /// <summary>
    /// Public payload fields for an issue event.
    /// </summary>
    public sealed class IssueAttributes
    {
        private List<IssueStackFrame>? stackFrames;
        private List<IssueBreadcrumb>? breadcrumbs;

        private IssueAttributes(string title, string level)
        {
            Title = title;
            Level = level;
        }

        public string Title { get; }

        public string Level { get; }

        public string? Message { get; private set; }

        public IDictionary<string, object?>? Metadata { get; private set; }

        internal TelemetryContext? Context { get; private set; }

        public IssueExceptionInfo? Exception { get; private set; }

        public IssueExceptionChain? ExceptionChain { get; private set; }

        public IReadOnlyList<IssueStackFrame>? StackFrames
        {
            get { return stackFrames?.AsReadOnly(); }
        }

        public IReadOnlyList<IssueBreadcrumb>? Breadcrumbs
        {
            get { return breadcrumbs?.AsReadOnly(); }
        }

        public bool BreadcrumbsTruncated { get; private set; }

        public static IssueAttributes Create(string title, string level)
        {
            return new IssueAttributes(title, level);
        }

        public static IssueAttributes FromException(System.Exception error)
        {
            var exceptionType = IssueDiagnostics.SafeExceptionType(error);
            return FromException(error, exceptionType, "dotnet.exception", true);
        }

        public static IssueAttributes FromException(
            System.Exception error,
            string mechanismType,
            bool handled)
        {
            var exceptionType = IssueDiagnostics.SafeExceptionType(error);
            return FromException(error, exceptionType, mechanismType, handled);
        }

        public static IssueAttributes FromException(
            System.Exception error,
            string title,
            string mechanismType,
            bool handled)
        {
            var exceptionType = IssueDiagnostics.SafeExceptionType(error);
            var attributes = Create(title, "error")
                .WithException(
                    IssueExceptionInfo.Create(exceptionType)
                        .WithMechanism(IssueExceptionMechanism.Create(mechanismType, handled)));
            var stack = IssueDiagnostics.StackEvidence(error);
            if (stack.Frames.Count > 0)
            {
                attributes.WithStackFrames(stack.Frames);
            }

            attributes.WithExceptionChain(IssueExceptionChain.FromException(
                error,
                attributes.Exception!.Mechanism!,
                stack));

            return attributes;
        }

        public IssueAttributes WithMessage(string message)
        {
            Message = message;
            return this;
        }

        public IssueAttributes WithMetadata(IDictionary<string, object?> metadata)
        {
            Metadata = metadata;
            return this;
        }

        /// <summary>Sets shared resource and correlation context.</summary>
        public IssueAttributes WithContext(TelemetryContext context)
        {
            ExceptionContract.ThrowIfNull(context, nameof(context));
            Context = context;
            return this;
        }

        public IssueAttributes WithException(IssueExceptionInfo exception)
        {
            if (exception == null)
            {
                throw IssueDiagnostics.Validation("issue exception must be provided");
            }

            Exception = exception;
            return this;
        }

        public IssueAttributes WithExceptionChain(IssueExceptionChain exceptionChain)
        {
            ExceptionChain = exceptionChain ?? throw IssueDiagnostics.Validation(
                "issue exceptionChain must be provided");
            return this;
        }

        public IssueAttributes WithStackFrame(IssueStackFrame frame)
        {
            if (frame == null)
            {
                throw IssueDiagnostics.Validation("issue stack frame must be provided");
            }

            stackFrames ??= new List<IssueStackFrame>();
            RequireStackFrameLimit(stackFrames.Count + 1);
            stackFrames.Add(frame);
            return this;
        }

        public IssueAttributes WithStackFrames(IEnumerable<IssueStackFrame> frames)
        {
            if (frames == null)
            {
                throw IssueDiagnostics.Validation("issue stackFrames must be provided");
            }

            var copied = new List<IssueStackFrame>();
            foreach (var frame in frames)
            {
                if (frame == null)
                {
                    throw IssueDiagnostics.Validation("issue stack frame must be provided");
                }

                copied.Add(frame);
                RequireStackFrameLimit(copied.Count);
            }

            if (copied.Count == 0)
            {
                throw IssueDiagnostics.Validation("issue stackFrames must contain 1-32 frames");
            }

            stackFrames = copied;
            return this;
        }

        public IssueAttributes WithBreadcrumb(IssueBreadcrumb breadcrumb)
        {
            if (breadcrumb == null)
            {
                throw IssueDiagnostics.Validation("issue breadcrumb must be provided");
            }

            breadcrumbs ??= new List<IssueBreadcrumb>();
            RequireBreadcrumbLimit(breadcrumbs.Count + 1);
            breadcrumbs.Add(breadcrumb);
            return this;
        }

        public IssueAttributes WithBreadcrumbs(IEnumerable<IssueBreadcrumb> values)
        {
            if (values == null)
            {
                throw IssueDiagnostics.Validation("issue breadcrumbs must be provided");
            }

            var copied = new List<IssueBreadcrumb>();
            foreach (var breadcrumb in values)
            {
                if (breadcrumb == null)
                {
                    throw IssueDiagnostics.Validation("issue breadcrumb must be provided");
                }

                copied.Add(breadcrumb);
                RequireBreadcrumbLimit(copied.Count);
            }

            if (copied.Count == 0)
            {
                throw IssueDiagnostics.Validation("issue breadcrumbs must contain 1-64 entries");
            }

            breadcrumbs = copied;
            return this;
        }

        public IssueAttributes WithBreadcrumbsTruncated(bool truncated)
        {
            BreadcrumbsTruncated = truncated;
            return this;
        }

        internal OrderedJsonObject ToJsonObject()
        {
            Validation.RequireNonEmpty("issue title", Title);
            var level = Validation.NormalizeSeverity("issue level", Level);
            var payload = new OrderedJsonObject().Add("title", Title).Add("level", level);
            payload.AddIfNotNull("message", Message);
            payload.AddIfNotNull("exception", Exception?.ToJsonObject());
            payload.AddIfNotNull(
                "exceptionChain",
                ExceptionChain?.ToJsonObject(Exception, StackFrames));
            if (stackFrames != null)
            {
                payload.Add("stackFrames", stackFrames.Select(frame => frame.ToJsonObject()).ToList());
            }

            if (breadcrumbs != null)
            {
                payload.Add("breadcrumbs", breadcrumbs.Select(breadcrumb => breadcrumb.ToJsonObject()).ToList());
            }

            if (BreadcrumbsTruncated)
            {
                payload.Add("breadcrumbsTruncated", true);
            }

            payload.AddMetadata(Metadata);
            return payload;
        }

        private static void RequireStackFrameLimit(int count)
        {
            if (count > IssueDiagnostics.MaxStackFrames)
            {
                throw IssueDiagnostics.Validation("issue stackFrames must contain 1-32 frames");
            }
        }

        private static void RequireBreadcrumbLimit(int count)
        {
            if (count > IssueDiagnostics.MaxBreadcrumbs)
            {
                throw IssueDiagnostics.Validation("issue breadcrumbs must contain 1-64 entries");
            }
        }
    }
}
