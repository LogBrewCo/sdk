#nullable enable

using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;

namespace LogBrew.Unity
{
    /// <summary>How one runtime exception relates to its earlier parent node.</summary>
    public enum IssueExceptionRelationship
    {
        Reported,
        Cause,
        Context,
        AggregateMember,
        Suppressed,
    }

    /// <summary>Explicit capture state for one exception message.</summary>
    public enum IssueExceptionMessageState
    {
        Captured,
        Truncated,
        Redacted,
        NotCaptured,
    }

    /// <summary>Explicit capture state for one exception stack.</summary>
    public enum IssueExceptionStackFramesState
    {
        Captured,
        Truncated,
        NotCaptured,
    }

    /// <summary>One parent-first runtime exception with its own stack evidence.</summary>
    public sealed class IssueExceptionChainEntry
    {
        private List<IssueStackFrame>? stackFrames;

        private IssueExceptionChainEntry(int id, IssueExceptionRelationship relationship, string type)
        {
            Id = id;
            Relationship = relationship;
            Type = type;
            MessageState = IssueExceptionMessageState.NotCaptured;
            StackFramesState = IssueExceptionStackFramesState.NotCaptured;
        }

        public int Id { get; }

        public int? ParentId { get; private set; }

        public IssueExceptionRelationship Relationship { get; }

        public string Type { get; }

        public string? Message { get; private set; }

        public IssueExceptionMessageState MessageState { get; private set; }

        public string? Module { get; private set; }

        public IssueExceptionMechanism? Mechanism { get; private set; }

        public IReadOnlyList<IssueStackFrame>? StackFrames
        {
            get { return stackFrames?.AsReadOnly(); }
        }

        public IssueExceptionStackFramesState StackFramesState { get; private set; }

        public static IssueExceptionChainEntry Create(
            int id,
            IssueExceptionRelationship relationship,
            string type)
        {
            return new IssueExceptionChainEntry(id, relationship, type);
        }

        public IssueExceptionChainEntry WithParentId(int parentId)
        {
            ParentId = parentId;
            return this;
        }

        public IssueExceptionChainEntry WithMessage(string message, bool truncated = false)
        {
            Message = IssueDiagnostics.RequireExceptionMessage(message);
            MessageState = truncated
                ? IssueExceptionMessageState.Truncated
                : IssueExceptionMessageState.Captured;
            return this;
        }

        public IssueExceptionChainEntry WithRedactedMessage()
        {
            Message = null;
            MessageState = IssueExceptionMessageState.Redacted;
            return this;
        }

        public IssueExceptionChainEntry WithModule(string module)
        {
            Module = IssueDiagnostics.RequireExceptionModule(module);
            return this;
        }

        public IssueExceptionChainEntry WithMechanism(IssueExceptionMechanism mechanism)
        {
            Mechanism = mechanism ?? throw IssueDiagnostics.Validation(
                "issue exceptionChain mechanism must be provided");
            return this;
        }

        public IssueExceptionChainEntry WithStackFrames(
            IEnumerable<IssueStackFrame> frames,
            bool truncated = false)
        {
            if (frames == null)
            {
                throw IssueDiagnostics.Validation("issue exceptionChain stackFrames must be provided");
            }

            var copied = new List<IssueStackFrame>();
            foreach (var frame in frames)
            {
                if (frame == null)
                {
                    throw IssueDiagnostics.Validation("issue exceptionChain stack frame must be provided");
                }

                copied.Add(frame);
                if (copied.Count > IssueDiagnostics.MaxStackFrames)
                {
                    throw IssueDiagnostics.Validation(
                        "issue exceptionChain stackFrames must contain 1-32 frames");
                }
            }

            if (copied.Count == 0)
            {
                throw IssueDiagnostics.Validation(
                    "issue exceptionChain stackFrames must contain 1-32 frames");
            }

            stackFrames = copied;
            StackFramesState = truncated
                ? IssueExceptionStackFramesState.Truncated
                : IssueExceptionStackFramesState.Captured;
            return this;
        }

        internal OrderedJsonObject ToJsonObject()
        {
            var value = new OrderedJsonObject().Add("id", Id);
            value.AddIfNotNull("parentId", ParentId);
            value.Add("relationship", RelationshipName(Relationship))
                .Add("type", IssueDiagnostics.RequireExceptionType(Type));
            value.AddIfNotNull("message", Message);
            value.Add("messageState", MessageStateName(MessageState));
            value.AddIfNotNull("module", Module);
            value.AddIfNotNull("mechanism", Mechanism?.ToJsonObject());
            if (stackFrames != null)
            {
                value.Add("stackFrames", stackFrames.Select(frame => frame.ToJsonObject()).ToList());
            }

            value.Add("stackFramesState", StackFramesStateName(StackFramesState));
            return value;
        }

        private static string RelationshipName(IssueExceptionRelationship value)
        {
            switch (value)
            {
                case IssueExceptionRelationship.Reported:
                    return "reported";
                case IssueExceptionRelationship.Cause:
                    return "cause";
                case IssueExceptionRelationship.Context:
                    return "context";
                case IssueExceptionRelationship.AggregateMember:
                    return "aggregate_member";
                case IssueExceptionRelationship.Suppressed:
                    return "suppressed";
                default:
                    throw IssueDiagnostics.Validation("issue exceptionChain relationship is invalid");
            }
        }

