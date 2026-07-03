package co.logbrew.sdk.okhttp

import okhttp3.Call
import okhttp3.EventListener
import okhttp3.Handshake
import okhttp3.HttpUrl
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.util.Collections
import java.util.WeakHashMap

object LogBrewOkHttpPhaseTimings {
    private val calls = Collections.synchronizedMap(WeakHashMap<Call, PhaseTimings>())

    @JvmStatic
    @JvmOverloads
    fun eventListenerFactory(delegate: EventListener.Factory? = null): EventListener.Factory =
        EventListener.Factory { call ->
            TrackingEventListener(call, delegate?.create(call))
        }

    internal fun snapshot(call: Call): Map<String, Any?> = calls[call]?.snapshot() ?: emptyMap()

    private class TrackingEventListener(
        private val call: Call,
        private val delegate: EventListener?,
    ) : EventListener() {
        private val timings = PhaseTimings()

        override fun callStart(call: Call) {
            delegate?.callStart(call)
            calls[this.call] = timings
        }

        override fun dnsStart(
            call: Call,
            domainName: String,
        ) {
            delegate?.dnsStart(call, domainName)
            timings.start(DNS)
        }

        override fun dnsEnd(
            call: Call,
            domainName: String,
            inetAddressList: List<InetAddress>,
        ) {
            delegate?.dnsEnd(call, domainName, inetAddressList)
            timings.finish(DNS)
        }

        override fun connectStart(
            call: Call,
            inetSocketAddress: InetSocketAddress,
            proxy: Proxy,
        ) {
            delegate?.connectStart(call, inetSocketAddress, proxy)
            timings.start(CONNECT)
        }

        override fun secureConnectStart(call: Call) {
            delegate?.secureConnectStart(call)
            timings.start(SECURE_CONNECT)
        }

        override fun secureConnectEnd(
            call: Call,
            handshake: Handshake?,
        ) {
            delegate?.secureConnectEnd(call, handshake)
            timings.finish(SECURE_CONNECT)
        }

        override fun connectEnd(
            call: Call,
            inetSocketAddress: InetSocketAddress,
            proxy: Proxy,
            protocol: Protocol?,
        ) {
            delegate?.connectEnd(call, inetSocketAddress, proxy, protocol)
            timings.finish(CONNECT)
        }

        override fun connectFailed(
            call: Call,
            inetSocketAddress: InetSocketAddress,
            proxy: Proxy,
            protocol: Protocol?,
            ioe: IOException,
        ) {
            delegate?.connectFailed(call, inetSocketAddress, proxy, protocol, ioe)
            timings.finish(CONNECT)
        }

        override fun requestHeadersStart(call: Call) {
            delegate?.requestHeadersStart(call)
            timings.start(REQUEST_HEADERS)
        }

        override fun requestHeadersEnd(
            call: Call,
            request: Request,
        ) {
            delegate?.requestHeadersEnd(call, request)
            timings.finish(REQUEST_HEADERS)
        }

        override fun requestBodyStart(call: Call) {
            delegate?.requestBodyStart(call)
            timings.start(REQUEST_BODY)
        }

        override fun requestBodyEnd(
            call: Call,
            byteCount: Long,
        ) {
            delegate?.requestBodyEnd(call, byteCount)
            timings.finish(REQUEST_BODY)
        }

        override fun requestFailed(
            call: Call,
            ioe: IOException,
        ) {
            delegate?.requestFailed(call, ioe)
            timings.finish(REQUEST_HEADERS)
            timings.finish(REQUEST_BODY)
        }

        override fun responseHeadersStart(call: Call) {
            delegate?.responseHeadersStart(call)
            timings.start(RESPONSE_HEADERS)
        }

        override fun responseHeadersEnd(
            call: Call,
            response: Response,
        ) {
            delegate?.responseHeadersEnd(call, response)
            timings.finish(RESPONSE_HEADERS)
        }

        override fun responseBodyStart(call: Call) {
            delegate?.responseBodyStart(call)
            timings.start(RESPONSE_BODY)
        }

        override fun responseBodyEnd(
            call: Call,
            byteCount: Long,
        ) {
            delegate?.responseBodyEnd(call, byteCount)
            timings.finish(RESPONSE_BODY)
        }

        override fun responseFailed(
            call: Call,
            ioe: IOException,
        ) {
            delegate?.responseFailed(call, ioe)
            timings.finish(RESPONSE_HEADERS)
            timings.finish(RESPONSE_BODY)
        }

        override fun callEnd(call: Call) {
            delegate?.callEnd(call)
            timings.recorded = true
        }

        override fun callFailed(
            call: Call,
            ioe: IOException,
        ) {
            delegate?.callFailed(call, ioe)
            timings.recorded = true
        }

        override fun proxySelectStart(
            call: Call,
            url: HttpUrl,
        ) {
            delegate?.proxySelectStart(call, url)
        }

        override fun proxySelectEnd(
            call: Call,
            url: HttpUrl,
            proxies: List<Proxy>,
        ) {
            delegate?.proxySelectEnd(call, url, proxies)
        }
    }

    private class PhaseTimings {
        private val startedAtNanos = linkedMapOf<String, Long>()
        private val durationsMs = linkedMapOf<String, Double>()
        var recorded: Boolean = false

        fun start(name: String) {
            startedAtNanos[name] = System.nanoTime()
        }

        fun finish(name: String) {
            val startedAt = startedAtNanos.remove(name) ?: return
            durationsMs[name] = ((System.nanoTime() - startedAt).coerceAtLeast(0L)).toDouble() / 1_000_000.0
            recorded = true
        }

        fun snapshot(): Map<String, Any?> {
            if (!recorded || durationsMs.isEmpty()) {
                return emptyMap()
            }
            val metadata = linkedMapOf<String, Any?>("okhttp.phase.recorded" to true)
            durationsMs.forEach { (name, durationMs) ->
                metadata["okhttp.phase.${name}Ms"] = durationMs
            }
            return metadata
        }
    }

    private const val DNS = "dns"
    private const val CONNECT = "connect"
    private const val SECURE_CONNECT = "secureConnect"
    private const val REQUEST_HEADERS = "requestHeaders"
    private const val REQUEST_BODY = "requestBody"
    private const val RESPONSE_HEADERS = "responseHeaders"
    private const val RESPONSE_BODY = "responseBody"
}
