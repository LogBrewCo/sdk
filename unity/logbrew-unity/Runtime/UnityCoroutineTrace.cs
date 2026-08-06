#nullable enable

using System;
using System.Collections;
using System.Collections.Generic;

namespace LogBrew.Unity
{
    public sealed class UnityTraceCoroutine : IEnumerator, IDisposable
    {
        private readonly IEnumerator routine;
        private readonly LogBrewTraceContext context;
        private readonly TelemetryContext? telemetryContext;
        private bool disposed;

        internal UnityTraceCoroutine(IEnumerator routine, LogBrewTraceContext context, TelemetryContext? telemetryContext)
        {
            this.routine = routine;
            this.context = context;
            this.telemetryContext = telemetryContext;
        }

        public object? Current
        {
            get
            {
                return disposed ? null : routine.Current;
            }
        }

        public bool MoveNext()
        {
            if (disposed)
            {
                return false;
            }

            using (ActivateTelemetryContext(telemetryContext))
            using (LogBrewTrace.Activate(context))
            {
                return routine.MoveNext();
            }
        }

        public void Reset()
        {
            if (disposed)
            {
                return;
            }

            using (ActivateTelemetryContext(telemetryContext))
            using (LogBrewTrace.Activate(context))
            {
                routine.Reset();
            }
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }

            if (routine is IDisposable disposable)
            {
                using (ActivateTelemetryContext(telemetryContext))
                using (LogBrewTrace.Activate(context))
                {
                    disposable.Dispose();
                }
            }

            disposed = true;
        }

        internal static IDisposable ActivateTelemetryContext(TelemetryContext? context)
        {
            return context == null ? EmptyScope.Instance : LogBrewTelemetry.ActivateContext(context);
        }

        private sealed class EmptyScope : IDisposable
        {
            internal static readonly EmptyScope Instance = new EmptyScope();

