# frozen_string_literal: true

require "securerandom"

module LogBrew
  TraceContext = Struct.new(:trace_id, :span_id, :parent_span_id, :trace_flags, :sampled, keyword_init: true)

  class TraceScope
    def initialize(scope_id)
      @scope_id = scope_id
      @closed = false
    end

    def close
      return if @closed

      LogBrew::Trace.close_scope(@scope_id)
      @closed = true
    end
  end

  # Request-local trace context for app-owned logs, errors, actions, and metrics.
  module Trace
    STACK_KEY = :logbrew_trace_stack
    private_constant :STACK_KEY

    module_function

    def current
      entry = stack.last
      entry && entry[:context]
    end

    def activate(context)
      unless context.is_a?(TraceContext)
        raise SdkError.new("validation_error", "trace context must be a LogBrew::TraceContext")
      end

      scope_id = Object.new.object_id
      stack << { id: scope_id, context: context }
      TraceScope.new(scope_id)
    end

    def with_context(context)
      scope = activate(context)
      yield context
    ensure
      scope.close if scope
    end

    def close_scope(scope_id)
      entries = stack
      index = entries.rindex { |entry| entry[:id] == scope_id }
      entries.delete_at(index) unless index.nil?
    end

    def continue_or_create(traceparent)
      text = traceparent.to_s.strip
      return create_root if text.empty?

      from_traceparent(text)
    rescue SdkError
      create_root
    end

    def from_traceparent(traceparent)
      context = Traceparent.parse(traceparent)
      create(
        trace_id: context.trace_id,
        span_id: generate_span_id,
        parent_span_id: context.parent_span_id,
        trace_flags: context.trace_flags
      )
    end

    def create_root
      create(trace_id: generate_trace_id, span_id: generate_span_id, trace_flags: "01")
    end

    def create(trace_id:, span_id:, trace_flags: "01", parent_span_id: nil)
      normalized_traceparent = Traceparent.create(trace_id: trace_id, span_id: span_id, trace_flags: trace_flags)
      _version, normalized_trace_id, normalized_span_id, normalized_flags = normalized_traceparent.split("-")
      normalized_parent_span_id = nil
      unless parent_span_id.nil?
        parent_traceparent = Traceparent.create(
          trace_id: normalized_trace_id,
          span_id: parent_span_id,
          trace_flags: normalized_flags
        )
        normalized_parent_span_id = parent_traceparent.split("-")[2]
      end

      TraceContext.new(
        trace_id: normalized_trace_id,
        span_id: normalized_span_id,
        parent_span_id: normalized_parent_span_id,
        trace_flags: normalized_flags,
        sampled: (normalized_flags.to_i(16) & 1) == 1
      )
    end

    def create_headers(context = current)
      return {} unless context

      Traceparent.create_headers(
        trace_id: context.trace_id,
        span_id: context.span_id,
        trace_flags: context.trace_flags
      )
    end

    def metadata(context = current)
      return {} unless context

      {
        "traceId" => context.trace_id,
        "spanId" => context.span_id,
        "traceFlags" => context.trace_flags,
        "traceSampled" => context.sampled
      }.tap do |payload|
        payload["parentSpanId"] = context.parent_span_id unless context.parent_span_id.nil?
      end
    end

    def add_metadata(target, context = current)
      return target unless context

      metadata(context).each do |key, value|
        target[key] = value unless target.key?(key) || target.key?(key.to_sym)
      end
      target
    end

    def merge_attributes(attributes, context = current)
      return attributes unless context && attributes.is_a?(Hash)

      metadata_value = attributes.key?("metadata") ? attributes["metadata"] : attributes[:metadata]
      return attributes unless metadata_value.nil? || metadata_value.is_a?(Hash)

      copied = attributes.dup
      merged_metadata = metadata_value.nil? ? {} : metadata_value.dup
      add_metadata(merged_metadata, context)
      if copied.key?(:metadata) && !copied.key?("metadata")
        copied[:metadata] = merged_metadata
      else
        copied["metadata"] = merged_metadata
      end
      copied
    end

    def from_rack_env(env)
      existing = env_value(env, "logbrew.trace")
      return existing if existing.is_a?(TraceContext)

      traceparent = env_value(env, "HTTP_TRACEPARENT") || env_value(env, "traceparent") || env_value(env, "logbrew.traceparent")
      return continue_or_create(traceparent) unless traceparent.nil? || traceparent.empty?

      trace_id = env_value(env, "logbrew.trace_id")
      span_id = env_value(env, "logbrew.span_id")
      if trace_id && span_id
        begin
          return create(
            trace_id: trace_id,
            span_id: span_id,
            parent_span_id: env_value(env, "logbrew.parent_span_id"),
            trace_flags: env_value(env, "logbrew.trace_flags") || "01"
          )
        rescue SdkError
          nil
        end
      end

      create_root
    end

    def generate_trace_id
      loop do
        value = SecureRandom.hex(16)
        return value unless value.delete("0").empty?
      end
    end

    def generate_span_id
      loop do
        value = SecureRandom.hex(8)
        return value unless value.delete("0").empty?
      end
    end

    def stack
      Thread.current[STACK_KEY] ||= []
    end
    private_class_method :stack

    def env_value(env, key)
      return nil unless env.respond_to?(:[])

      value = env[key]
      return value if value.is_a?(TraceContext)
      return nil if value.nil?

      text = value.to_s
      text.empty? ? nil : text
    end
    private_class_method :env_value
  end

  module TraceClientMethods
    def issue(id, timestamp, attributes)
      super(id, timestamp, Trace.merge_attributes(attributes))
    end

    def log(id, timestamp, attributes)
      super(id, timestamp, Trace.merge_attributes(attributes))
    end

    def metric(id, timestamp, attributes)
      super(id, timestamp, Trace.merge_attributes(attributes))
    end

    def action(id, timestamp, attributes)
      super(id, timestamp, Trace.merge_attributes(attributes))
    end
  end

  module TraceLoggerMethods
    private

    def logbrew_metadata(severity, message, progname)
      Trace.add_metadata(super)
    end
  end

  module TraceRackMiddlewareMethods
    def call(env)
      trace_context = Trace.from_rack_env(env)
      env["logbrew.trace"] = trace_context if env.respond_to?(:[]=)
      Trace.with_context(trace_context) { super(env) }
    end

    private

    def capture_request_span(env, status_code, elapsed_ms, status)
      context = rack_trace_context(env)
      attributes = {
        name: request_name(env),
        traceId: context ? context.trace_id : trace_id(env),
        spanId: context ? context.span_id : span_id(env),
        status: status,
        durationMs: elapsed_ms,
        metadata: request_metadata(env, status_code)
      }
      attributes[:parentSpanId] = context.parent_span_id if context && context.parent_span_id

      @client.span(next_event_id("span"), logbrew_timestamp, attributes)
    end

    def trace_id(env)
      context = rack_trace_context(env)
      return context.trace_id if context

      super
    end

    def span_id(env)
      context = rack_trace_context(env)
      return context.span_id if context

      super
    end

    def request_metadata(env, status_code)
      Trace.add_metadata(super, rack_trace_context(env))
    end

    def exception_metadata(env, error)
      Trace.add_metadata(super, rack_trace_context(env))
    end

    def rack_trace_context(env)
      trace = env["logbrew.trace"] if env.respond_to?(:[])
      trace.is_a?(TraceContext) ? trace : Trace.current
    end
  end

  module TraceRailsErrorSubscriberMethods
    private

    def rails_metadata(error, handled, severity, context, source)
      Trace.add_metadata(super)
    end
  end

  Client.prepend(TraceClientMethods)
  Logger.prepend(TraceLoggerMethods)
  RackMiddleware.prepend(TraceRackMiddlewareMethods)
  RailsErrorSubscriber.prepend(TraceRailsErrorSubscriberMethods)
end
