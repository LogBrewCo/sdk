# frozen_string_literal: true

module LogBrew
  # Builders for app-owned product and network timeline action events.
  class ProductTimeline
    private_class_method :new

    def self.product_action(
      name:,
      status: "success",
      route_template: nil,
      session_id: nil,
      trace_id: nil,
      screen: nil,
      funnel: nil,
      step: nil,
      metadata: nil
    )
      action_metadata = timeline_metadata("product_timeline", metadata)
      put_if_present(action_metadata, "routeTemplate", sanitize_optional_route_template("product route_template", route_template))
      put_if_present(action_metadata, "sessionId", optional_label("session_id", session_id))
      put_if_present(action_metadata, "traceId", optional_label("trace_id", trace_id))
      put_if_present(action_metadata, "screen", optional_label("screen", screen))
      put_if_present(action_metadata, "funnel", optional_label("funnel", funnel))
      put_if_present(action_metadata, "step", optional_label("step", step))

      {
        "name" => required_label("product action name", name),
        "status" => normalize_status(status),
        "metadata" => action_metadata
      }
    end

    def self.network_milestone(
      route_template:,
      method: "GET",
      status_code: nil,
      duration_ms: nil,
      status: nil,
      name: nil,
      session_id: nil,
      trace_id: nil,
      metadata: nil
    )
      route = sanitize_route_template("network milestone route_template", route_template)
      normalized_method = normalize_method(method)
      validate_status_code(status_code)
      validate_duration_ms(duration_ms)
      normalized_status = normalize_status(status || (status_code && status_code >= 400 ? "failure" : "success"))

      action_metadata = timeline_metadata("network_timeline", metadata)
      action_metadata["routeTemplate"] = route
      action_metadata["method"] = normalized_method
      put_if_present(action_metadata, "statusCode", status_code)
      put_if_present(action_metadata, "durationMs", duration_ms)
      put_if_present(action_metadata, "sessionId", optional_label("session_id", session_id))
      put_if_present(action_metadata, "traceId", optional_label("trace_id", trace_id))

      {
        "name" => name.nil? ? "network.#{normalized_method.downcase} #{route}" : required_label("network milestone name", name),
        "status" => normalized_status,
        "metadata" => action_metadata
      }
    end

    def self.timeline_metadata(source, metadata)
      copied = { "source" => source }
      validated = Validation.require_metadata(metadata)
      return copied if validated.nil?

      validated.each do |key, value|
        copied[key] = value unless key == "source"
      end
      copied
    end

    def self.required_label(label, value)
      Validation.require_non_empty(label, value)
      value.to_s.strip
    end

    def self.optional_label(label, value)
      return nil if value.nil?

      required_label(label, value)
    end

    def self.normalize_status(status)
      Validation.require_allowed_value("action status", status, LogBrew::ACTION_STATUSES)
      status
    end

    def self.sanitize_optional_route_template(label, route_template)
      return nil if route_template.nil?

      sanitize_route_template(label, route_template)
    end

    def self.sanitize_route_template(label, route_template)
      Validation.require_non_empty(label, route_template)
      trimmed = route_template.to_s.strip
      if trimmed.match?(/\Ahttps?:\/\//i)
        uri = URI.parse(trimmed)
        return uri.path.nil? || uri.path.empty? ? "/" : uri.path
      end

      cutoff = first_present_index(trimmed.index("?"), trimmed.index("#"))
      cutoff.nil? ? trimmed : (trimmed[0...cutoff].rstrip.empty? ? "/" : trimmed[0...cutoff].rstrip)
    rescue URI::InvalidURIError => error
      raise SdkError.new("validation_error", "route_template must be a valid route or URL: #{error.message}")
    end

    def self.normalize_method(method)
      normalized = method.to_s.strip.upcase
      unless normalized.match?(/\A[A-Z0-9_-]+\z/)
        raise SdkError.new("validation_error", "network milestone method must be a valid HTTP method")
      end

      normalized
    end

    def self.validate_status_code(status_code)
      return if status_code.nil?

      unless status_code.is_a?(Integer) && status_code >= 100 && status_code <= 599
        raise SdkError.new("validation_error", "network milestone status_code must be between 100 and 599")
      end
    end

    def self.validate_duration_ms(duration_ms)
      return if duration_ms.nil?
      unless duration_ms.is_a?(Numeric) && duration_ms.finite?
        raise SdkError.new("validation_error", "network milestone duration_ms must be a finite number")
      end
      raise SdkError.new("validation_error", "network milestone duration_ms must be non-negative") if duration_ms.negative?
    end

    def self.put_if_present(metadata, key, value)
      metadata[key] = value unless value.nil?
    end

    def self.first_present_index(first, second)
      return second if first.nil?
      return first if second.nil?

      [first, second].min
    end

    private_class_method :timeline_metadata, :required_label, :optional_label, :normalize_status,
                         :sanitize_optional_route_template, :sanitize_route_template, :normalize_method,
                         :validate_status_code, :validate_duration_ms, :put_if_present, :first_present_index
  end
end
