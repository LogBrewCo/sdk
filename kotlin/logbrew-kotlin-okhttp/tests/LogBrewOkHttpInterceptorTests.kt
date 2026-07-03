import co.logbrew.sdk.LogBrewClient
import co.logbrew.sdk.LogBrewTrace
import co.logbrew.sdk.LogBrewTraceContext
import co.logbrew.sdk.SdkException
import co.logbrew.sdk.okhttp.LogBrewOkHttpCallFactory
import co.logbrew.sdk.okhttp.LogBrewOkHttpCallbacks
import co.logbrew.sdk.okhttp.LogBrewOkHttpCaptureFailureHandler
import co.logbrew.sdk.okhttp.LogBrewOkHttpEventIdProvider
import co.logbrew.sdk.okhttp.LogBrewOkHttpInterceptor
import co.logbrew.sdk.okhttp.LogBrewOkHttpRouteTemplates
import co.logbrew.sdk.okhttp.LogBrewOkHttpTimestampProvider
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Connection
import okhttp3.Interceptor
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okio.Timeout
import java.io.IOException
import java.util.concurrent.TimeUnit

fun main() {
    run("okhttp_interceptor_injects_traceparent_and_captures_response_span", ::okHttpInterceptorCapturesResponse)
    run("okhttp_interceptor_rethrows_original_failure_and_captures_error_span", ::okHttpInterceptorCapturesFailure)
    run("okhttp_interceptor_prefers_request_route_template_tag", ::okHttpInterceptorPrefersRequestRouteTemplateTag)
    run("okhttp_interceptor_reports_capture_failure_without_breaking_request", ::okHttpInterceptorReportsCaptureFailure)
    run("okhttp_callback_wrapper_reactivates_registration_trace", ::okHttpCallbackWrapperReactivatesTrace)
    run("okhttp_call_factory_carries_trace_into_async_request_and_callback", ::okHttpCallFactoryCarriesTrace)
    run("okhttp_call_factory_preserves_request_route_template_tag", ::okHttpCallFactoryPreservesRouteTemplateTag)
    println("kotlin okhttp package tests ok (7 tests)")
}

private fun run(
    name: String,
    test: () -> Unit,
) {
    try {
        test()
    } catch (error: Throwable) {
        throw IllegalStateException("$name failed", error)
    }
}

private fun okHttpInterceptorCapturesResponse() {
    val parent =
        LogBrewTrace.continueOrCreate(
            "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
        )
    val client = newClient()
    val chain =
        FakeChain(
            Request
                .Builder()
                .url("https://mobile.example.test/api/orders?cart=123#pay")
                .header("traceparent", "00-00000000000000000000000000000001-0000000000000001-01")
                .header("x-private-header", "do-not-capture")
                .build(),
            code = 201,
        ) { proceededRequest ->
            check(LogBrewTrace.currentTraceContext()?.parentSpanId == parent.spanId)
            check(proceededRequest.headers("traceparent").size == 1)
        }
    val interceptor =
        LogBrewOkHttpInterceptor(
            client = client,
            eventIdProvider = LogBrewOkHttpEventIdProvider { "evt_okhttp_request_001" },
            timestampProvider = LogBrewOkHttpTimestampProvider { "2026-06-02T10:00:33Z" },
        )

    LogBrewTrace.use(parent).use {
        val response = interceptor.intercept(chain)
        check(response.code == 201)
        check(LogBrewTrace.currentTraceContext() == parent)
    }
    check(LogBrewTrace.currentTraceContext() == null)

    val proceededRequest = chain.proceededRequest ?: error("expected proceeded request")
    val traceparent = proceededRequest.header("traceparent") ?: error("expected traceparent")
    check(traceparent.startsWith("00-${parent.traceId}-"))
    check("0000000000000001" !in traceparent)

    val body = client.previewJson()
    check("\"id\": \"evt_okhttp_request_001\"" in body)
    check("\"name\": \"GET /api/orders\"" in body)
    check("\"statusCode\": 201" in body)
    check("\"durationMs\"" in body)
    check("\"traceId\": \"${parent.traceId}\"" in body)
    check("\"parentSpanId\": \"${parent.spanId}\"" in body)
    check("cart=123" !in body)
    check("#pay" !in body)
    check("x-private-header" !in body)
    check("do-not-capture" !in body)
    check("traceparent" !in body)
}

