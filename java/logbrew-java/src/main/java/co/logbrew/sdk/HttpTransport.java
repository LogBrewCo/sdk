package co.logbrew.sdk;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;

/**
 * Dependency-free HTTP transport backed by Java 11's {@link HttpClient}.
 */
public final class HttpTransport implements Transport {
    /**
     * Production LogBrew event intake endpoint used when no endpoint is supplied.
     */
    public static final URI DEFAULT_ENDPOINT = URI.create("https://api.logbrew.co/v1/events");

    private static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(10);
    private static final HttpClient DEFAULT_CLIENT = HttpClient.newBuilder()
        .connectTimeout(DEFAULT_TIMEOUT)
        .build();

    private final URI endpoint;
    private final Map<String, String> headers;
    private final HttpClient client;
    private final Duration requestTimeout;

    /**
     * Creates a transport using the production endpoint and safe default timeout.
     */
    public HttpTransport() {
        this(builder());
    }

    /**
     * Creates a transport for a custom endpoint.
     */
    public HttpTransport(URI endpoint) {
        this(builder().endpoint(endpoint));
    }

    /**
     * Creates a transport for a custom endpoint and extra request headers.
     */
    public HttpTransport(URI endpoint, Map<String, String> headers) {
        this(builder().endpoint(endpoint).headers(headers));
    }

    /**
     * Creates a transport for a custom endpoint, headers, and HTTP client.
     */
    public HttpTransport(URI endpoint, Map<String, String> headers, HttpClient client) {
        this(builder().endpoint(endpoint).headers(headers).client(client));
    }

    private HttpTransport(Builder builder) {
        this.endpoint = validateEndpoint(builder.endpoint);
        this.headers = Collections.unmodifiableMap(copyHeaders(builder.headers));
        this.requestTimeout = validateTimeout(builder.requestTimeout);
        this.client = builder.client == null
            ? defaultClient(this.requestTimeout)
            : builder.client;
    }

    /**
     * Creates a builder for custom endpoint, header, client, and timeout settings.
     */
    public static Builder builder() {
        return new Builder();
    }

    /**
     * Returns the endpoint used for HTTP delivery.
     */
    public URI endpoint() {
        return endpoint;
    }

    /**
     * Returns extra headers copied onto every delivery request.
     */
    public Map<String, String> headers() {
        return headers;
    }

    /**
     * Returns the HTTP client used for delivery.
     */
    public HttpClient client() {
        return client;
    }

    /**
     * Returns the per-request timeout used for delivery.
     */
    public Duration requestTimeout() {
        return requestTimeout;
    }

    @Override
    public TransportResponse send(String apiKey, String body) throws TransportException {
        Validation.requireNonEmpty("api_key", apiKey);
        Objects.requireNonNull(body, "body");

        HttpRequest.Builder requestBuilder = HttpRequest.newBuilder(endpoint)
            .timeout(requestTimeout)
            .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
            .setHeader("content-type", "application/json")
            .setHeader("authorization", "Bearer " + apiKey);

        for (Map.Entry<String, String> header : headers.entrySet()) {
            requestBuilder.setHeader(header.getKey(), header.getValue());
        }

        try {
            HttpResponse<Void> response = client.send(requestBuilder.build(), HttpResponse.BodyHandlers.discarding());
            return new TransportResponse(response.statusCode(), 1);
        } catch (IOException error) {
            throw TransportException.network("http transport failed: " + error.getMessage());
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw TransportException.network("http transport interrupted");
        } catch (IllegalArgumentException error) {
            throw new SdkException("configuration_error", "invalid HTTP transport request: " + error.getMessage());
        }
    }

    private static URI validateEndpoint(URI endpoint) {
        URI resolved = endpoint == null ? DEFAULT_ENDPOINT : endpoint;
        String scheme = resolved.getScheme();
        if (scheme == null) {
            throw new SdkException("configuration_error", "HTTP transport endpoint must include a scheme");
        }
        String normalizedScheme = scheme.toLowerCase(Locale.ROOT);
        if (!"http".equals(normalizedScheme) && !"https".equals(normalizedScheme)) {
            throw new SdkException("configuration_error", "HTTP transport endpoint must use http or https");
        }
        if (resolved.getRawAuthority() == null || resolved.getRawAuthority().trim().isEmpty()) {
            throw new SdkException("configuration_error", "HTTP transport endpoint must include an authority");
        }
        return resolved;
    }

    private static Duration validateTimeout(Duration timeout) {
        Duration resolved = timeout == null ? DEFAULT_TIMEOUT : timeout;
        if (resolved.isZero() || resolved.isNegative()) {
            throw new SdkException("configuration_error", "HTTP transport timeout must be positive");
        }
        return resolved;
    }

    private static HttpClient defaultClient(Duration timeout) {
        if (DEFAULT_TIMEOUT.equals(timeout)) {
            return DEFAULT_CLIENT;
        }
        return HttpClient.newBuilder().connectTimeout(timeout).build();
    }

    private static Map<String, String> copyHeaders(Map<String, String> headers) {
        if (headers == null || headers.isEmpty()) {
            return Collections.emptyMap();
        }
        Map<String, String> copied = new LinkedHashMap<>();
        for (Map.Entry<String, String> header : headers.entrySet()) {
            String name = header.getKey();
            if (name == null) {
                throw new SdkException("configuration_error", "HTTP transport header name must be non-empty");
            }
            if (name.trim().isEmpty()) {
                throw new SdkException("configuration_error", "HTTP transport header name must be non-empty");
            }
            if (header.getValue() == null) {
                throw new SdkException("configuration_error", "HTTP transport header value must be non-null");
            }
            copied.put(name, header.getValue());
        }
        return copied;
    }

    /**
     * Builder for {@link HttpTransport}.
     */
    public static final class Builder {
        private URI endpoint = DEFAULT_ENDPOINT;
        private final Map<String, String> headers = new LinkedHashMap<>();
        private HttpClient client;
        private Duration requestTimeout = DEFAULT_TIMEOUT;

        private Builder() {
        }

        /**
         * Sets the delivery endpoint.
         */
        public Builder endpoint(URI endpoint) {
            this.endpoint = endpoint == null ? DEFAULT_ENDPOINT : endpoint;
            return this;
        }

        /**
         * Adds one extra request header.
         */
        public Builder header(String name, String value) {
            Map<String, String> oneHeader = new LinkedHashMap<>();
            oneHeader.put(name, value);
            this.headers.putAll(copyHeaders(oneHeader));
            return this;
        }

        /**
         * Adds extra request headers.
         */
        public Builder headers(Map<String, String> headers) {
            this.headers.putAll(copyHeaders(headers));
            return this;
        }

        /**
         * Sets the HTTP client used for delivery.
         */
        public Builder client(HttpClient client) {
            this.client = client;
            return this;
        }

        /**
         * Sets the per-request timeout used for delivery.
         */
        public Builder timeout(Duration requestTimeout) {
            this.requestTimeout = requestTimeout;
            return this;
        }

        /**
         * Builds the configured HTTP transport.
         */
        public HttpTransport build() {
            return new HttpTransport(this);
        }
    }
}
