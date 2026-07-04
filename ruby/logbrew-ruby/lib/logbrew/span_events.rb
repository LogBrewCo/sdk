# frozen_string_literal: true

module LogBrew
  module SpanEvents
    LIMIT = 8
    private_constant :LIMIT

    module_function

    def validate(events)
      return nil if events.nil?
      raise SdkError.new("validation_error", "span events must be an array") unless events.is_a?(Array)
      raise SdkError.new("validation_error", "span events must contain at most #{LIMIT} entries") if events.length > LIMIT
      return nil if events.empty?

      events.map.with_index do |event, index|
        raise SdkError.new("validation_error", "span event #{index} must be an object") unless event.is_a?(Hash)

        event_name = Validation.read(event, "name")
        Validation.require_non_empty("span event name", event_name)
        event_timestamp = Validation.read(event, "timestamp")
        Validation.require_timestamp(event_timestamp) unless event_timestamp.nil?
        event_metadata = Validation.require_metadata(Validation.read(event, "metadata"))

        {
          "name" => event_name
        }.tap do |payload|
          payload["timestamp"] = event_timestamp unless event_timestamp.nil?
          payload["metadata"] = event_metadata unless event_metadata.nil?
        end
      end
    end
  end
end