private fun okHttpInterceptorCapturesFailure() {
    val parent =
        LogBrewTrace.continueOrCreate(
            "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
        )
    val client = newClient()
    val failure = IOException("network down")
    val chain =
        FakeChain(
            Request.Builder().url("https://mobile.example.test/api/fail?debug_code=abc").build(),
            failure = failure,
        )
    val interceptor =
        LogBrewOkHttpInterceptor(
            client = client,
            routeTemplate = "/api/fail/{id}",
            eventIdProvider = LogBrewOkHttpEventIdProvider { "evt_okhttp_request_002" },
            timestampProvider = LogBrewOkHttpTimestampProvider { "2026-06-02T10:00:34Z" },
        )

    LogBrewTrace.use(parent).use {
        try {
            interceptor.intercept(chain)
            error("expected IOException")
        } catch (error: IOException) {
            check(error === failure)
        }
        check(LogBrewTrace.currentTraceContext() == parent)
    }
    check(LogBrewTrace.currentTraceContext() == null)

    val body = client.previewJson()
    check("\"id\": \"evt_okhttp_request_002\"" in body)
    check("\"name\": \"GET /api/fail/{id}\"" in body)
    check("\"status\": \"error\"" in body)
    check("\"errorType\": \"IOException\"" in body)
    check("\"errorMessage\": \"network down\"" in body)
    check("debug_code=abc" !in body)
    check("traceparent" !in body)
}

private fun okHttpInterceptorPrefersRequestRouteTemplateTag() {
    val parent =
        LogBrewTrace.continueOrCreate(
            "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
        )
    val client = newClient()
    val request =
        LogBrewOkHttpRouteTemplates.tag(
            Request
                .Builder()
                .url("https://mobile.example.test/api/orders/ord_123/private?cart=123#pay")
                .build(),
            "/api/orders/{order_id}",
        )
    val chain =
        FakeChain(
            request,
            code = 202,
        )
    val interceptor =
        LogBrewOkHttpInterceptor(
            client = client,
            routeTemplate = "/interceptor/default/{id}",
            eventIdProvider = LogBrewOkHttpEventIdProvider { "evt_okhttp_route_tag_001" },
            timestampProvider = LogBrewOkHttpTimestampProvider { "2026-06-02T10:00:37Z" },
        )

    LogBrewTrace.use(parent).use {
        check(interceptor.intercept(chain).code == 202)
    }

    val body = client.previewJson()
    check("\"id\": \"evt_okhttp_route_tag_001\"" in body)
    check("\"name\": \"GET /api/orders/{order_id}\"" in body)
    check("\"routeTemplate\": \"/api/orders/{order_id}\"" in body)
    check("\"http.route\": \"/api/orders/{order_id}\"" in body)
    check("/interceptor/default" !in body)
    check("ord_123" !in body)
    check("cart=123" !in body)
    check("#pay" !in body)
    check("traceparent" !in body)
}

private fun okHttpInterceptorReportsCaptureFailure() {
    var capturedFailure: Throwable? = null
    val chain =
        FakeChain(
            Request.Builder().url("https://mobile.example.test/api/ignored").build(),
            code = 204,
        )
    val interceptor =
        LogBrewOkHttpInterceptor(
            client = newClient(),
            eventIdProvider = LogBrewOkHttpEventIdProvider { "evt_okhttp_request_003" },
            timestampProvider = LogBrewOkHttpTimestampProvider { "not-a-timestamp" },
            captureFailureHandler = LogBrewOkHttpCaptureFailureHandler { capturedFailure = it },
        )

    val response = interceptor.intercept(chain)
    check(response.code == 204)
    check(capturedFailure is SdkException)
}

