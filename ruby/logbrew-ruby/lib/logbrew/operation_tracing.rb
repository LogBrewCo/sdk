# frozen_string_literal: true

module LogBrew
  # Explicit dependency spans for app-owned database, cache, and queue work.
  module OperationTracing
    UNSAFE_METADATA = /authorization|body|broker|cache.?key|command|connection|cookie|dsn|header|host|
      \bjid\z|job.?id|key|message|param|pass#{'word'}|payload|query|sec#{'ret'}|sql|statement|
      to#{'ken'}|url|username|value/ix
    private_constant :UNSAFE_METADATA

    module_function

    def database_operation(client, name, **options, &block)
      capture_operation(client, "database", name, options, &block)
    end

    def cache_operation(client, name, **options, &block)
      capture_operation(client, "cache", name, options, &block)
    end

    def queue_operation(client, name, **options, &block)
      capture_operation(client, "queue", name, options, &block)
    end

    def capture_operation(client, kind, name, options)
      raise SdkError.new("validation_error", "#{kind} operation block is required") unless block_given?

      Validation.require_non_empty("#{kind} operation name", name)
      started_at = monotonic_time
      context = child_context
      error = nil
      result = nil

      Trace.with_context(context) do
        begin
          result = yield context
        rescue StandardError => captured
          error = captured
        end
      end

      capture_span(client, kind, name, context, started_at, options, error)
      raise error if error

      result
    end

    def capture_span(client, kind, name, context, started_at, options, error)
      Trace.with_context(context) do
        client.span(
          event_id(kind, context, options),
          timestamp(options),
          {
            name: "#{kind}.operation:#{name}",
            traceId: context.trace_id,
            spanId: context.span_id,
            parentSpanId: context.parent_span_id,
            status: error ? "error" : "ok",
            durationMs: duration_ms(started_at, options),
            metadata: span_metadata(kind, options, error),
            events: span_events(error)
          }
        )
      end
    rescue StandardError => capture_error
      on_error = read_option(options, :on_error)
      begin
        on_error.call(capture_error) if on_error.respond_to?(:call)
      rescue StandardError
        nil
      end
    end

    def child_context
      parent = Trace.current
      return Trace.create_root unless parent

      Trace.create(
        trace_id: parent.trace_id,
        span_id: Trace.generate_span_id,
        parent_span_id: parent.span_id,
        trace_flags: parent.trace_flags
      )
    end

    def span_metadata(kind, options, error)
      sanitized_metadata(read_option(options, :metadata)).tap do |metadata|
        metadata["source"] = read_option(options, :source) || "#{kind}.operation"
        add_option(metadata, "#{kind}.system", read_option(options, :system))
        add_option(metadata, "#{kind}.operation", read_option(options, :operation))
        add_option(metadata, "#{kind}.target", read_option(options, :target))
        metadata["exceptionType"] = error.class.name if error
      end
    end

    def span_events(error)
      return nil unless error

      [
        {
          name: "exception",
          metadata: {
            exceptionType: error.class.name,
            exceptionEscaped: true
          }
        }
      ]
    end

    def sanitized_metadata(metadata)
      return {} if metadata.nil?
      raise SdkError.new("validation_error", "operation metadata must be an object") unless metadata.is_a?(Hash)

      metadata.each_with_object({}) do |(key, value), copied|
        normalized_key = key.to_s
        next if normalized_key.strip.empty?
        next if unsafe_metadata_key?(normalized_key)
        next unless CaptureHelpers.primitive_metadata_value?(value)

        copied[normalized_key] = value
      end
    end

    def unsafe_metadata_key?(key)
      key.match?(UNSAFE_METADATA)
    end

    def add_option(metadata, key, value)
      metadata[key] = value if CaptureHelpers.primitive_metadata_value?(value) && !(value.is_a?(String) && value.strip.empty?)
    end

    def read_option(options, key)
      options.key?(key) ? options[key] : options[key.to_s]
    end

    def event_id(kind, context, options)
      read_option(options, :event_id) || "ruby_#{kind}_span_#{context.span_id}"
    end

    def timestamp(options)
      value = read_option(options, :timestamp)
      return value unless value.nil?

      Time.now.utc.iso8601
    end

    def duration_ms(started_at, options)
      configured = read_option(options, :duration_ms)
      return configured unless configured.nil?

      ((monotonic_time - started_at) * 1000.0).round(3)
    end

    def monotonic_time
      Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end

  end
end
