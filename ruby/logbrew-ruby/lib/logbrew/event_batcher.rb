# frozen_string_literal: true

module LogBrew
  class EventBatcher
    DEFAULT_MAX_SIZE = 100
    DEFAULT_MAX_BYTES = 262_144
    BATCH_SUFFIX = "]}"

    Batch = Struct.new(:body, :event_count, :event_bytes)
    private_constant :Batch

    attr_reader :max_event_bytes

    def initialize(sdk:, max_size:, max_bytes:)
      validate_positive_integer("max_batch_size", max_size)
      validate_positive_integer("max_batch_bytes", max_bytes)

      @max_size = max_size
      @max_bytes = max_bytes
      @batch_prefix = "{\"sdk\":#{JSON.generate(sdk)},\"events\":["
      @base_bytes = @batch_prefix.bytesize + BATCH_SUFFIX.bytesize
      if @base_bytes >= @max_bytes
        raise SdkError.new("validation_error", "max_batch_bytes must fit the SDK envelope")
      end

      @max_event_bytes = @max_bytes - @base_bytes
    rescue JSON::GeneratorError, EncodingError
      raise SdkError.new("validation_error", "sdk identity must be JSON serializable")
    end

    def next_batch(serialized_events, limit:)
      event_json = []
      event_bytes = 0
      body_bytes = @base_bytes
      maximum = [serialized_events.length, limit, @max_size].min

      maximum.times do |index|
        serialized = serialized_events.fetch(index)
        next_body_bytes = body_bytes + (event_json.empty? ? 0 : 1) + serialized.bytesize
        break if next_body_bytes > @max_bytes

        event_json << serialized
        event_bytes += serialized.bytesize
        body_bytes = next_body_bytes
      end

      if event_json.empty?
        raise SdkError.new("transport_error", "queued event cannot fit the configured batch byte limit")
      end

      Batch.new(
        (@batch_prefix + event_json.join(",") + BATCH_SUFFIX).freeze,
        event_json.length,
        event_bytes
      ).freeze
    end

    private

    def validate_positive_integer(label, value)
      return if value.is_a?(Integer) && value.positive?

      raise SdkError.new("validation_error", "#{label} must be a positive integer")
    end
  end
  private_constant :EventBatcher
end
