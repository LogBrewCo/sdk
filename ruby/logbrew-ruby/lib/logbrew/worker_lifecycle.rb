# frozen_string_literal: true

module LogBrew
  # Content-free delivery details safe for application-owned diagnostics.
  class WorkerDeliveryFailure
    attr_reader :stage, :code, :pending_events, :pending_event_bytes, :dropped_events

    def initialize(stage:, code:, pending_events:, pending_event_bytes:, dropped_events:)
      @stage = stage.dup.freeze
      @code = code.dup.freeze
      @pending_events = pending_events
      @pending_event_bytes = pending_event_bytes
      @dropped_events = dropped_events
      freeze
    end
  end

  # Explicit delivery boundaries for serialized prefork worker loops.
  class WorkerLifecycle
    SAFE_DELIVERY_CODES = %w[
      delivery_error
      flush_error
      network_failure
      shutdown_error
      transport_error
      unauthenticated
      validation_error
    ].freeze

    def self.create(client:, transport:, on_delivery_failure: nil)
      unless client.is_a?(Client)
        raise SdkError.new("validation_error", "client must be a LogBrew::Client")
      end
      unless transport.respond_to?(:send)
        raise SdkError.new("validation_error", "transport must respond to send")
      end
      if !on_delivery_failure.nil? && !on_delivery_failure.respond_to?(:call)
        raise SdkError.new("validation_error", "on_delivery_failure must be callable")
      end

      new(
        client: client,
        transport: transport,
        on_delivery_failure: on_delivery_failure,
        owner_process_id: current_process_id
      )
    end

    def self.current_process_id
      process_id = Process.pid
      unless process_id.is_a?(Integer) && process_id.positive?
        raise SdkError.new("process_ownership_error", "worker process identity is unavailable")
      end

      process_id
    end
    private_class_method :current_process_id

    def initialize(client:, transport:, on_delivery_failure:, owner_process_id:)
      @client = client
      @transport = transport
      @on_delivery_failure = on_delivery_failure
      @owner_process_id = owner_process_id
      @state_mutex = Mutex.new
      @operation_active = false
      @shutdown_response = nil
    end
    private_class_method :new

    def run
      assert_process_ownership
      begin_run
      begin
        application_error = nil
        result = nil
        begin
          result = yield
        rescue Exception => error # rubocop:disable Lint/RescueException
          application_error = error
        ensure
          finish_work_boundary(application_error)
        end

        raise application_error unless application_error.nil?

        result
      ensure
        end_operation
      end
    end

    def shutdown
      assert_process_ownership
      cached_response = begin_shutdown
      return cached_response unless cached_response.nil?

      completed = false
      begin
        begin
          response = @client.shutdown(@transport)
        rescue StandardError => delivery_error
          report_delivery_failure("shutdown", delivery_error)
          raise delivery_error
        end

        complete_shutdown(response)
        completed = true
        response
      ensure
        end_operation unless completed
      end
    end

    private

    def begin_run
      @state_mutex.synchronize do
        raise SdkError.new("shutdown_error", "worker lifecycle is already shut down") unless @shutdown_response.nil?

        claim_operation
      end
    end

    def begin_shutdown
      @state_mutex.synchronize do
        return @shutdown_response unless @shutdown_response.nil?

        claim_operation
        nil
      end
    end

    def claim_operation
      if @operation_active
        raise SdkError.new("worker_lifecycle_error", "worker lifecycle operation is already in progress")
      end

      @operation_active = true
    end

    def complete_shutdown(response)
      @state_mutex.synchronize do
        @shutdown_response = response
        @operation_active = false
      end
    end

    def end_operation
      if current_process_id == @owner_process_id
        @state_mutex.synchronize { @operation_active = false }
      else
        # An inherited lifecycle is permanently unusable in the child.
        @operation_active = false
      end
    end

    def assert_process_ownership
      return if current_process_id == @owner_process_id

      raise SdkError.new(
        "process_ownership_error",
        "worker lifecycle must be created in the current process"
      )
    end

    def finish_work_boundary(application_error)
      begin
        assert_process_ownership
      rescue SdkError => ownership_error
        raise application_error unless application_error.nil?

        raise ownership_error
      end

      begin
        @client.flush(@transport)
      rescue StandardError => delivery_error
        report_delivery_failure("work_boundary", delivery_error)
      end
    end

    def current_process_id
      process_id = Process.pid
      unless process_id.is_a?(Integer) && process_id.positive?
        raise SdkError.new("process_ownership_error", "worker process identity is unavailable")
      end

      process_id
    end

    def report_delivery_failure(stage, error)
      return if @on_delivery_failure.nil?

      code = if error.is_a?(SdkError) && SAFE_DELIVERY_CODES.include?(error.code)
               error.code
             else
               "delivery_error"
             end
      notice = WorkerDeliveryFailure.new(
        stage: stage,
        code: code,
        pending_events: @client.pending_events,
        pending_event_bytes: @client.pending_event_bytes,
        dropped_events: @client.dropped_events
      )
      @on_delivery_failure.call(notice)
    rescue StandardError
      nil
    end
  end
end
