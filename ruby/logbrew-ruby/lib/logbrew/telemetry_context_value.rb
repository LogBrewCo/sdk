# frozen_string_literal: true

module LogBrew
  # Shared validation and detachment rules for schema-v1 telemetry context.
  module TelemetryContextValue
    MAX_CONTEXT_STRING = 256
    MAX_CONTEXT_ID = 200
    MAX_TAGS = 32
    MAX_TAG_KEY = 64
    TAG_KEY = /\A[A-Za-z][A-Za-z0-9_.-]*\z/.freeze
    CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/.freeze
    LOWER_HEX = /\A[0-9a-f]+\z/.freeze

    module_function

    def object(value, label)
      raise invalid("#{label} must be an object") unless value.is_a?(Hash)

      value.each_with_object({}) do |(key, item), normalized|
        unless key.is_a?(String) || key.is_a?(Symbol)
          raise invalid("#{label} keys must be strings")
        end

        normalized_key = key.to_s
        if normalized.key?(normalized_key)
          raise invalid("#{label} contains duplicate field #{normalized_key}")
        end
        normalized[normalized_key] = item
      end
    end

    def reject_unknown_fields(value, allowed, label)
      unknown = value.keys - allowed
      return if unknown.empty?

      raise invalid("#{label} has unknown field #{unknown.sort.first}")
    end

    def required_string(value, label, maximum = MAX_CONTEXT_STRING)
      raise invalid("#{label} must be a string") unless value.is_a?(String)

      normalized = utf8_string(value, label).strip
      raise invalid("#{label} must not be empty") if normalized.empty? || !normalized.match?(/\S/)
      if normalized.length > maximum
        raise invalid("#{label} must contain at most #{maximum} characters")
      end
      if normalized.match?(CONTROL_CHARACTERS)
        raise invalid("#{label} must not contain control characters")
      end

      normalized
    end

    def optional_string(value, label, maximum = MAX_CONTEXT_STRING)
      return nil if value.nil?

      required_string(value, label, maximum)
    end

    def required_id(value, label)
      required_string(value, label, MAX_CONTEXT_ID)
    end

    def optional_id(value, label)
      return nil if value.nil?

      required_id(value, label)
    end

    def trace_id(value, label = "traceId")
      normalized_hex_id(value, 32, "0" * 32, label)
    end

    def span_id(value, label)
      normalized_hex_id(value, 16, "0" * 16, label)
    end

    def optional_span_id(value, label)
      return nil if value.nil?

      span_id(value, label)
    end

    def tag_key(value)
      raise invalid("tag key must be a string") unless value.is_a?(String)

      normalized = utf8_string(value, "tag key")
      unless normalized.length <= MAX_TAG_KEY && normalized.match?(TAG_KEY)
        raise invalid("tag key #{normalized} must start with a letter and contain only letters, numbers, _, ., or -")
      end

      normalized
    end

    def require_tag_count(count)
      unless count.between?(1, MAX_TAGS)
        raise invalid("telemetry context must contain 1 to at most #{MAX_TAGS} tags")
      end
    end

    def deep_copy(value)
      case value
      when Hash
        value.each_with_object({}) { |(key, item), copy| copy[key.dup] = deep_copy(item) }
      when Array
        value.map { |item| deep_copy(item) }
      when String
        value.dup
      else
        value
      end
    end

    def deep_freeze(value)
      case value
      when Hash
        value.each do |key, item|
          key.freeze
          deep_freeze(item)
        end
      when Array
        value.each { |item| deep_freeze(item) }
      end
      value.freeze
    end

    def invalid(message)
      SdkError.new("validation_error", message)
    end

    def normalized_hex_id(value, width, all_zero, label)
      raise invalid("#{label} must be #{width} non-zero hex characters") unless value.is_a?(String)

      normalized = utf8_string(value, label).downcase
      unless normalized.length == width && normalized.match?(LOWER_HEX) && normalized != all_zero
        raise invalid("#{label} must be #{width} non-zero hex characters")
      end
      normalized
    end
    private_class_method :normalized_hex_id

    def utf8_string(value, label)
      normalized = value.encode(Encoding::UTF_8)
      raise EncodingError unless normalized.valid_encoding?

      normalized.dup
    rescue EncodingError
      raise invalid("#{label} must be valid UTF-8")
    end
    private_class_method :utf8_string
  end
end
