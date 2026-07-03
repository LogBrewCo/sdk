package co.logbrew.sdk.okhttp

import co.logbrew.sdk.SdkException
import okhttp3.Request

/**
 * Request-local route template tags for low-cardinality OkHttp span names.
 *
 * Apps can tag each request with the route pattern they already know from
 * their API client, such as `/api/orders/{order_id}`. The interceptor
 * prefers this per-request value over its constructor default and still lets
 * the core Kotlin request-span helper strip query strings and fragments.
 */
object LogBrewOkHttpRouteTemplates {
    @JvmStatic
    fun tag(
        request: Request,
        routeTemplate: String,
    ): Request =
        tag(request.newBuilder(), routeTemplate)
            .build()

    @JvmStatic
    fun tag(
        builder: Request.Builder,
        routeTemplate: String,
    ): Request.Builder = builder.tag(LogBrewOkHttpRouteTemplate::class.java, LogBrewOkHttpRouteTemplate.create(routeTemplate))

    @JvmStatic
    fun get(request: Request): String? = request.tag(LogBrewOkHttpRouteTemplate::class.java)?.value
}

internal class LogBrewOkHttpRouteTemplate private constructor(
    val value: String,
) {
    companion object {
        fun create(routeTemplate: String): LogBrewOkHttpRouteTemplate {
            val normalized = routeTemplate.trim()
            if (normalized.isEmpty()) {
                throw SdkException("validation_error", "okhttp routeTemplate must not be empty")
            }
            return LogBrewOkHttpRouteTemplate(normalized)
        }
    }
}
