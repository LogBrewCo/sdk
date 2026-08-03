# frozen_string_literal: true

require "etc"
require "rbconfig"

module LogBrew
  # Immutable schema-v1 resource, trace, session, subject, and tag context.
  class TelemetryContext
    SCHEMA_VERSION = 1
    ROOT_FIELDS = %w[schemaVersion resource trace session subject tags].freeze
    TRACE_FIELDS = %w[traceId spanId parentSpanId sampled].freeze
    SESSION_FIELDS = %w[id previousId].freeze
    SUBJECT_FIELDS = %w[id kind].freeze

    def self.create
      TelemetryContextBuilder.new
    end

    def self.from_hash(value = nil, **keywords)
      if value.nil?
        value = keywords
      elsif !keywords.empty?
        raise TelemetryContextValue.invalid("telemetry context must be one object")
      end
      object = TelemetryContextValue.object(value, "telemetry context")
      TelemetryContextValue.reject_unknown_fields(object, ROOT_FIELDS, "telemetry context")
      unless object["schemaVersion"] == SCHEMA_VERSION
        raise TelemetryContextValue.invalid("telemetry context schemaVersion must be 1")
      end

      normalized = { "schemaVersion" => SCHEMA_VERSION }
      if object.key?("resource")
        normalized["resource"] = TelemetryResource.from_hash(object.fetch("resource")).to_h
      end
      normalized["trace"] = normalize_trace(object.fetch("trace")) if object.key?("trace")
      normalized["session"] = normalize_session(object.fetch("session")) if object.key?("session")
      normalized["subject"] = normalize_subject(object.fetch("subject")) if object.key?("subject")
      normalized["tags"] = normalize_tags(object.fetch("tags")) if object.key?("tags")
      if normalized.length == 1
        raise TelemetryContextValue.invalid(
          "telemetry context must include resource, trace, session, subject, or tags"
        )
      end

      new(normalized)
    end

    # Resource fields and tags merge by field. Trace, session, and subject are replaced.
    def self.merge(base, override)
      require_context_or_nil(base, "base telemetry context")
      require_context_or_nil(override, "override telemetry context")
      return nil if base.nil? && override.nil?
      return from_hash(override.to_h) if base.nil?
      return from_hash(base.to_h) if override.nil?

      base_value = base.to_h
      override_value = override.to_h
      merged = { "schemaVersion" => SCHEMA_VERSION }

      base_resource = resource_from_value(base_value["resource"])
      override_resource = resource_from_value(override_value["resource"])
      resource = TelemetryResource.merge(base_resource, override_resource)
      merged["resource"] = resource.to_h unless resource.nil?

      %w[trace session subject].each do |section|
        value = override_value[section] || base_value[section]
        merged[section] = value unless value.nil?
      end

      base_tags = base_value["tags"] || {}
      override_tags = override_value["tags"] || {}
      unless base_tags.empty? && override_tags.empty?
        tags = base_tags.merge(override_tags)
        TelemetryContextValue.require_tag_count(tags.length)
        merged["tags"] = tags.keys.sort.each_with_object({}) { |key, sorted| sorted[key] = tags.fetch(key) }
      end

      from_hash(merged)
    end

    # Add exact active trace correlation over any existing context.
    def self.with_trace(context, trace)
      require_context_or_nil(context, "telemetry context")
      unless defined?(LogBrew::TraceContext) && trace.is_a?(LogBrew::TraceContext)
        raise TelemetryContextValue.invalid("trace must be a LogBrew::TraceContext")
      end

      trace_context = create.with_trace(trace).build
      merge(context, trace_context)
    end

    # Conservative Ruby runtime, OS-family/release, and architecture identity.
    def self.runtime_defaults
      runtime_name = defined?(RUBY_ENGINE) ? RUBY_ENGINE : "ruby"
      resource = TelemetryResource.create.with_runtime(name: runtime_name, version: RUBY_VERSION)
      uname = safe_uname
      operating_system = normalize_os_name(
        safe_runtime_value(uname && uname[:sysname]) ||
          safe_runtime_value(RbConfig::CONFIG["host_os"])
      )
      operating_system_version = safe_runtime_value(uname && uname[:release])
      architecture = safe_runtime_value(uname && uname[:machine]) ||
                     safe_runtime_value(RbConfig::CONFIG["host_cpu"])
      unless operating_system.nil?
        resource.with_operating_system(name: operating_system, version: operating_system_version)
      end
      resource.with_device(architecture: architecture) unless architecture.nil?
      create.with_resource(resource.build).build
    end

    def to_h
      TelemetryContextValue.deep_copy(@value)
    end

    class << self
      private

      def normalize_trace(value)
        object = TelemetryContextValue.object(value, "telemetry context trace")
        TelemetryContextValue.reject_unknown_fields(object, TRACE_FIELDS, "telemetry context trace")
        unless object.key?("traceId")
          raise TelemetryContextValue.invalid("traceId must be 32 non-zero hex characters")
        end

        normalized = {
          "traceId" => TelemetryContextValue.trace_id(object.fetch("traceId"))
        }
        if object.key?("spanId")
          normalized["spanId"] = TelemetryContextValue.span_id(object.fetch("spanId"), "spanId")
        end
        if object.key?("parentSpanId")
          normalized["parentSpanId"] = TelemetryContextValue.span_id(
            object.fetch("parentSpanId"),
            "parentSpanId"
          )
        end
        if object.key?("sampled")
          sampled = object.fetch("sampled")
          unless sampled == true || sampled == false
            raise TelemetryContextValue.invalid("sampled must be a boolean")
          end
          normalized["sampled"] = sampled
        end
        normalized
      end

      def normalize_session(value)
        object = TelemetryContextValue.object(value, "telemetry context session")
        TelemetryContextValue.reject_unknown_fields(object, SESSION_FIELDS, "telemetry context session")
        unless object.key?("id")
          raise TelemetryContextValue.invalid("session id must be a string")
        end
        id = TelemetryContextValue.required_id(object.fetch("id"), "session id")
        normalized = { "id" => id }
        if object.key?("previousId")
          previous_id = TelemetryContextValue.required_id(
            object.fetch("previousId"),
            "session previousId"
          )
          if previous_id == id
            raise TelemetryContextValue.invalid("session previousId must differ from id")
          end
          normalized["previousId"] = previous_id
        end
        normalized
      end

      def normalize_subject(value)
        object = TelemetryContextValue.object(value, "telemetry context subject")
        TelemetryContextValue.reject_unknown_fields(object, SUBJECT_FIELDS, "telemetry context subject")
        unless object.key?("id")
          raise TelemetryContextValue.invalid("subject id must be a string")
        end
        kind = object["kind"]
        unless %w[anonymous user].include?(kind)
          raise TelemetryContextValue.invalid("subject kind must be anonymous or user")
        end
        {
          "id" => TelemetryContextValue.required_id(object.fetch("id"), "subject id"),
          "kind" => kind
        }
      end

      def normalize_tags(value)
        object = TelemetryContextValue.object(value, "telemetry context tags")
        TelemetryContextValue.require_tag_count(object.length)
        object.keys.sort.each_with_object({}) do |key, normalized|
          normalized_key = TelemetryContextValue.tag_key(key)
          normalized[normalized_key] = TelemetryContextValue.required_string(
            object.fetch(key),
            "tag value for #{normalized_key}"
          )
        end
      end

      def resource_from_value(value)
        value.nil? ? nil : TelemetryResource.from_hash(value)
      end

      def require_context_or_nil(value, label)
        return if value.nil? || value.is_a?(TelemetryContext)

        raise TelemetryContextValue.invalid("#{label} must be a LogBrew::TelemetryContext")
      end

      def safe_uname
        Etc.uname
      rescue StandardError
        nil
      end

      def safe_runtime_value(value)
        return nil if value.nil?

        TelemetryContextValue.required_string(value.to_s, "runtime context value")
      rescue StandardError
        nil
      end

      def normalize_os_name(value)
        return nil if value.nil?

        normalized = value.downcase
        return "darwin" if normalized.include?("darwin") || normalized.include?("mac os")
        return "linux" if normalized.include?("linux")
        return "windows" if normalized.match?(/windows|mswin|mingw|cygwin/)

        normalized
      end
    end

    private

    def initialize(value)
      @value = TelemetryContextValue.deep_freeze(TelemetryContextValue.deep_copy(value))
      freeze
    end
  end

  # Builder for one immutable, privacy-bounded shared telemetry context.
  class TelemetryContextBuilder
    def initialize
      @value = { "schemaVersion" => TelemetryContext::SCHEMA_VERSION }
    end

    def with_resource(resource)
      unless resource.is_a?(TelemetryResource)
        raise TelemetryContextValue.invalid("resource must be a LogBrew::TelemetryResource")
      end
      @value["resource"] = resource.to_h
      self
    end

    def with_trace(trace)
      unless defined?(LogBrew::TraceContext) && trace.is_a?(LogBrew::TraceContext)
        raise TelemetryContextValue.invalid("trace must be a LogBrew::TraceContext")
      end
      with_trace_ids(
        trace_id: trace.trace_id,
        span_id: trace.span_id,
        parent_span_id: trace.parent_span_id,
        sampled: trace.sampled
      )
    end

    def with_trace_ids(trace_id:, span_id: nil, parent_span_id: nil, sampled: nil)
      trace = { "traceId" => trace_id }
      trace["spanId"] = span_id unless span_id.nil?
      trace["parentSpanId"] = parent_span_id unless parent_span_id.nil?
      trace["sampled"] = sampled unless sampled.nil?
      @value["trace"] = trace
      self
    end

    def with_session(id:, previous_id: nil)
      session = { "id" => id }
      session["previousId"] = previous_id unless previous_id.nil?
      @value["session"] = session
      self
    end

    def with_subject(id:, kind:)
      @value["subject"] = { "id" => id, "kind" => kind }
      self
    end

    def with_tag(key, value)
      normalized_key = TelemetryContextValue.tag_key(key.to_s)
      normalized_value = TelemetryContextValue.required_string(value, "tag value for #{normalized_key}")
      tags = (@value["tags"] ||= {})
      tags[normalized_key] = normalized_value
      TelemetryContextValue.require_tag_count(tags.length)
      self
    end

    def with_tags(tags)
      object = TelemetryContextValue.object(tags, "telemetry context tags")
      object.each { |key, value| with_tag(key, value) }
      self
    end

    def build
      TelemetryContext.from_hash(@value)
    end
  end
end
