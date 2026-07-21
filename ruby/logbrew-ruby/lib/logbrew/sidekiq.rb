# frozen_string_literal: true

require_relative "../logbrew"

module LogBrew
  # Explicit Sidekiq middleware for app-owned client and server chains.
  module Sidekiq
    CARRIER_KEY = "logbrew".freeze
    CARRIER_VERSION = 1
    MAX_QUEUE_WAIT_MS = 604_800_000
    MAX_RETRY_COUNT = 1_000
    MAX_REPORTED_FAILURES = 1_024
    private_constant :CARRIER_KEY, :CARRIER_VERSION, :MAX_QUEUE_WAIT_MS, :MAX_RETRY_COUNT, :MAX_REPORTED_FAILURES

    class TraceOperation
      attr_reader :context, :traceparent

      def initialize(instrumentation:, context:, name:, source:, retry_count: nil, queue_wait_ms: nil)
        @instrumentation = instrumentation
        @context = context
        @traceparent = Trace.create_headers(context).fetch("traceparent")
        @name = name
        @source = source
        @retry_count = retry_count
        @queue_wait_ms = queue_wait_ms
        @started_at = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        @finished = false
        @finish_mutex = Mutex.new
      end

      def around(terminal_failure: false)
        Trace.with_context(@context) do
          begin
            result = yield
          rescue Exception => error # rubocop:disable Lint/RescueException
            finish(error: error, terminal_failure: terminal_failure)
            raise
          else
            finish
            result
          end
        end
      end

      private

      def finish(error: nil, terminal_failure: false)
        return unless @finish_mutex.synchronize do
          next false if @finished

          @finished = true
        end

        @instrumentation.send(:capture_span, self, error)
        @instrumentation.send(:capture_terminal_issue, self) if error && terminal_failure && !cancellation?(error)
      rescue StandardError => capture_error
        @instrumentation.send(:report_capture_error, capture_error)
      end

      def cancellation?(error)
        error.is_a?(Interrupt)
      end

      public

      def span_attributes(error)
        metadata = {
          "source" => @source,
          "sampled" => @context.sampled
        }
        metadata["retryCount"] = @retry_count unless @retry_count.nil?
        metadata["queueWaitMs"] = @queue_wait_ms unless @queue_wait_ms.nil?
        metadata["cancelled"] = true if error.is_a?(Interrupt)

        {
          "name" => @name,
          "traceId" => @context.trace_id,
          "spanId" => @context.span_id,
          "parentSpanId" => @context.parent_span_id,
          "status" => error ? "error" : "ok",
          "durationMs" => elapsed_ms,
          "metadata" => metadata
        }
      end

      def issue_attributes
        {
          "title" => "Sidekiq job failed",
          "level" => "error",
          "metadata" => {
            "source" => @source,
            "sampled" => @context.sampled,
            "retryCount" => @retry_count + 1
          }
        }
      end

      def retry_count
        @retry_count
      end

      def failure_key
        [@context.trace_id, @context.parent_span_id, @retry_count].join(":")
      end

      private

      def elapsed_ms
        elapsed = Process.clock_gettime(Process::CLOCK_MONOTONIC) - @started_at
        (elapsed * 1000.0).round(3)
      end
    end
    private_constant :TraceOperation

    # App-owned Sidekiq registration and lifecycle state.
    class Instrumentation
      def self.create(client:, transport: nil, max_retries: 25, on_capture_error: nil)
        unless client.is_a?(Client)
          raise SdkError.new("validation_error", "client must be a LogBrew::Client")
        end
        unless transport.nil? || transport.respond_to?(:send)
          raise SdkError.new("validation_error", "transport must respond to send")
        end
        unless max_retries.is_a?(Integer) && max_retries.between?(0, MAX_RETRY_COUNT)
          raise SdkError.new("validation_error", "max_retries must be a bounded non-negative integer")
        end
        unless on_capture_error.nil? || on_capture_error.respond_to?(:call)
          raise SdkError.new("validation_error", "on_capture_error must be callable")
        end

        new(
          client: client,
          transport: transport,
          max_retries: max_retries,
          on_capture_error: on_capture_error
        )
      end

      private_class_method :new

      def initialize(client:, transport:, max_retries:, on_capture_error:)
        @client = client
        @transport = transport
        @max_retries = max_retries
        @on_capture_error = on_capture_error
        @owner_process_id = Process.pid
        @state_mutex = Mutex.new
        @state = :enabled
        @shutdown_mutex = Mutex.new
        @shutdown_response = nil
        @failure_mutex = Mutex.new
        @reported_failures = {}
        @registration_mutex = Mutex.new
        @registrations = {}
      end

      def register_client(config)
        register(config, :client_middleware, ClientMiddleware)
      end

      def unregister_client(config)
        unregister(config, :client_middleware, ClientMiddleware)
      end

      def register_server(config)
        register(config, :server_middleware, ServerMiddleware)
      end

      def unregister_server(config)
        unregister(config, :server_middleware, ServerMiddleware)
      end

      def enable
        update_state(:enabled)
      end

      def disable
        update_state(:disabled)
      end

      def quiet
        update_state(:quiet)
      end

      def shutdown
        assert_process_ownership!
        @shutdown_mutex.synchronize do
          return @shutdown_response unless @shutdown_response.nil?

          quiet
          response = @transport.nil? ? @client.shutdown : @client.shutdown(@transport)
          @state_mutex.synchronize { @state = :closed }
          @shutdown_response = response
        end
      end

      def around_client(job)
        return yield unless capture_enabled?
        return yield unless job.is_a?(Hash)
        return yield if job.key?(CARRIER_KEY)

        operation = prepare_operation(name: "sidekiq.enqueue", source: "sidekiq.client", continue_current: true)
        return yield if operation.nil?

        begin
          job[CARRIER_KEY] = {
            "version" => CARRIER_VERSION,
            "traceparent" => operation.traceparent,
            "enqueuedAtMs" => wall_time_ms
          }
        rescue StandardError => error
          report_capture_error(error)
          return yield
        end
        operation.around { yield }
      end

      def around_server(job)
        return yield unless capture_enabled?
        return yield unless job.is_a?(Hash)

        begin
          carrier = read_carrier(job[CARRIER_KEY])
          retry_count = normalized_retry_count(job["retry_count"], job.key?("retry_count"))
          operation = prepare_operation(
            name: "sidekiq.perform",
            source: "sidekiq.server",
            carrier: carrier,
            retry_count: retry_count,
            queue_wait_ms: queue_wait_ms(carrier)
          )
        rescue StandardError => error
          report_capture_error(error)
          operation = nil
        end
        return yield if operation.nil?

        terminal = terminal_failure?(job["retry"], retry_count)
        operation.around(terminal_failure: terminal) { yield }
      end

      private :around_client, :around_server

      private

      def register(config, method_name, middleware)
        assert_process_ownership!
        changed = false
        with_chain(config, method_name) do |chain|
          unless chain.exists?(middleware)
            chain.add(middleware, self)
            changed = true
          end
        end
        if changed
          @registration_mutex.synchronize { @registrations[registration_key(config, method_name, middleware)] = config }
        end
        changed
      end

      def unregister(config, method_name, middleware)
        assert_process_ownership!
        key = registration_key(config, method_name, middleware)
        owned = @registration_mutex.synchronize do
          registered = @registrations[key]
          registered.equal?(config)
        end
        return false unless owned

        changed = false
        with_chain(config, method_name) do |chain|
          if chain.exists?(middleware)
            chain.remove(middleware)
            changed = true
          end
        end
        @registration_mutex.synchronize { @registrations.delete(key) }
        changed
      end

      def registration_key(config, method_name, middleware)
        [config.object_id, method_name, middleware]
      end

      def with_chain(config, method_name)
        unless config.respond_to?(method_name)
          raise SdkError.new("validation_error", "Sidekiq configuration does not expose the requested middleware chain")
        end

        config.public_send(method_name) do |chain|
          unless chain.respond_to?(:exists?) && chain.respond_to?(:add) && chain.respond_to?(:remove)
            raise SdkError.new("validation_error", "Sidekiq middleware chain is unavailable")
          end

          yield chain
        end
      end

      def update_state(state)
        assert_process_ownership!
        @state_mutex.synchronize do
          raise SdkError.new("shutdown_error", "Sidekiq instrumentation is shut down") if @state == :closed

          @state = state
        end
        self
      end

      def capture_enabled?
        unless current_process?
          report_capture_error(SdkError.new("process_ownership_error", "Sidekiq instrumentation belongs to another process"))
          return false
        end

        @state_mutex.synchronize { @state == :enabled }
      end

      def current_process?
        Process.pid == @owner_process_id
      rescue StandardError
        false
      end

      def assert_process_ownership!
        return if current_process?

        raise SdkError.new("process_ownership_error", "Sidekiq instrumentation belongs to another process")
      end

      def prepare_operation(name:, source:, carrier: nil, retry_count: nil, queue_wait_ms: nil, continue_current: false)
        parsed = carrier && Traceparent.parse(carrier.fetch("traceparent"))
        parent = parsed.nil? && continue_current ? Trace.current : parsed
        context = if parsed
                    Trace.create(
                      trace_id: parsed.trace_id,
                      span_id: Trace.generate_span_id,
                      parent_span_id: parsed.parent_span_id,
                      trace_flags: parsed.trace_flags
                    )
                  elsif parent
                    Trace.create(
                      trace_id: parent.trace_id,
                      span_id: Trace.generate_span_id,
                      parent_span_id: parent.span_id,
                      trace_flags: parent.trace_flags
                    )
                  else
                    Trace.create_root
                  end
        TraceOperation.new(
          instrumentation: self,
          context: context,
          name: name,
          source: source,
          retry_count: retry_count,
          queue_wait_ms: queue_wait_ms
        )
      rescue StandardError => error
        report_capture_error(error)
        nil
      end

      def read_carrier(value)
        return nil unless value.is_a?(Hash)
        keys = %w[enqueuedAtMs traceparent version]
        return nil unless value.size == keys.length && keys.all? { |key| value.key?(key) }
        return nil unless value["version"] == CARRIER_VERSION
        return nil unless value["traceparent"].is_a?(String) && value["traceparent"].bytesize <= 55
        return nil unless value["enqueuedAtMs"].is_a?(Integer) && value["enqueuedAtMs"].between?(0, 9_007_199_254_740_991)

        Traceparent.parse(value["traceparent"])
        value
      rescue SdkError
        nil
      end

      def normalized_retry_count(value, present)
        return 0 unless present
        return nil unless value.is_a?(Integer) && value.between?(0, MAX_RETRY_COUNT)

        value
      end

      def terminal_failure?(retry_setting, retry_count)
        return false if retry_count.nil?
        return true if retry_setting == false || retry_setting == 0
        return false unless retry_setting.nil? || retry_setting == true || retry_setting.is_a?(Integer)

        limit = retry_setting.is_a?(Integer) ? retry_setting : @max_retries
        return false if limit.negative?

        retry_count >= [limit - 1, 0].max
      end

      def queue_wait_ms(carrier)
        return nil if carrier.nil?

        elapsed = wall_time_ms - carrier.fetch("enqueuedAtMs")
        [[elapsed, 0].max, MAX_QUEUE_WAIT_MS].min
      end

      def wall_time_ms
        (Time.now.to_f * 1000.0).floor
      end

      def capture_span(operation, error)
        @client.span(
          "ruby_sidekiq_span_#{operation.context.span_id}",
          Time.now.utc.iso8601,
          operation.span_attributes(error)
        )
      end

      def capture_terminal_issue(operation)
        key = operation.failure_key
        reserved = @failure_mutex.synchronize do
          next false if @reported_failures.key?(key)

          @reported_failures[key] = true
          @reported_failures.shift while @reported_failures.length > MAX_REPORTED_FAILURES
          true
        end
        return unless reserved

        begin
          @client.issue(
            "ruby_sidekiq_issue_#{operation.context.span_id}",
            Time.now.utc.iso8601,
            operation.issue_attributes
          )
        rescue StandardError
          @failure_mutex.synchronize { @reported_failures.delete(key) }
          raise
        end
      end

      def report_capture_error(error)
        @on_capture_error&.call(error)
      rescue StandardError
        nil
      end
    end

    # Sidekiq client middleware installed in an app-owned middleware chain.
    class ClientMiddleware
      def initialize(instrumentation)
        @instrumentation = instrumentation
      end

      def call(_worker_class, job, _queue, _redis_pool)
        @instrumentation.send(:around_client, job) { yield }
      end
    end

    # Sidekiq server middleware installed in an app-owned middleware chain.
    class ServerMiddleware
      def initialize(instrumentation)
        @instrumentation = instrumentation
      end

      def call(_worker, job, _queue)
        @instrumentation.send(:around_server, job) { yield }
      end
    end
  end
end
