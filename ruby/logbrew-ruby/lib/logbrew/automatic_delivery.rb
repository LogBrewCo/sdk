# frozen_string_literal: true

module LogBrew
  class DeliveryHealth
    FIELDS = %i[
      state queued_events queued_bytes dropped_events in_flight last_outcome
      consecutive_failures pause_reason successful_flushes failed_flushes retry_delay_ms
    ].freeze

    attr_reader(*FIELDS)

    def initialize(**values)
      FIELDS.each { |field| instance_variable_set("@#{field}", values.fetch(field)) }
      freeze
    end

    def to_h
      FIELDS.each_with_object({}) do |field, result|
        result[field.to_s] = public_send(field)
      end
    end
  end

  class AutomaticDelivery
    COUNTER_MAX = (2**63) - 1
    STATES = %w[idle running retrying paused stopped closing closed].freeze
    OUTCOMES = %w[none empty accepted retryable_failure terminal_failure stopped].freeze
    PAUSE_REASONS = %w[authentication quota validation nonretryable].freeze

    attr_reader :transport

    def self.validate!(
      transport:,
      flush_interval:,
      flush_threshold:,
      retry_base_delay:,
      retry_max_delay:,
      max_queue_size:
    )
      unless transport.respond_to?(:send)
        raise SdkError.new("validation_error", "automatic transport must respond to send")
      end
      validate_positive_number("flush_interval", flush_interval)
      validate_positive_integer("flush_threshold", flush_threshold)
      if flush_threshold > max_queue_size
        raise SdkError.new("validation_error", "flush_threshold must not exceed max_queue_size")
      end
      validate_positive_number("retry_base_delay", retry_base_delay)
      validate_positive_number("retry_max_delay", retry_max_delay)
      if retry_base_delay > retry_max_delay
        raise SdkError.new("validation_error", "retry_base_delay must not exceed retry_max_delay")
      end
    end

    def self.validate_positive_number(label, value)
      valid = (value.is_a?(Integer) || value.is_a?(Float)) && value.positive?
      valid &&= !value.is_a?(Float) || (!value.nan? && !value.infinite?)
      raise SdkError.new("validation_error", "#{label} must be a positive finite number") unless valid
    end
    private_class_method :validate_positive_number

    def self.validate_positive_integer(label, value)
      return if value.is_a?(Integer) && value.positive?

      raise SdkError.new("validation_error", "#{label} must be a positive integer")
    end
    private_class_method :validate_positive_integer

    def initialize(
      client:,
      transport:,
      flush_interval:,
      flush_threshold:,
      retry_base_delay:,
      retry_max_delay:
    )
      @client = client
      @transport = transport
      @flush_interval = flush_interval.to_f
      @flush_threshold = flush_threshold
      @retry_base_delay = retry_base_delay.to_f
      @retry_max_delay = retry_max_delay.to_f
      @owner_process_id = current_process_id
      @mutex = Mutex.new
      @condition = ConditionVariable.new
      @worker = nil
      @stop_requested = false
      @generation = 0
      @state = "idle"
      @last_outcome = "none"
      @pause_reason = nil
      @in_flight = false
      @consecutive_failures = 0
      @successful_flushes = 0
      @failed_flushes = 0
      @retry_delay = nil
      @retry_deadline = nil
      @next_interval_deadline = nil
      @wake_requested = false
      @observed_queue_count = live_queue_metrics.fetch(:queued_events)
      activate_recovered_work if @observed_queue_count.positive?
    end

    def assert_process_ownership!
      return if current_process_id == @owner_process_id

      raise SdkError.new(
        "process_ownership_error",
        "automatic delivery client must be created in the current process"
      )
    end

    def notify_capture
      assert_process_ownership!
      @mutex.synchronize do
        update_queue_count(live_queue_metrics)
        return if @stop_requested || @state == "paused" || @state == "closed"

        return unless ensure_worker
        return if @state == "retrying"

        @next_interval_deadline ||= monotonic_time + @flush_interval
        @wake_requested = true if @observed_queue_count >= @flush_threshold
        @condition.signal
      end
    end

    def queue_changed
      assert_process_ownership!
      @mutex.synchronize do
        update_queue_count(live_queue_metrics)
        if @observed_queue_count.zero?
          @wake_requested = false
          @next_interval_deadline = nil
          @retry_deadline = nil
          @retry_delay = nil
        end
        @condition.signal
      end
    end

    def begin_explicit_flush
      assert_process_ownership!
      @mutex.synchronize do
        @generation += 1
        @retry_deadline = nil
        @retry_delay = nil
        previous = [@state, @pause_reason, @generation]
        unless @state == "stopped" || @state == "closed"
          @state = "running"
          @in_flight = true
        end
        previous
      end
    end

    def complete_explicit_flush(previous, response)
      @mutex.synchronize do
        @in_flight = false
        update_queue_count(live_queue_metrics)
        return unless previous.fetch(2) == @generation

        if previous.fetch(0) == "stopped"
          @state = "stopped"
        else
          record_success(response)
          return if @observed_queue_count.positive? && !ensure_worker

          schedule_pending_work
        end
      end
    end

    def fail_explicit_flush(previous, error)
      @mutex.synchronize do
        @in_flight = false
        update_queue_count(live_queue_metrics)
        return unless previous.fetch(2) == @generation

        @failed_flushes = increment(@failed_flushes)
        @last_outcome = retryable_failure?(error) ? "retryable_failure" : "terminal_failure"
        if previous.fetch(0) == "paused"
          @state = "paused"
          @pause_reason = previous.fetch(1)
          @wake_requested = false
          @next_interval_deadline = nil
          @retry_delay = nil
          @retry_deadline = nil
        elsif previous.fetch(0) == "stopped"
          @state = "stopped"
          @wake_requested = false
        else
          record_failure(error)
          ensure_worker if retryable_failure?(error) && @observed_queue_count.positive?
        end
      end
    end

    def complete_automatic_flush(generation, response)
      @mutex.synchronize do
        @in_flight = false
        update_queue_count(live_queue_metrics)
        return unless generation == @generation
        return if @stop_requested || %w[closing closed stopped].include?(@state)

        record_success(response)
        schedule_pending_work
      end
    end

    def fail_automatic_flush(generation, error)
      @mutex.synchronize do
        @in_flight = false
        update_queue_count(live_queue_metrics)
        return unless generation == @generation
        return if @stop_requested || %w[closing closed stopped].include?(@state)

        @failed_flushes = increment(@failed_flushes)
        @last_outcome = retryable_failure?(error) ? "retryable_failure" : "terminal_failure"
        record_failure(error)
      end
    end

    def prepare_shutdown
      assert_process_ownership!
      worker = @mutex.synchronize do
        if @state == "closing" || @state == "closed"
          raise SdkError.new("shutdown_error", "automatic delivery is already shutting down")
        end

        @generation += 1
        @state = "closing"
        @stop_requested = true
        @wake_requested = false
        @retry_deadline = nil
        @retry_delay = nil
        @condition.broadcast
        @worker
      end
      join_worker(worker)
    end

    def complete_shutdown(response)
      @mutex.synchronize do
        @in_flight = false
        queue_metrics = live_queue_metrics
        update_queue_count(queue_metrics)
        record_success(response)
        @state = "closed"
        @worker = nil
      end
    end

    def resume_after_failed_shutdown(error)
      @mutex.synchronize do
        queue_metrics = live_queue_metrics
        update_queue_count(queue_metrics)
        @stop_requested = false
        @failed_flushes = increment(@failed_flushes)
        @consecutive_failures = increment(@consecutive_failures)
        @worker = nil
        if retryable_failure?(error)
          @state = "retrying"
          @last_outcome = "retryable_failure"
          @pause_reason = nil
          @retry_delay = bounded_retry_delay
          @retry_deadline = monotonic_time + @retry_delay
          ensure_worker if @observed_queue_count.positive?
          @condition.signal
        else
          @state = "paused"
          @last_outcome = "terminal_failure"
          @pause_reason = pause_reason(error)
          @retry_delay = nil
          @retry_deadline = nil
        end
      end
    end

    def stop
      assert_process_ownership!
      worker = @mutex.synchronize do
        return if @state == "stopped" || @state == "closed"

        @generation += 1
        @state = "stopped"
        @last_outcome = "stopped"
        @stop_requested = true
        @wake_requested = false
        @retry_deadline = nil
        @retry_delay = nil
        @condition.broadcast
        @worker
      end
      join_worker(worker)
      @mutex.synchronize do
        @worker = nil
        @in_flight = false
      end
      nil
    end

    def snapshot
      assert_process_ownership!
      @mutex.synchronize do
        queue_metrics = live_queue_metrics
        DeliveryHealth.new(
          state: @state,
          queued_events: queue_metrics.fetch(:queued_events),
          queued_bytes: queue_metrics.fetch(:queued_bytes),
          dropped_events: queue_metrics.fetch(:dropped_events),
          in_flight: @in_flight,
          last_outcome: @last_outcome,
          consecutive_failures: @consecutive_failures,
          pause_reason: @pause_reason,
          successful_flushes: @successful_flushes,
          failed_flushes: @failed_flushes,
          retry_delay_ms: @retry_delay.nil? ? 0 : bounded_milliseconds(@retry_delay)
        )
      end
    end

    private

    def activate_recovered_work
      @mutex.synchronize do
        return unless ensure_worker

        @wake_requested = true
        @condition.signal
      end
    end

    def ensure_worker
      return false if @stop_requested || @state == "paused" || @state == "closed"
      return true if @worker&.alive?

      @worker = Thread.new { run }
      @worker.name = "logbrew-delivery" if @worker.respond_to?(:name=)
      @worker.report_on_exception = false if @worker.respond_to?(:report_on_exception=)
      true
    rescue ThreadError
      @worker = nil
      @state = "stopped"
      @last_outcome = "terminal_failure"
      @pause_reason = "nonretryable"
      @stop_requested = true
      false
    end

    def run
      loop do
        generation = wait_for_wake
        return if generation.nil?

        @client.send(:perform_automatic_flush, self, generation, @transport)
      end
    rescue StandardError
      @mutex.synchronize do
        @in_flight = false
        @state = "stopped" unless @state == "closed"
        @last_outcome = "terminal_failure"
        @pause_reason = "nonretryable"
        @stop_requested = true
      end
    end

    def wait_for_wake
      @mutex.synchronize do
        loop do
          return nil if @stop_requested

          now = monotonic_time
          retry_ready = !@retry_deadline.nil? && now >= @retry_deadline
          interval_ready = !@next_interval_deadline.nil? && now >= @next_interval_deadline
          if @state != "paused" && (@wake_requested || retry_ready || interval_ready)
            @wake_requested = false
            @retry_deadline = nil
            @retry_delay = nil if retry_ready
            @next_interval_deadline = nil
            @state = retry_ready ? "retrying" : "running"
            @in_flight = true
            return @generation
          end

          deadline = [@retry_deadline, @next_interval_deadline].compact.min
          timeout = deadline.nil? ? nil : [deadline - now, 0].max
          @condition.wait(@mutex, timeout)
        end
      end
    end

    def record_success(response)
      @consecutive_failures = 0
      @pause_reason = nil
      @retry_delay = nil
      @retry_deadline = nil
      @last_outcome = response.batches.zero? ? "empty" : "accepted"
      @successful_flushes = increment(@successful_flushes) if response.batches.positive?
      @state = "idle"
    end

    def record_failure(error)
      @consecutive_failures = increment(@consecutive_failures)
      @wake_requested = false
      @next_interval_deadline = nil
      if retryable_failure?(error)
        @pause_reason = nil
        @retry_delay = bounded_retry_delay
        @retry_deadline = monotonic_time + @retry_delay
        @state = "retrying"
        @condition.signal
      else
        @pause_reason = pause_reason(error)
        @retry_delay = nil
        @retry_deadline = nil
        @state = "paused"
      end
    end

    def schedule_pending_work
      if @observed_queue_count.zero?
        @wake_requested = false
        @next_interval_deadline = nil
      elsif @observed_queue_count >= @flush_threshold
        @wake_requested = true
        @next_interval_deadline = nil
        @condition.signal
      else
        @wake_requested = false
        @next_interval_deadline = monotonic_time + @flush_interval
        @condition.signal
      end
    end

    def update_queue_count(queue_metrics)
      @observed_queue_count = queue_metrics.fetch(:queued_events)
    end

    def live_queue_metrics
      @client.send(:queue_metrics)
    end

    def retryable_failure?(error)
      error.respond_to?(:automatic_retryable?) && error.automatic_retryable?
    end

    def pause_reason(error)
      reason = error.respond_to?(:automatic_pause_reason) ? error.automatic_pause_reason : nil
      return reason if PAUSE_REASONS.include?(reason)
      return "authentication" if error.is_a?(SdkError) && error.code == "unauthenticated"
      return "quota" if error.is_a?(SdkError) && error.code == "rate_limited"
      return "validation" if error.is_a?(SdkError) && error.code == "validation_error"

      "nonretryable"
    end

    def bounded_retry_delay
      exponent = [[@consecutive_failures - 1, 0].max, 30].min
      cap = [@retry_base_delay * (2**exponent), @retry_max_delay].min
      half = cap / 2.0
      half + (Random.rand * half)
    end

    def bounded_milliseconds(seconds)
      [[(seconds * 1000).ceil, 0].max, (COUNTER_MAX)].min
    end

    def increment(value)
      value >= COUNTER_MAX ? COUNTER_MAX : value + 1
    end

    def join_worker(worker)
      return if worker.nil? || worker == Thread.current

      worker.join
    end

    def current_process_id
      process_id = Process.pid
      unless process_id.is_a?(Integer) && process_id.positive?
        raise SdkError.new("process_ownership_error", "automatic delivery process identity is unavailable")
      end

      process_id
    end

    def monotonic_time
      Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end
  end
  private_constant :AutomaticDelivery
end