        private static string MessageStateName(IssueExceptionMessageState value)
        {
            switch (value)
            {
                case IssueExceptionMessageState.Captured:
                    return "captured";
                case IssueExceptionMessageState.Truncated:
                    return "truncated";
                case IssueExceptionMessageState.Redacted:
                    return "redacted";
                case IssueExceptionMessageState.NotCaptured:
                    return "not_captured";
                default:
                    throw IssueDiagnostics.Validation("issue exceptionChain messageState is invalid");
            }
        }

        private static string StackFramesStateName(IssueExceptionStackFramesState value)
        {
            switch (value)
            {
                case IssueExceptionStackFramesState.Captured:
                    return "captured";
                case IssueExceptionStackFramesState.Truncated:
                    return "truncated";
                case IssueExceptionStackFramesState.NotCaptured:
                    return "not_captured";
                default:
                    throw IssueDiagnostics.Validation("issue exceptionChain stackFramesState is invalid");
            }
        }
    }

    /// <summary>At most eight parent-first runtime exceptions.</summary>
    public sealed class IssueExceptionChain
    {
        private readonly List<IssueExceptionChainEntry> entries;

        private IssueExceptionChain(IEnumerable<IssueExceptionChainEntry> entries, bool truncated)
        {
            if (entries == null)
            {
                throw IssueDiagnostics.Validation("issue exceptionChain entries must be provided");
            }

            this.entries = entries.ToList();
            Truncated = truncated;
        }

        public IReadOnlyList<IssueExceptionChainEntry> Entries
        {
            get { return entries.AsReadOnly(); }
        }

        public bool Truncated { get; }

        public static IssueExceptionChain Create(
            IEnumerable<IssueExceptionChainEntry> entries,
            bool truncated = false)
        {
            return new IssueExceptionChain(entries, truncated);
        }

        internal static IssueExceptionChain FromException(
            Exception error,
            IssueExceptionMechanism rootMechanism,
            IssueStackEvidence rootStack)
        {
            var state = new ExceptionChainBuilder(rootMechanism, rootStack);
            state.AddRoot(error);
            return new IssueExceptionChain(state.Entries, state.Truncated);
        }

        internal OrderedJsonObject ToJsonObject(
            IssueExceptionInfo? legacyException,
            IReadOnlyList<IssueStackFrame>? legacyFrames)
        {
            Validate(legacyException, legacyFrames);
            return new OrderedJsonObject()
                .Add("entries", entries.Select(entry => entry.ToJsonObject()).ToList())
                .Add("truncated", Truncated);
        }

        private void Validate(
            IssueExceptionInfo? legacyException,
            IReadOnlyList<IssueStackFrame>? legacyFrames)
        {
            if (entries.Count == 0 || entries.Count > IssueDiagnostics.MaxExceptions)
            {
                throw IssueDiagnostics.Validation(
                    "issue exceptionChain entries must contain 1-8 exceptions");
            }

            for (var index = 0; index < entries.Count; index++)
            {
                ValidateEntry(entries[index], index);
            }

            var root = entries[0];
            if (legacyException == null
                || IssueDiagnostics.RequireExceptionType(root.Type)
                    != IssueDiagnostics.RequireExceptionType(legacyException.Type)
                || !MechanismsEqual(root.Mechanism, legacyException.Mechanism))
            {
                throw IssueDiagnostics.Validation(
                    "issue exceptionChain reported exception must match exception");
            }

            if (!FramesEqual(root.StackFrames, legacyFrames))
            {
                throw IssueDiagnostics.Validation(
                    "issue exceptionChain reported stack must match stackFrames");
            }
        }

        private static void ValidateEntry(IssueExceptionChainEntry? entry, int index)
        {
            if (entry == null || entry.Id != index)
            {
                throw IssueDiagnostics.Validation(
                    "issue exceptionChain ids must be contiguous and match array order");
            }

            if (index == 0)
            {
                if (entry.Relationship != IssueExceptionRelationship.Reported
                    || entry.ParentId != null)
                {
                    throw IssueDiagnostics.Validation(
                        "issue exceptionChain entry 0 must be the parentless reported exception");
                }

                return;
            }

            if (entry.Relationship == IssueExceptionRelationship.Reported
                || entry.ParentId == null
                || entry.ParentId < 0
                || entry.ParentId >= index)
            {
                throw IssueDiagnostics.Validation(
                    "issue exceptionChain parent relationship is invalid");
            }
        }

        private static bool MechanismsEqual(
            IssueExceptionMechanism? left,
            IssueExceptionMechanism? right)
        {
            if (left == null || right == null)
            {
                return left == right;
            }

            return IssueDiagnostics.RequireMechanismType(left.Type)
                    == IssueDiagnostics.RequireMechanismType(right.Type)
                && left.Handled == right.Handled;
        }

