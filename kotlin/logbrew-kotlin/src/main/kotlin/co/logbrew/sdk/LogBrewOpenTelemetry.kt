package co.logbrew.sdk

private const val OTEL_SPAN_CLASS = "io.opentelemetry.api.trace.Span"
private const val OTEL_SPAN_CONTEXT_CLASS = "io.opentelemetry.api.trace.SpanContext"
private const val OTEL_TRACE_FLAGS_CLASS = "io.opentelemetry.api.trace.TraceFlags"
private const val OTEL_CONTEXT_CLASS = "io.opentelemetry.context.Context"

object LogBrewOpenTelemetry {
    @JvmStatic
    fun spanContextFromCurrentSpan(): LogBrewOpenTelemetrySpanContext? {
        val span = invokeStaticNoArg(OTEL_SPAN_CLASS, "current") ?: return null
        return spanContextFromSpan(span)
    }

    @JvmStatic
    fun traceContextFromCurrentSpan(): LogBrewTraceContext? = spanContextFromCurrentSpan()?.let(LogBrewTrace::fromOpenTelemetrySpanContext)

    @JvmStatic
    fun spanContextFromSpan(span: Any?): LogBrewOpenTelemetrySpanContext? {
        val otelSpan = instanceOf(OTEL_SPAN_CLASS, span) ?: return null
        val spanContext = invokeNoArg(otelSpan, OTEL_SPAN_CLASS, "getSpanContext") ?: return null
        return spanContextFromRawSpanContext(spanContext)
    }

    @JvmStatic
    fun traceContextFromSpan(span: Any?): LogBrewTraceContext? = spanContextFromSpan(span)?.let(LogBrewTrace::fromOpenTelemetrySpanContext)

    @JvmStatic
    fun spanContextFromContext(context: Any?): LogBrewOpenTelemetrySpanContext? {
        val span = spanFromContext(context) ?: return null
        return spanContextFromSpan(span)
    }

    @JvmStatic
    fun traceContextFromContext(context: Any?): LogBrewTraceContext? =
        spanContextFromContext(context)?.let(LogBrewTrace::fromOpenTelemetrySpanContext)

    private fun spanContextFromRawSpanContext(spanContext: Any): LogBrewOpenTelemetrySpanContext? {
        val otelSpanContext = instanceOf(OTEL_SPAN_CONTEXT_CLASS, spanContext) ?: return null
        val valid = invokeNoArg(otelSpanContext, OTEL_SPAN_CONTEXT_CLASS, "isValid") as? Boolean ?: return null
        if (!valid) {
            return null
        }
        val traceId = invokeNoArg(otelSpanContext, OTEL_SPAN_CONTEXT_CLASS, "getTraceId") as? String ?: return null
        val spanId = invokeNoArg(otelSpanContext, OTEL_SPAN_CONTEXT_CLASS, "getSpanId") as? String ?: return null
        val traceFlags = traceFlagsHex(invokeNoArg(otelSpanContext, OTEL_SPAN_CONTEXT_CLASS, "getTraceFlags")) ?: return null
        return LogBrewOpenTelemetrySpanContext.create(traceId, spanId, traceFlags)
    }

    private fun spanFromContext(context: Any?): Any? {
        if (context == null) {
            return null
        }
        val contextClass =
            runCatching {
                Class.forName(OTEL_CONTEXT_CLASS)
            }.getOrNull() ?: return null
        if (!contextClass.isInstance(context)) {
            return null
        }
        return runCatching {
            Class
                .forName(OTEL_SPAN_CLASS)
                .getMethod("fromContext", contextClass)
                .invoke(null, context)
        }.getOrNull()
    }

    private fun traceFlagsHex(traceFlags: Any?): String? {
        val otelTraceFlags = instanceOf(OTEL_TRACE_FLAGS_CLASS, traceFlags) ?: return null
        val explicit = invokeNoArg(otelTraceFlags, OTEL_TRACE_FLAGS_CLASS, "asHex") as? String
        if (explicit != null) {
            return explicit
        }
        val sampled = invokeNoArg(otelTraceFlags, OTEL_TRACE_FLAGS_CLASS, "isSampled") as? Boolean ?: return null
        return if (sampled) "01" else "00"
    }

    private fun instanceOf(
        className: String,
        value: Any?,
    ): Any? {
        if (value == null) {
            return null
        }
        return runCatching {
            val targetClass = Class.forName(className)
            if (targetClass.isInstance(value)) value else null
        }.getOrNull()
    }

    private fun invokeStaticNoArg(
        className: String,
        methodName: String,
    ): Any? =
        runCatching {
            Class.forName(className).getMethod(methodName).invoke(null)
        }.getOrNull()

    private fun invokeNoArg(
        target: Any,
        className: String,
        methodName: String,
    ): Any? =
        runCatching {
            Class.forName(className).getMethod(methodName).invoke(target)
        }.getOrNull()
}
