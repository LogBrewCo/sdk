# frozen_string_literal: true

module LogBrew
  TraceparentContext = Struct.new(:version, :trace_id, :parent_span_id, :trace_flags, :sampled, keyword_init: true)
  TraceparentSpanInput = Struct.new(:name, :span_id, :status, :duration_ms, :metadata, keyword_init: true) do
    def initialize(name:, span_id:, status: "ok", duration_ms: nil, metadata: nil)
      super(
        name: name,
        span_id: span_id,
        status: status,
        duration_ms: duration_ms,
        metadata: metadata
      )
    end
  end

  # Dependency-free W3C traceparent helpers for explicit app-owned propagation.
  module Traceparent
    VERSION = "00"
    private_constant :VERSION

    module_function

    def parse(traceparent)
      Validation.require_non_empty("traceparent", traceparent)
      parts = traceparent.to_s.strip.downcase.split("-")
      raise SdkError.new("validation_error", "traceparent must have four fields") unless parts.length == 4

      version, trace_id, parent_span_id, trace_flags = parts
      require_version(version)
      require_trace_id(trace_id)
      require_span_id("traceparent parent span id", parent_span_id)
      flags = normalize_trace_flags(trace_flags)

      TraceparentContext.new(
        version: version,
        trace_id: trace_id,
        parent_span_id: parent_span_id,
        trace_flags: flags,
        sampled: (flags.to_i(16) & 1) == 1
      )
    end

    def create(trace_id:, span_id:, trace_flags: "01")
      normalized_trace_id = normalize_trace_id(trace_id)
      normalized_span_id = normalize_span_id("traceparent span id", span_id)
      flags = normalize_trace_flags(trace_flags)

      "#{VERSION}-#{normalized_trace_id}-#{normalized_span_id}-#{flags}"
    end

    def create_headers(trace_id:, span_id:, trace_flags: "01")
      { "traceparent" => create(trace_id: trace_id, span_id: span_id, trace_flags: trace_flags) }
    end

    def span_attributes_from_traceparent(traceparent, input)
      context = traceparent.is_a?(TraceparentContext) ? traceparent : parse(traceparent)
      attributes = {
        "name" => required_name(input.name),
        "traceId" => context.trace_id,
        "spanId" => normalize_span_id("span spanId", input.span_id),
        "parentSpanId" => context.parent_span_id,
        "status" => normalize_status(input.status)
      }

      unless input.duration_ms.nil?
        duration_ms = Validation.require_finite_number("span durationMs", input.duration_ms)
        raise SdkError.new("validation_error", "span durationMs must be non-negative") if duration_ms.negative?

        attributes["durationMs"] = duration_ms
      end

      metadata = Validation.require_metadata(input.metadata)
      attributes["metadata"] = metadata unless metadata.nil?
      attributes
    end

    def require_version(version)
      unless version.length == 2 && lower_hex?(version) && version != "ff"
        raise SdkError.new("validation_error", "traceparent version must be two hex characters and not ff")
      end
    end
    private_class_method :require_version

    def normalize_trace_id(trace_id)
      normalized = trace_id.to_s.strip.downcase
      require_trace_id(normalized)
      normalized
    end
    private_class_method :normalize_trace_id

    def require_trace_id(trace_id)
      unless trace_id.length == 32 && lower_hex?(trace_id) && !all_zero?(trace_id)
        raise SdkError.new("validation_error", "traceparent trace id must be 32 non-zero hex characters")
      end
    end
    private_class_method :require_trace_id

    def normalize_span_id(label, span_id)
      normalized = span_id.to_s.strip.downcase
      require_span_id(label, normalized)
      normalized
    end
    private_class_method :normalize_span_id

    def require_span_id(label, span_id)
      unless span_id.length == 16 && lower_hex?(span_id) && !all_zero?(span_id)
        raise SdkError.new("validation_error", "#{label} must be 16 non-zero hex characters")
      end
    end
    private_class_method :require_span_id

    def normalize_trace_flags(trace_flags)
      normalized = trace_flags.to_s.strip.downcase
      unless normalized.length == 2 && lower_hex?(normalized)
        raise SdkError.new("validation_error", "traceparent flags must be two hex characters")
      end

      normalized
    end
    private_class_method :normalize_trace_flags

    def required_name(name)
      Validation.require_non_empty("span name", name)
      name.to_s.strip
    end
    private_class_method :required_name

    def normalize_status(status)
      Validation.require_allowed_value("span status", status, LogBrew::SPAN_STATUSES)
      status
    end
    private_class_method :normalize_status

    def lower_hex?(value)
      value.match?(/\A[0-9a-f]+\z/)
    end
    private_class_method :lower_hex?

    def all_zero?(value)
      value.delete("0").empty?
    end
    private_class_method :all_zero?
  end
end
