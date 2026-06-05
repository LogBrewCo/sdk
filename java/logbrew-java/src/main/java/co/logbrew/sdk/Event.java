package co.logbrew.sdk;

import java.util.LinkedHashMap;
import java.util.Map;

final class Event {
    private final String type;
    private final String timestamp;
    private final String id;
    private final Map<String, Object> attributes;

    Event(String type, String timestamp, String id, Map<String, Object> attributes) {
        this.type = type;
        this.timestamp = timestamp;
        this.id = id;
        this.attributes = attributes;
    }

    Map<String, Object> toMap() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("type", type);
        value.put("timestamp", timestamp);
        value.put("id", id);
        value.put("attributes", attributes);
        return value;
    }
}