private fun okHttpCallbackWrapperReactivatesTrace() {
    val parent =
        LogBrewTrace.continueOrCreate(
            "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
        )
    val request = Request.Builder().url("https://mobile.example.test/api/async").build()
    val call = FakeCall(request)
    var responseTraceSpanId: String? = null
    var failureTraceSpanId: String? = null
    val callback =
        object : Callback {
            override fun onFailure(
                call: Call,
                e: IOException,
            ) {
                failureTraceSpanId = LogBrewTrace.currentTraceContext()?.spanId
            }

            override fun onResponse(
                call: Call,
                response: Response,
            ) {
                responseTraceSpanId = LogBrewTrace.currentTraceContext()?.spanId
            }
        }

    val wrapped =
        LogBrewTrace.use(parent).use {
            LogBrewOkHttpCallbacks.wrap(callback)
        }
    check(LogBrewTrace.currentTraceContext() == null)

    wrapped.onResponse(call, fakeResponse(request, 202))
    check(responseTraceSpanId == parent.spanId)
    check(LogBrewTrace.currentTraceContext() == null)

    wrapped.onFailure(call, IOException("async network failure"))
    check(failureTraceSpanId == parent.spanId)
    check(LogBrewTrace.currentTraceContext() == null)

    val callbackFailure = IOException("callback failed")
    val throwingCallback =
        object : Callback {
            override fun onFailure(
                call: Call,
                e: IOException,
            ) = Unit

            override fun onResponse(
                call: Call,
                response: Response,
            ) {
                check(LogBrewTrace.currentTraceContext()?.spanId == parent.spanId)
                throw callbackFailure
            }
        }
    val throwingWrapped =
        LogBrewTrace.use(parent).use {
            LogBrewOkHttpCallbacks.wrap(throwingCallback)
        }
    try {
        throwingWrapped.onResponse(call, fakeResponse(request, 204))
        error("expected callback IOException")
    } catch (error: IOException) {
        check(error === callbackFailure)
    }
    check(LogBrewTrace.currentTraceContext() == null)
}

private fun okHttpCallFactoryCarriesTrace() {
    val parent =
        LogBrewTrace.continueOrCreate(
            "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
        )
    val request = Request.Builder().url("https://mobile.example.test/api/async?debug=1").build()
    var delegatedRequest: Request? = null
    var callbackTraceSpanId: String? = null
    val callFactory =
        LogBrewTrace.use(parent).use {
            LogBrewOkHttpCallFactory(
                Call.Factory { delegated ->
                    delegatedRequest = delegated
                    FakeCall(delegated)
                },
            ).newCall(request)
        }

    check(LogBrewTrace.currentTraceContext() == null)
    callFactory.enqueue(
        object : Callback {
            override fun onFailure(
                call: Call,
                e: IOException,
            ) = Unit

            override fun onResponse(
                call: Call,
                response: Response,
            ) {
                callbackTraceSpanId = LogBrewTrace.currentTraceContext()?.spanId
            }
        },
    )
    check(callbackTraceSpanId == parent.spanId)
    val taggedRequest = delegatedRequest ?: error("expected delegated request")
    check(taggedRequest.tag(LogBrewTraceContext::class.java)?.spanId == parent.spanId)
    check(LogBrewTrace.currentTraceContext() == null)

    val client = newClient()
    val chain =
        FakeChain(
            taggedRequest,
            code = 202,
        ) {
            val active = LogBrewTrace.currentTraceContext() ?: error("expected active child trace")
            check(active.traceId == parent.traceId)
            check(active.parentSpanId == parent.spanId)
        }
    val interceptor =
        LogBrewOkHttpInterceptor(
            client = client,
            eventIdProvider = LogBrewOkHttpEventIdProvider { "evt_okhttp_request_004" },
            timestampProvider = LogBrewOkHttpTimestampProvider { "2026-06-02T10:00:36Z" },
        )

    check(interceptor.intercept(chain).code == 202)
    val body = client.previewJson()
    check("\"id\": \"evt_okhttp_request_004\"" in body)
    check("\"traceId\": \"${parent.traceId}\"" in body)
    check("\"parentSpanId\": \"${parent.spanId}\"" in body)
    check("debug=1" !in body)
}

