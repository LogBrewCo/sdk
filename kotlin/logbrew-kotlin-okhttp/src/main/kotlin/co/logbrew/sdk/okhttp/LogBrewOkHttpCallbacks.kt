package co.logbrew.sdk.okhttp

import co.logbrew.sdk.LogBrewTrace
import co.logbrew.sdk.LogBrewTraceContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Response
import java.io.IOException

object LogBrewOkHttpCallbacks {
    @JvmStatic
    @JvmOverloads
    fun wrap(
        callback: Callback,
        traceContext: LogBrewTraceContext? = LogBrewTrace.currentTraceContext(),
    ): Callback {
        if (traceContext == null) {
            return callback
        }
        return TracedCallback(callback, traceContext)
    }

    private class TracedCallback(
        private val delegate: Callback,
        private val traceContext: LogBrewTraceContext,
    ) : Callback {
        override fun onFailure(
            call: Call,
            e: IOException,
        ) {
            LogBrewTrace.use(traceContext).use {
                delegate.onFailure(call, e)
            }
        }

        @Throws(IOException::class)
        override fun onResponse(
            call: Call,
            response: Response,
        ) {
            LogBrewTrace.use(traceContext).use {
                delegate.onResponse(call, response)
            }
        }
    }
}