            public void Dispose()
            {
            }
        }
    }

    public sealed class UnityTrackedCoroutine : IEnumerator, IDisposable
    {
        private readonly IEnumerator routine;
        private readonly LogBrewClient client;
        private readonly Func<string> idFactory;
        private readonly Func<string> timestampFactory;
        private readonly Func<double> realtimeMilliseconds;
        private readonly LogBrewTraceContext context;
        private readonly TelemetryContext? telemetryContext;
        private readonly string name;
        private readonly Dictionary<string, object?> metadata;
        private readonly double startedAtMs;
        private bool captured;
        private bool disposed;

        internal UnityTrackedCoroutine(
            IEnumerator routine,
            LogBrewClient client,
            Func<string> idFactory,
            Func<string> timestampFactory,
            Func<double> realtimeMilliseconds,
            LogBrewTraceContext context,
            TelemetryContext? telemetryContext,
            string name,
            IDictionary<string, object?> metadata)
        {
            this.routine = routine;
            this.client = client;
            this.idFactory = idFactory;
            this.timestampFactory = timestampFactory;
            this.realtimeMilliseconds = realtimeMilliseconds;
            this.context = context;
            this.telemetryContext = telemetryContext;
            this.name = name;
            this.metadata = new Dictionary<string, object?>(metadata, StringComparer.Ordinal);
            startedAtMs = ValidateCoroutineClock(realtimeMilliseconds());
        }

        public object? Current
        {
            get
            {
                return disposed ? null : routine.Current;
            }
        }

        public bool MoveNext()
        {
            if (disposed)
            {
                return false;
            }

            bool hasNext;
            try
            {
                using (UnityTraceCoroutine.ActivateTelemetryContext(telemetryContext))
                using (LogBrewTrace.Activate(context))
                {
                    hasNext = routine.MoveNext();
                }
            }
            catch (Exception error)
            {
                Capture("error", "exception", error.GetType().Name);
                throw;
            }

            if (!hasNext)
            {
                Capture("ok", "completed", null);
            }

            return hasNext;
        }

        public void Reset()
        {
            if (disposed)
            {
                return;
            }

            using (UnityTraceCoroutine.ActivateTelemetryContext(telemetryContext))
            using (LogBrewTrace.Activate(context))
            {
                routine.Reset();
            }
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }

            if (routine is IDisposable disposable)
            {
                using (UnityTraceCoroutine.ActivateTelemetryContext(telemetryContext))
                using (LogBrewTrace.Activate(context))
                {
                    disposable.Dispose();
                }
            }

            disposed = true;
        }

        private void Capture(string status, string outcome, string? errorType)
        {
            if (captured)
            {
                return;
            }

            captured = true;
            var currentMetadata = new Dictionary<string, object?>(metadata, StringComparer.Ordinal)
            {
                ["source"] = "unity.coroutine",
                ["coroutineName"] = name,
                ["outcome"] = outcome
            };
            if (errorType != null)
            {
                currentMetadata["errorType"] = errorType;
            }

            var durationMs = Math.Max(0, ValidateCoroutineClock(realtimeMilliseconds()) - startedAtMs);
            var attributes = LogBrewTrace.SpanAttributes(
                "unity.coroutine:" + name,
                status,
                durationMs,
                currentMetadata,
                context);
            if (telemetryContext != null)
            {
                attributes.WithContext(telemetryContext);
            }

            client.Span(idFactory(), timestampFactory(), attributes);
        }

        internal static double ValidateCoroutineClock(double value)
        {
            if (double.IsNaN(value) || double.IsInfinity(value))
            {
                throw new SdkException("validation_error", "unity coroutine realtimeMilliseconds must be finite");
            }

            return value;
        }
    }

    public sealed class UnityCoroutineTracker
    {
        private readonly LogBrewClient client;
        private readonly Func<string> idFactory;
        private readonly Func<string> timestampFactory;
        private readonly Func<double> realtimeMilliseconds;
        private readonly UnityContext? defaultContext;

        public UnityCoroutineTracker(
            LogBrewClient client,
            Func<string> idFactory,
            Func<string> timestampFactory,
            Func<double> realtimeMilliseconds,
            UnityContext? context = null)
        {
            this.client = client ?? throw new ArgumentNullException(nameof(client));
            this.idFactory = idFactory ?? throw new ArgumentNullException(nameof(idFactory));
            this.timestampFactory = timestampFactory ?? throw new ArgumentNullException(nameof(timestampFactory));
            this.realtimeMilliseconds = realtimeMilliseconds ?? throw new ArgumentNullException(nameof(realtimeMilliseconds));
            UnityTrackedCoroutine.ValidateCoroutineClock(this.realtimeMilliseconds());
            defaultContext = context;
        }

        public UnityTrackedCoroutine Trace(
            string name,
            IEnumerator routine,
            LogBrewTraceContext? traceContext = null,
            UnityContext? context = null)
        {
            if (name == null)
            {
                throw new ArgumentNullException(nameof(name));
            }

            if (routine == null)
            {
                throw new ArgumentNullException(nameof(routine));
            }

            var normalizedName = NormalizeCoroutineName(name);
            var parentContext = traceContext ?? LogBrewTrace.Current ?? LogBrewTraceContext.CreateRoot();
            return new UnityTrackedCoroutine(
                routine,
                client,
                idFactory,
                timestampFactory,
                realtimeMilliseconds,
                LogBrewTraceContext.CreateChild(parentContext),
                TelemetryContext.Merge(
                    LogBrewTelemetry.CurrentContext,
                    TelemetryContext.Merge(defaultContext?.ToTelemetryContext(), context?.ToTelemetryContext())),
                normalizedName,
                MetadataFor(context));
        }

        private Dictionary<string, object?> MetadataFor(UnityContext? context)
        {
            var metadata = LogBrewUnity.MetadataFromContext(defaultContext);
            if (context == null)
            {
                return metadata;
            }

            foreach (var item in context.ToMetadata())
            {
                metadata[item.Key] = item.Value;
            }

            return metadata;
        }

        private static string NormalizeCoroutineName(string name)
        {
            Validation.RequireNonEmpty("unity coroutine name", name);
            return name.Trim();
        }
    }

    public static partial class LogBrewUnity
    {
        public static UnityTraceCoroutine TraceCoroutine(
            IEnumerator routine,
            LogBrewTraceContext? context = null,
            TelemetryContext? telemetryContext = null)
        {
            if (routine == null)
            {
                throw new ArgumentNullException(nameof(routine));
            }

            var capturedContext = context ?? LogBrewTrace.Current ?? LogBrewTraceContext.CreateRoot();
            return new UnityTraceCoroutine(
                routine,
                capturedContext,
                TelemetryContext.Merge(LogBrewTelemetry.CurrentContext, telemetryContext));
        }
    }
}
