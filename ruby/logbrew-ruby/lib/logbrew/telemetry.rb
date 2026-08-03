# frozen_string_literal: true

module LogBrew
  # Idempotent owner for one active shared-context scope.
  class TelemetryScope
    def initialize(activation_id)
      @activation_id = activation_id
      @closed = false
    end

    def close
      return if @closed

      Telemetry.close_scope(@activation_id)
      @closed = true
    end
  end

  # Fiber/thread-local shared context for request, job, and operation boundaries.
  module Telemetry
    STACK_KEY = :logbrew_telemetry_context_stack
    private_constant :STACK_KEY

    module_function

    def current_context
      entry = stack.last
      entry && entry[:context]
    end

    def activate_context(context)
      unless context.is_a?(TelemetryContext)
        raise TelemetryContextValue.invalid("context must be a LogBrew::TelemetryContext")
      end

      merged = TelemetryContext.merge(current_context, context)
      activation_id = Object.new
      stack << { id: activation_id, context: merged }
      TelemetryScope.new(activation_id)
    end

    def with_context(context)
      scope = activate_context(context)
      yield context
    ensure
      scope.close if scope
    end

    def close_scope(activation_id)
      entries = stack
      index = entries.rindex { |entry| entry[:id].equal?(activation_id) }
      entries.delete_at(index) unless index.nil?
    end

    def stack
      Thread.current[STACK_KEY] ||= []
    end
    private_class_method :stack
  end
end
