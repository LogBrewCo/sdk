package co.logbrew.sdk

import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.util.Locale

internal class OrderedJsonObject {
    private val values = mutableListOf<Pair<String, Any?>>()

    fun add(
        key: String,
        value: Any?,
    ): OrderedJsonObject {
        values += key to value
        return this
    }

    fun addIfNotNull(
        key: String,
        value: Any?,
    ): OrderedJsonObject {
        if (value != null) {
            add(key, value)
        }
        return this
    }

    fun addMetadata(metadata: Map<String, Any?>): OrderedJsonObject {
        if (metadata.isNotEmpty()) {
            add("metadata", Validation.copyMetadata(metadata))
        }
        return this
    }

    fun entries(): List<Pair<String, Any?>> = values.toList()
}

internal object Validation {
    fun requireNonEmpty(
        label: String,
        value: String,
    ) {
        if (value.isBlank()) {
            throw SdkException("validation_error", "$label must be non-empty")
        }
    }

    fun requireTimestamp(value: String) {
        requireNonEmpty("event timestamp", value)
        if (!hasTimezoneOffset(value)) {
            throw SdkException("validation_error", "event timestamp must include a timezone offset: $value")
        }
        try {
            OffsetDateTime.parse(value, DateTimeFormatter.ISO_OFFSET_DATE_TIME)
        } catch (error: DateTimeParseException) {
            throw SdkException("validation_error", "event timestamp must be a valid ISO-8601 timestamp: $value")
        }
    }

    fun requireAllowedValue(
        label: String,
        value: String,
        allowed: Set<String>,
    ) {
        requireNonEmpty(label, value)
        if (value !in allowed) {
            throw SdkException("validation_error", "$label must be one of: ${allowed.sorted().joinToString(", ")}")
        }
    }

    fun normalizeSeverity(
        label: String,
        value: String,
    ): String {
        requireAllowedValue(label, value, LogBrewClient.severityValues)
        return when (value) {
            "trace", "debug", "info" -> "info"
            "warn", "warning" -> "warning"
            "error" -> "error"
            "fatal", "critical" -> "critical"
            else -> "info"
        }
    }

    fun requireFiniteNumber(
        label: String,
        value: Double,
    ) {
        if (value.isNaN() || value.isInfinite()) {
            throw SdkException("validation_error", "$label must be finite")
        }
    }

    fun requireMetadataValue(
        key: String,
        value: Any?,
    ): Any? {
        if (value == null || value is String || value is Boolean || value is Int || value is Long || value is Float || value is Double) {
            return value
        }
        throw SdkException("validation_error", "metadata value for $key must be a string, number, boolean, or null")
    }

    fun copyMetadata(metadata: Map<String, Any?>): OrderedJsonObject {
        val payload = OrderedJsonObject()
        metadata.forEach { (key, value) ->
            requireNonEmpty("metadata key", key)
            payload.add(key, requireMetadataValue(key, value))
        }
        return payload
    }

    private fun hasTimezoneOffset(value: String): Boolean {
        if (value.endsWith("Z")) {
            return true
        }
        val timePortion = value.split("T", limit = 2).getOrNull(1) ?: return false
        return "+" in timePortion || timePortion.lastIndexOf("-") > 0
    }
}

internal object JsonWriter {
    fun write(value: OrderedJsonObject): String =
        buildString {
            writeValue(value, indent = 0)
        }

    private fun StringBuilder.writeValue(
        value: Any?,
        indent: Int,
    ) {
        when (value) {
            null -> append("null")
            is String -> writeString(value)
            is Boolean -> append(if (value) "true" else "false")
            is Int -> append(value)
            is Long -> append(value)
            is Float -> append(value.toString())
            is Double -> append(value.toString())
            is OrderedJsonObject -> writeObject(value, indent)
            is List<*> -> writeArray(value, indent)
            else -> throw SdkException("validation_error", "unsupported JSON value")
        }
    }

    private fun StringBuilder.writeObject(
        value: OrderedJsonObject,
        indent: Int,
    ) {
        val entries = value.entries()
        append("{")
        if (entries.isEmpty()) {
            append("}")
            return
        }
        append("\n")
        entries.forEachIndexed { index, entry ->
            append(" ".repeat(indent + 2))
            writeString(entry.first)
            append(": ")
            writeValue(entry.second, indent + 2)
            if (index < entries.lastIndex) {
                append(",")
            }
            append("\n")
        }
        append(" ".repeat(indent))
        append("}")
    }

    private fun StringBuilder.writeArray(
        values: List<*>,
        indent: Int,
    ) {
        append("[")
        if (values.isEmpty()) {
            append("]")
            return
        }
        append("\n")
        values.forEachIndexed { index, item ->
            append(" ".repeat(indent + 2))
            writeValue(item, indent + 2)
            if (index < values.lastIndex) {
                append(",")
            }
            append("\n")
        }
        append(" ".repeat(indent))
        append("]")
    }

    private fun StringBuilder.writeString(value: String) {
        append('"')
        value.forEach { character ->
            when (character) {
                '"' -> {
                    append("\\\"")
                }

                '\\' -> {
                    append("\\\\")
                }

                '\b' -> {
                    append("\\b")
                }

                '\u000c' -> {
                    append("\\f")
                }

                '\n' -> {
                    append("\\n")
                }

                '\r' -> {
                    append("\\r")
                }

                '\t' -> {
                    append("\\t")
                }

                else -> {
                    if (character.isISOControl()) {
                        append("\\u")
                        append(
                            character.code
                                .toString(16)
                                .padStart(4, '0')
                                .lowercase(Locale.ROOT),
                        )
                    } else {
                        append(character)
                    }
                }
            }
        }
        append('"')
    }
}
