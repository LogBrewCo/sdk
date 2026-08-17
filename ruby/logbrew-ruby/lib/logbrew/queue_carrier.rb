# frozen_string_literal: true

module LogBrew
  # Bounded W3C carrier shared by explicit and framework-owned queue adapters.
  module QueueCarrier
    KEY = "logbrew".freeze
    VERSION = 1
    MAX_ENQUEUED_AT_MS = 9_007_199_254_740_991
    MAX_QUEUE_WAIT_MS = 604_800_000

    module_function

    def create(context, enqueued_at_ms: wall_time_ms)
      {
        "version" => VERSION,
        "traceparent" => Trace.create_headers(context).fetch("traceparent"),
        "enqueuedAtMs" => enqueued_at_ms
      }
    end

    def read(value)
      keys = %w[enqueuedAtMs traceparent version]
      return unless value.is_a?(Hash) && value.size == keys.length && keys.all? { |key| value.key?(key) }
      return unless value["version"] == VERSION
      return unless value["traceparent"].is_a?(String) && value["traceparent"].bytesize <= 55
      return unless value["enqueuedAtMs"].is_a?(Integer) && value["enqueuedAtMs"].between?(0, MAX_ENQUEUED_AT_MS)

      Traceparent.parse(value["traceparent"])
      value
    rescue SdkError
      nil
    end

    def child_context(carrier)
      parsed = carrier && Traceparent.parse(carrier.fetch("traceparent"))
      return Trace.create_root if parsed.nil?

      Trace.create(
        trace_id: parsed.trace_id,
        span_id: Trace.generate_span_id,
        parent_span_id: parsed.parent_span_id,
        trace_flags: parsed.trace_flags
      )
    end

    def queue_wait_ms(carrier)
      return if carrier.nil?

      [[wall_time_ms - carrier.fetch("enqueuedAtMs"), 0].max, MAX_QUEUE_WAIT_MS].min
    end

    def wall_time_ms
      (Time.now.to_f * 1000.0).floor
    end
  end
end