        private static bool FramesEqual(
            IReadOnlyList<IssueStackFrame>? left,
            IReadOnlyList<IssueStackFrame>? right)
        {
            if (left == null || right == null)
            {
                return left == right;
            }

            if (left.Count != right.Count)
            {
                return false;
            }

            for (var index = 0; index < left.Count; index++)
            {
                if (!FrameEqual(left[index], right[index]))
                {
                    return false;
                }
            }

            return true;
        }

        private static bool FrameEqual(IssueStackFrame left, IssueStackFrame right)
        {
            return IssueDiagnostics.SanitizeFilename(left.Filename)
                    == IssueDiagnostics.SanitizeFilename(right.Filename)
                && left.Line == right.Line
                && left.Column == right.Column
                && NormalizeFrameFunction(left.Function) == NormalizeFrameFunction(right.Function)
                && NormalizeFrameModule(left.Module) == NormalizeFrameModule(right.Module)
                && left.InApp == right.InApp
                && NormalizeDebugId(left.DebugId) == NormalizeDebugId(right.DebugId);
        }

        private static string? NormalizeFrameFunction(string? value)
        {
            return value == null ? null : IssueDiagnostics.RequireFrameFunction(value);
        }

        private static string? NormalizeFrameModule(string? value)
        {
            return value == null ? null : IssueDiagnostics.RequireFrameModule(value);
        }

        private static string? NormalizeDebugId(string? value)
        {
            return value == null ? null : IssueDiagnostics.NormalizeDebugId(value);
        }

        private sealed class ExceptionChainBuilder
        {
            private readonly HashSet<Exception> seen = new HashSet<Exception>(
                ExceptionReferenceComparer.Instance);
            private readonly IssueExceptionMechanism rootMechanism;
            private readonly IssueStackEvidence rootStack;

            internal ExceptionChainBuilder(
                IssueExceptionMechanism rootMechanism,
                IssueStackEvidence rootStack)
            {
                this.rootMechanism = rootMechanism;
                this.rootStack = rootStack;
            }

            internal List<IssueExceptionChainEntry> Entries { get; } =
                new List<IssueExceptionChainEntry>();

            internal bool Truncated { get; private set; }

            internal void AddRoot(Exception error)
            {
                seen.Add(error);
                Add(error, null, IssueExceptionRelationship.Reported, rootMechanism, rootStack);
            }

            private void Add(
                Exception error,
                int? parentId,
                IssueExceptionRelationship relationship,
                IssueExceptionMechanism mechanism,
                IssueStackEvidence? knownStack = null)
            {
                if (Entries.Count >= IssueDiagnostics.MaxExceptions)
                {
                    Truncated = true;
                    return;
                }

                var id = Entries.Count;
                var stack = knownStack ?? IssueDiagnostics.StackEvidence(error);
                var entry = IssueExceptionChainEntry.Create(
                    id,
                    relationship,
                    IssueDiagnostics.SafeExceptionType(error))
                    .WithMechanism(mechanism)
                    .WithRedactedMessage();
                if (parentId != null)
                {
                    entry.WithParentId(parentId.Value);
                }

                var exceptionModule = IssueDiagnostics.SafeExceptionModule(error);
                if (exceptionModule != null)
                {
                    entry.WithModule(exceptionModule);
                }

                if (stack.Frames.Count > 0)
                {
                    entry.WithStackFrames(stack.Frames, stack.Truncated);
                }

                Entries.Add(entry);
                AddChildren(error, id);
            }

            private void AddChildren(Exception error, int parentId)
            {
                if (error is AggregateException aggregate)
                {
                    foreach (var child in aggregate.InnerExceptions)
                    {
                        AddChild(child, parentId, IssueExceptionRelationship.AggregateMember);
                    }

                    return;
                }

                if (error.InnerException != null)
                {
                    AddChild(error.InnerException, parentId, IssueExceptionRelationship.Cause);
                }
            }

            private void AddChild(
                Exception child,
                int parentId,
                IssueExceptionRelationship relationship)
            {
                if (!seen.Add(child))
                {
                    Truncated = true;
                    return;
                }

                var mechanism = IssueExceptionMechanism.Create(
                    relationship == IssueExceptionRelationship.AggregateMember
                        ? "unity.aggregate_member"
                        : "unity.inner_exception",
                    true);
                Add(child, parentId, relationship, mechanism);
            }
        }

        private sealed class ExceptionReferenceComparer : IEqualityComparer<Exception>
        {
            internal static ExceptionReferenceComparer Instance { get; } =
                new ExceptionReferenceComparer();

            public bool Equals(Exception? left, Exception? right)
            {
                return ReferenceEquals(left, right);
            }

            public int GetHashCode(Exception value)
            {
                return RuntimeHelpers.GetHashCode(value);
            }
        }
    }

    internal sealed class IssueStackEvidence
    {
        internal IssueStackEvidence(IReadOnlyList<IssueStackFrame> frames, bool truncated)
        {
            Frames = frames;
            Truncated = truncated;
        }

        internal IReadOnlyList<IssueStackFrame> Frames { get; }

        internal bool Truncated { get; }
    }
}
