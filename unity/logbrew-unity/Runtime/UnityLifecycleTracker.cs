#nullable enable

using System;
using System.Collections.Generic;

namespace LogBrew.Unity
{
    public sealed class UnityLifecycleTracker
    {
        private readonly LogBrewClient client;
        private readonly Func<string> idFactory;
        private readonly Func<string> timestampFactory;
        private readonly Func<double> realtimeMilliseconds;
        private readonly UnityContext? defaultContext;
        private string currentState;
        private double currentStateStartedAtMs;

        public UnityLifecycleTracker(
            LogBrewClient client,
            Func<string> idFactory,
            Func<string> timestampFactory,
            Func<double> realtimeMilliseconds,
            string initialState = "active",
            UnityContext? context = null)
        {
            this.client = client ?? throw new ArgumentNullException(nameof(client));
            this.idFactory = idFactory ?? throw new ArgumentNullException(nameof(idFactory));
            this.timestampFactory = timestampFactory ?? throw new ArgumentNullException(nameof(timestampFactory));
            this.realtimeMilliseconds = realtimeMilliseconds ?? throw new ArgumentNullException(nameof(realtimeMilliseconds));
            if (initialState == null)
            {
                throw new ArgumentNullException(nameof(initialState));
            }

            currentState = NormalizeState("unity initialState", initialState);
            currentStateStartedAtMs = ReadClock();
            defaultContext = context;
        }

        public string CurrentState
        {
            get { return currentState; }
        }

        public bool CapturePause(bool paused, UnityContext? context = null)
        {
            return CaptureState(paused ? "paused" : "active", context);
        }

        public bool CaptureFocus(bool hasFocus, UnityContext? context = null)
        {
            return CaptureState(hasFocus ? "active" : "paused", context);
        }

        public bool CaptureState(string state, UnityContext? context = null)
        {
            if (state == null)
            {
                throw new ArgumentNullException(nameof(state));
            }

            var nextState = NormalizeState("unity lifecycle state", state);
            if (string.Equals(nextState, currentState, StringComparison.Ordinal))
            {
                return false;
            }

            var now = ReadClock();
            var previousState = currentState;
            var durationMs = Math.Max(0, now - currentStateStartedAtMs);
            LogBrewUnity.CaptureLifecycleSpanWithMetadata(
                client,
                idFactory(),
                timestampFactory(),
                previousState,
                nextState,
                durationMs,
                MetadataFor(context));
            currentState = nextState;
            currentStateStartedAtMs = now;
            return true;
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

        private double ReadClock()
        {
            var value = realtimeMilliseconds();
            if (double.IsNaN(value) || double.IsInfinity(value))
            {
                throw new SdkException("validation_error", "unity lifecycle clock must be finite");
            }

            return value;
        }

        private static string NormalizeState(string label, string state)
        {
            Validation.RequireNonEmpty(label, state);
            return state.Trim();
        }
    }
}