private fun okHttpCallFactoryPreservesRouteTemplateTag() {
    val parent =
        LogBrewTrace.continueOrCreate(
            "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
        )
    val request =
        LogBrewOkHttpRouteTemplates.tag(
            Request.Builder().url("https://mobile.example.test/api/users/user_123").build(),
            "/api/users/{user_id}",
        )
    var delegatedRequest: Request? = null
    val call =
        LogBrewTrace.use(parent).use {
            LogBrewOkHttpCallFactory(
                Call.Factory { delegated ->
                    delegatedRequest = delegated
                    FakeCall(delegated)
                },
            ).newCall(request)
        }
    check(call.execute().code == 200)

    val routeTemplate =
        LogBrewOkHttpRouteTemplates.get(delegatedRequest ?: error("expected delegated request"))
    check(routeTemplate == "/api/users/{user_id}")
    check(
        delegatedRequest
            .tag(LogBrewTraceContext::class.java)
            ?.spanId == parent.spanId,
    )
}

private fun newClient(): LogBrewClient =
    LogBrewClient.create(
        apiKey = "LOGBREW_API_KEY",
        sdkName = "logbrew-kotlin-okhttp-tests",
        sdkVersion = "0.1.0",
    )

private class FakeChain(
    private val initialRequest: Request,
    private val code: Int = 200,
    private val failure: IOException? = null,
    private val assertion: (Request) -> Unit = {},
) : Interceptor.Chain {
    var proceededRequest: Request? = null

    override fun request(): Request = initialRequest

    override fun proceed(request: Request): Response {
        proceededRequest = request
        assertion(request)
        failure?.let { throw it }
        return Response
            .Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message("OK")
            .build()
    }

    override fun connection(): Connection? = null

    override fun call(): Call =
        object : Call {
            override fun request(): Request = initialRequest

            override fun execute(): Response = proceed(initialRequest)

            override fun enqueue(responseCallback: okhttp3.Callback) = Unit

            override fun cancel() = Unit

            override fun isExecuted(): Boolean = false

            override fun isCanceled(): Boolean = false

            override fun clone(): Call = this

            override fun timeout(): Timeout = Timeout.NONE
        }

    override fun connectTimeoutMillis(): Int = 0

    override fun withConnectTimeout(
        timeout: Int,
        unit: TimeUnit,
    ): Interceptor.Chain = this

    override fun readTimeoutMillis(): Int = 0

    override fun withReadTimeout(
        timeout: Int,
        unit: TimeUnit,
    ): Interceptor.Chain = this

    override fun writeTimeoutMillis(): Int = 0

    override fun withWriteTimeout(
        timeout: Int,
        unit: TimeUnit,
    ): Interceptor.Chain = this
}

private class FakeCall(
    private val request: Request,
) : Call {
    override fun request(): Request = request

    override fun execute(): Response = fakeResponse(request, 200)

    override fun enqueue(responseCallback: Callback) {
        responseCallback.onResponse(this, fakeResponse(request, 200))
    }

    override fun cancel() = Unit

    override fun isExecuted(): Boolean = false

    override fun isCanceled(): Boolean = false

    override fun clone(): Call = FakeCall(request)

    override fun timeout(): Timeout = Timeout.NONE
}

private fun fakeResponse(
    request: Request,
    code: Int,
): Response =
    Response
        .Builder()
        .request(request)
        .protocol(Protocol.HTTP_1_1)
        .code(code)
        .message("OK")
        .build()
