package co.logbrew.sdk;

/**
 * Public transport interface used by flush and shutdown operations.
 */
@FunctionalInterface
public interface Transport {
    /**
     * Sends a serialized batch body for the configured API key.
     */
    TransportResponse send(String apiKey, String body) throws TransportException;
}
