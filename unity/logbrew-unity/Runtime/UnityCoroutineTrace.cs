#nullable enable

using System;
using System.Collections;

namespace LogBrew.Unity
{
    public sealed class UnityTraceCoroutine : IEnumerator, IDisposable
    {
        private readonly IEnumerator routine;
        private readonly LogBrewTraceContext context;
        private bool disposed;

        internal UnityTraceCoroutine(IEnumerator routine, LogBrewTraceContext context)
        {
            this.routine = routine;
            this.context = context;
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
                disposable.Dispose();
            }

            disposed = true;
        }
    }

    public static partial class LogBrewUnity
    {
        public static UnityTraceCoroutine TraceCoroutine(
            IEnumerator routine,
            LogBrewTraceContext? context = null)
        {
            if (routine == null)
            {
                throw new ArgumentNullException(nameof(routine));
            }

            var capturedContext = context ?? LogBrewTrace.Current ?? LogBrewTraceContext.CreateRoot();
            return new UnityTraceCoroutine(routine, capturedContext);
        }
    }
}
