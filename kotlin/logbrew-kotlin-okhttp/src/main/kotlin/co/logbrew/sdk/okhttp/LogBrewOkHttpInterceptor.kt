package co.logbrew.sdk.okhttp

import co.logbrew.sdk.AndroidContext
import co.logbrew.sdk.LogBrewAndroid
import co.logbrew.sdk.LogBrewClient
import co.logbrew.sdk.LogBrewTrace
import co.logbrew.sdk.LogBrewTraceContext
import okhttp3.Interceptor
import okhttp3.Request
import okhttp3.Response
import java.time.Instant
import java.util.concurrent.atomic.AtomicLong

fun interface LogBrewOkHttpEventIdProvider {
    fun eventId(request: Request): String
}

fun interface LogBrewOkHttpTimestampProvider {
    fun timestamp(request: Request): String
}

fun interface LogBrewOkHttpCaptureFailureHandler {
    fun onCaptureFailure(error: Throwable)
}

class LogBrewOkHttpInterceptor
    @JvmOverloads
    constructor(
        private val client: LogBrewClient,
        private val routeTemplate: String? = null,
        private val context: AndroidContext = AndroidContext.create(),
        private val metadata: Map<String, Any?> = emptyMap(),
        private val eventIdProvider: LogBrewOkHttpEventIdProvider = defaultEventIdProvider,
        private val timestampProvider: LogBrewOkHttpTimestampProvider = defaultTimestampProvider,
        private val captureFailureHandler: LogBrewOkHttpCaptureFailureHandler = LogBrewOkHttpCaptureFailureHandler {},
    ) : Interceptor {
        override fun intercept(chain: Interceptor.Chain): Response {
            val originalRequest = chain.request()
            return withTaggedTrace(originalRequest) {
                interceptWithCurrentTrace(chain, originalRequest)
            }
        }

        private fun interceptWithCurrentTrace(
            chain: Interceptor.Chain,
            originalRequest: Request,
        ): Response {
            val requestSpan =
                try {
                    LogBrewAndroid.startRequestSpan(
                        method = originalRequest.method,
                        routeTemplate =
                            LogBrewOkHttpRouteTemplates.get(originalRequest)
                                ?: routeTemplate
                                ?: originalRequest.url.encodedPath,
                        context = context,
                        metadata = metadata,
                    )
                } catch (error: Throwable) {
                    reportCaptureFailure(error)
                    return chain.proceed(originalRequest)
                }

            val tracedRequest =
                originalRequest
                    .newBuilder()
                    .also { builder ->
                        requestSpan.applyHeadersTo { name, value -> builder.header(name, value) }
                    }.build()

            val startedAtMs = monotonicTimeMs()
            var statusCode: Int? = null
            var error: Throwable? = null

            try {
                val response = requestSpan.withTrace { chain.proceed(tracedRequest) }
                statusCode = response.code
                return response
            } catch (thrown: Throwable) {
                error = thrown
                throw thrown
            } finally {
                try {
                    LogBrewAndroid.captureRequestSpan(
                        client = client,
                        id = eventIdProvider.eventId(originalRequest),
                        timestamp = timestampProvider.timestamp(originalRequest),
                        requestSpan = requestSpan,
                        statusCode = statusCode,
                        durationMs = (monotonicTimeMs() - startedAtMs).coerceAtLeast(0.0),
                        error = error,
                        metadata = phaseTimingMetadata(chain),
                    )
                } catch (captureError: Throwable) {
                    reportCaptureFailure(captureError)
                }
            }
        }

        private fun phaseTimingMetadata(chain: Interceptor.Chain): Map<String, Any?> =
            try {
                LogBrewOkHttpPhaseTimings.snapshot(chain.call())
            } catch (error: Throwable) {
                reportCaptureFailure(error)
                emptyMap()
            }

        private fun <T> withTaggedTrace(
            request: Request,
            block: () -> T,
        ): T {
            val traceContext = request.tag(LogBrewTraceContext::class.java) ?: return block()
            val scope =
                try {
                    LogBrewTrace.use(traceContext)
                } catch (error: Throwable) {
                    reportCaptureFailure(error)
                    return block()
                }
            return scope.use { block() }
        }

        private fun reportCaptureFailure(error: Throwable) {
            try {
                captureFailureHandler.onCaptureFailure(error)
            } catch (_: Throwable) {
                // OkHttp request execution must not depend on telemetry failure handling.
            }
        }

        private fun monotonicTimeMs(): Double = System.nanoTime().toDouble() / 1_000_000.0

        companion object {
            private val nextEventId = AtomicLong(1)
            private val defaultEventIdProvider =
                LogBrewOkHttpEventIdProvider {
                    "evt_okhttp_request_${nextEventId.getAndIncrement()}"
                }
            private val defaultTimestampProvider =
                LogBrewOkHttpTimestampProvider {
                    Instant.now().toString()
                }
        }
    }
