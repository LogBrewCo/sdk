package co.logbrew.sdk;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.List;
import java.util.Objects;
import java.util.Optional;

/**
 * Scripted transport for previewing, accepting, or failing queued event flushes.
 */
public final class RecordingTransport implements Transport {
    private final Deque<Object> scriptedResponses;
    private final List<String> sentBodies;

    /**
     * Creates a transport that accepts queued flushes with a 202 response.
     */
    public RecordingTransport() {
        this(Collections.singletonList(Integer.valueOf(202)));
    }

    /**
     * Creates a scripted transport from public status codes or transport failures.
     */
    public RecordingTransport(List<?> scriptedResponses) {
        this.scriptedResponses = new ArrayDeque<>();
        if (scriptedResponses == null || scriptedResponses.isEmpty()) {
            this.scriptedResponses.add(Integer.valueOf(202));
        } else {
            this.scriptedResponses.addAll(scriptedResponses);
        }
        this.sentBodies = new ArrayList<>();
    }

    /**
     * Creates a transport that accepts every queued flush request.
     */
    public static RecordingTransport alwaysAccept() {
        return new RecordingTransport();
    }

    /**
     * Creates a scripted transport from status codes or transport failures.
     */
    public static RecordingTransport scripted(Object... scriptedResponses) {
        List<Object> responses = new ArrayList<>();
        Collections.addAll(responses, scriptedResponses);
        return new RecordingTransport(responses);
    }

    /**
     * Returns every request body sent through this transport instance.
     */
    public List<String> sentBodies() {
        return Collections.unmodifiableList(new ArrayList<>(sentBodies));
    }

    /**
     * Returns the most recent request body sent through this transport.
     */
    public Optional<String> lastBody() {
        if (sentBodies.isEmpty()) {
            return Optional.empty();
        }
        return Optional.of(sentBodies.get(sentBodies.size() - 1));
    }

    @Override
    public TransportResponse send(String apiKey, String body) throws TransportException {
        Validation.requireNonEmpty("api_key", apiKey);
        sentBodies.add(Objects.requireNonNull(body, "body"));

        Object next = scriptedResponses.isEmpty() ? Integer.valueOf(202) : scriptedResponses.removeFirst();
        if (next instanceof Integer) {
            return new TransportResponse(((Integer) next).intValue(), 1);
        }
        if (next instanceof TransportResponse) {
            TransportResponse response = (TransportResponse) next;
            return new TransportResponse(response.statusCode(), 1);
        }
        if (next instanceof TransportException) {
            throw (TransportException) next;
        }
        if (next instanceof SdkException) {
            throw (SdkException) next;
        }
        throw new SdkException("transport_error", "invalid scripted transport response");
    }
}
