package co.logbrew.sdk

import java.lang.reflect.InvocationHandler
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Method
import java.lang.reflect.Proxy
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext

private const val KOTLINX_THREAD_CONTEXT_ELEMENT_CLASS = "kotlinx.coroutines.ThreadContextElement"

private val FUNCTION2_INVOKE: Method = Function2::class.java.getMethod("invoke", Any::class.java, Any::class.java)

object LogBrewCoroutines {
    @JvmStatic
    fun traceContextElement(context: LogBrewTraceContext): CoroutineContext.Element? {
        LogBrewTrace.validateContext(context)
        val threadContextElementClass = threadContextElementClass() ?: return null
        return Proxy
            .newProxyInstance(
                threadContextElementClass.classLoader,
                arrayOf(CoroutineContext.Element::class.java, threadContextElementClass),
                LogBrewCoroutineElementHandler(
                    LogBrewTraceCoroutineKey,
                    "LogBrewCoroutines.traceContextElement(${context.traceId}/${context.spanId})",
                ) { LogBrewTrace.use(context) },
            ) as CoroutineContext.Element
    }

    @JvmStatic
    fun currentTraceContextElement(): CoroutineContext.Element? = LogBrewTrace.currentTraceContext()?.let(::traceContextElement)

    /** Propagates one LogBrew telemetry context when kotlinx-coroutines is installed. */
    @JvmStatic
    fun telemetryContextElement(context: TelemetryContext): CoroutineContext.Element? {
        val normalized = context.normalized()
        val threadContextElementClass = threadContextElementClass() ?: return null
        return Proxy
            .newProxyInstance(
                threadContextElementClass.classLoader,
                arrayOf(CoroutineContext.Element::class.java, threadContextElementClass),
                LogBrewCoroutineElementHandler(
                    LogBrewTelemetryCoroutineKey,
                    "LogBrewCoroutines.telemetryContextElement(schemaVersion=${context.schemaVersion})",
                ) { LogBrewTelemetry.use(normalized) },
            ) as CoroutineContext.Element
    }

    /** Captures the currently active LogBrew telemetry context for coroutine propagation. */
    @JvmStatic
    fun currentTelemetryContextElement(): CoroutineContext.Element? = LogBrewTelemetry.currentContext()?.let(::telemetryContextElement)

    private fun threadContextElementClass(): Class<*>? =
        try {
            Class.forName(KOTLINX_THREAD_CONTEXT_ELEMENT_CLASS)
        } catch (_: ClassNotFoundException) {
            null
        }
}

private object LogBrewTraceCoroutineKey : CoroutineContext.Key<CoroutineContext.Element>

private object LogBrewTelemetryCoroutineKey : CoroutineContext.Key<CoroutineContext.Element>

private class LogBrewCoroutineElementHandler(
    private val key: CoroutineContext.Key<CoroutineContext.Element>,
    private val description: String,
    private val enter: () -> AutoCloseable,
) : InvocationHandler {
    override fun invoke(
        proxy: Any,
        method: Method,
        args: Array<out Any?>?,
    ): Any? {
        if (method.declaringClass == Any::class.java) {
            return invokeAnyMethod(proxy, method, args)
        }

        return when (method.name) {
            "getKey" -> {
                key
            }

            "updateThreadContext" -> {
                enter()
            }

            "restoreThreadContext" -> {
                (args?.getOrNull(1) as? AutoCloseable)?.close()
                Unit
            }

            "fold" -> {
                fold(proxy, args)
            }

            "get" -> {
                if (args?.firstOrNull() == key) proxy else null
            }

            "minusKey" -> {
                if (args?.firstOrNull() == key) EmptyCoroutineContext else proxy
            }

            "plus" -> {
                plus(proxy, args)
            }

            else -> {
                throw UnsupportedOperationException("Unsupported LogBrew coroutine context method: ${method.name}")
            }
        }
    }

    private fun invokeAnyMethod(
        proxy: Any,
        method: Method,
        args: Array<out Any?>?,
    ): Any =
        when (method.name) {
            "equals" -> proxy === args?.firstOrNull()
            "hashCode" -> System.identityHashCode(proxy)
            "toString" -> description
            else -> throw UnsupportedOperationException("Unsupported LogBrew coroutine object method: ${method.name}")
        }

    private fun fold(
        proxy: Any,
        args: Array<out Any?>?,
    ): Any? {
        val operation = args?.getOrNull(1) as? Function2<*, *, *> ?: return null
        // A star-projected function type cannot be called directly, so call it through the interface method.
        return try {
            FUNCTION2_INVOKE.invoke(operation, args.getOrNull(0), proxy)
        } catch (error: InvocationTargetException) {
            throw error.targetException
        }
    }

    private fun plus(
        proxy: Any,
        args: Array<out Any?>?,
    ): CoroutineContext {
        val contextToAdd = args?.firstOrNull() as? CoroutineContext ?: EmptyCoroutineContext
        if (contextToAdd[key] != null) {
            return contextToAdd
        }
        return contextToAdd + (proxy as CoroutineContext.Element)
    }
}
