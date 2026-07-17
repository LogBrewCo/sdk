# frozen_string_literal: true

module LogBrew
  class DroppedEvent
    attr_reader :event_id, :event_type, :reason, :dropped_events,
                :pending_events, :pending_event_bytes

    def initialize(event_id:, event_type:, reason:, dropped_events:, pending_events:, pending_event_bytes:)
      @event_id = event_id.dup.freeze
      @event_type = event_type.dup.freeze
      @reason = reason.dup.freeze
      @dropped_events = dropped_events
      @pending_events = pending_events
      @pending_event_bytes = pending_event_bytes
      freeze
    end
  end

  class BoundedEventQueue
    DEFAULT_MAX_SIZE = 1_000
    DEFAULT_MAX_BYTES = 4_194_304
    CALLBACK_GUARD_KEY = :logbrew_drop_callback_guards

    EventRecord = Struct.new(:json, :bytes, :storage_record)
    Snapshot = Struct.new(:records, :event_count, :event_bytes) do
      def events
        records.map { |record| JSON.parse(record.json) }
      end

      def serialized_events
        records.map(&:json)
      end
    end
    private_constant :EventRecord
    private_constant :Snapshot

    def initialize(max_size:, max_bytes:, max_event_bytes: max_bytes, on_event_dropped:, event_store: nil)
      validate_positive_integer("max_queue_size", max_size)
      validate_positive_integer("max_queue_bytes", max_bytes)
      validate_positive_integer("max_event_bytes", max_event_bytes)
      unless on_event_dropped.nil? || on_event_dropped.respond_to?(:call)
        raise SdkError.new("validation_error", "on_event_dropped must respond to call")
      end

      @max_size = max_size
      @max_bytes = max_bytes
      @max_event_bytes = max_event_bytes
      @on_event_dropped = on_event_dropped
      @event_store = event_store
      stored_records = event_store.nil? ? [] : event_store.records
      @records = stored_records.map do |record|
        EventRecord.new(record.json, record.bytes, record).freeze
      end
      @pending_bytes = @records.sum(&:bytes)
      if @records.length > @max_size || @pending_bytes > @max_bytes || @records.any? { |record| record.bytes > @max_event_bytes }
        raise SdkError.new("persistent_queue_error", "persistent queue exceeds configured bounds")
      end
      @dropped_events = 0
      @mutex = Mutex.new
    end

    def enqueue(event_id:, event_type:, event:)
      @mutex.synchronize do
        return record_drop(event_id, event_type, "queue_overflow") if @records.length >= @max_size

        serialized = serialize_event(event)
        event_bytes = serialized.bytesize
        return record_drop(event_id, event_type, "event_too_large") if event_bytes > @max_bytes || event_bytes > @max_event_bytes
        return record_drop(event_id, event_type, "queue_overflow") if @pending_bytes + event_bytes > @max_bytes

        storage_record = begin
          @event_store&.append(serialized)
        rescue SdkError => error
          raise error if %w[process_ownership_error persistence_commit_error].include?(error.code)

          return record_drop(event_id, event_type, "persistence_failure")
        end

        @records << EventRecord.new(serialized, event_bytes, storage_record).freeze
        @pending_bytes += event_bytes
        unless storage_record.nil? || storage_record.durable
          raise SdkError.new("persistence_commit_error", "persistent queue admission durability is unconfirmed")
        end

        nil
      end
    end

    def notify_drop(notice)
      return if notice.nil? || @on_event_dropped.nil?

      guards = Thread.current.thread_variable_get(CALLBACK_GUARD_KEY)
      unless guards
        guards = {}
        Thread.current.thread_variable_set(CALLBACK_GUARD_KEY, guards)
      end
      return if guards[object_id]

      guards[object_id] = true
      begin
        @on_event_dropped.call(notice)
      rescue StandardError
        nil
      ensure
        guards.delete(object_id)
        Thread.current.thread_variable_set(CALLBACK_GUARD_KEY, nil) if guards.empty?
      end
    end

    def length
      @mutex.synchronize { @records.length }
    end

    def pending_bytes
      @mutex.synchronize { @pending_bytes }
    end

    def dropped_events
      @mutex.synchronize { @dropped_events }
    end

    def snapshot
      @mutex.synchronize do
        @event_store&.prepare_delivery unless @records.empty?
        Snapshot.new(@records.dup.freeze, @records.length, @pending_bytes).freeze
      end
    end

    def acknowledge(snapshot)
      return nil if snapshot.event_count.zero?

      @mutex.synchronize do
        removed = @records.first(snapshot.event_count)
        compaction_error = @event_store&.acknowledge(removed.map(&:storage_record))
        @records.shift(snapshot.event_count)
        @pending_bytes -= removed.sum(&:bytes)
        compaction_error
      end
    end

    def purge
      @mutex.synchronize do
        return 0 if @records.empty?

        removed = @records.dup
        compaction_error = @event_store&.acknowledge(removed.map(&:storage_record))
        @records.clear
        @pending_bytes = 0
        raise compaction_error unless compaction_error.nil?

        removed.length
      end
    end

    def close
      @event_store&.close
    end

    private

    def validate_positive_integer(label, value)
      return if value.is_a?(Integer) && value.positive?

      raise SdkError.new("validation_error", "#{label} must be a positive integer")
    end

    def serialize_event(event)
      JSON.generate(event).freeze
    rescue JSON::GeneratorError, EncodingError
      raise SdkError.new("validation_error", "event must be JSON serializable")
    end

    def record_drop(event_id, event_type, reason)
      @dropped_events += 1
      DroppedEvent.new(
        event_id: event_id,
        event_type: event_type,
        reason: reason,
        dropped_events: @dropped_events,
        pending_events: @records.length,
        pending_event_bytes: @pending_bytes
      )
    end
  end
  private_constant :BoundedEventQueue
end
