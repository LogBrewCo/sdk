package co.logbrew.sdk.okhttp

import co.logbrew.sdk.LogBrewTrace
import co.logbrew.sdk.LogBrewTraceContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Request
import okhttp3.Response
import okio.Timeout
import java.io.IOException

class LogBrewOkHttpCallFactory(
    private val delegate: Call.Factory,
) : Call.Factory {
    override fun newCall(request: Request): Call {
        val traceContext = LogBrewTrace.currentTraceContext() ?: return delegate.newCall(request)
        return TracedCall(delegate, request, traceContext)
    }

    private class TracedCall(
        private val delegateFactory: Call.Factory,
        private val originalRequest: Request,
        private val traceContext: LogBrewTraceContext,
    ) : Call {
        private val delegate = delegateFactory.newCall(originalRequest.withLogBrewTraceContext(traceContext))

        override fun request(): Request = delegate.request()

        @Throws(IOException::class)
        override fun execute(): Response =
            LogBrewTrace.use(traceContext).use {
                delegate.execute()
            }

        override fun enqueue(responseCallback: Callback) {
            delegate.enqueue(LogBrewOkHttpCallbacks.wrap(responseCallback, traceContext))
        }

        override fun cancel() {
            delegate.cancel()
        }

        override fun isExecuted(): Boolean = delegate.isExecuted()

        override fun isCanceled(): Boolean = delegate.isCanceled()

        override fun clone(): Call =
            TracedCall(
                delegateFactory = delegateFactory,
                originalRequest = originalRequest,
                traceContext = LogBrewTrace.currentTraceContext() ?: traceContext,
            )

        override fun timeout(): Timeout = delegate.timeout()
    }
}

internal fun Request.withLogBrewTraceContext(traceContext: LogBrewTraceContext): Request =
    newBuilder()
        .tag(LogBrewTraceContext::class.java, traceContext)
        .build()
