# frozen_string_literal: true

module LogBrew
  # Immutable service, deployment, runtime, framework, OS, device, and app identity.
  class TelemetryResource
    SECTION_FIELDS = {
      "service" => %w[name version].freeze,
      "deployment" => %w[environment release].freeze,
      "runtime" => %w[name version].freeze,
      "framework" => %w[name version].freeze,
      "operatingSystem" => %w[name version build].freeze,
      "device" => %w[family model architecture].freeze,
      "application" => %w[name version build].freeze
    }.freeze
    NAME_REQUIRED_SECTIONS = %w[service runtime framework operatingSystem].freeze

    def self.create
      TelemetryResourceBuilder.new
    end

    def self.from_hash(value = nil, **keywords)
      if value.nil?
        value = keywords
      elsif !keywords.empty?
        raise TelemetryContextValue.invalid("telemetry resource must be one object")
      end
      object = TelemetryContextValue.object(value, "telemetry resource")
      TelemetryContextValue.reject_unknown_fields(object, SECTION_FIELDS.keys, "telemetry resource")
      raise TelemetryContextValue.invalid("telemetry resource must not be empty") if object.empty?

      normalized = {}
      SECTION_FIELDS.each do |section_name, fields|
        next unless object.key?(section_name)

        section = TelemetryContextValue.object(
          object.fetch(section_name),
          "telemetry resource #{section_name}"
        )
        TelemetryContextValue.reject_unknown_fields(
          section,
          fields,
          "telemetry resource #{section_name}"
        )
        normalized_section = {}
        fields.each do |field|
          next unless section.key?(field)

          normalized_section[field] = TelemetryContextValue.required_string(
            section.fetch(field),
            "telemetry resource #{section_name} #{field}"
          )
        end
        if NAME_REQUIRED_SECTIONS.include?(section_name) && !normalized_section.key?("name")
          raise TelemetryContextValue.invalid("telemetry resource #{section_name} name is required")
        end
        if normalized_section.empty?
          raise TelemetryContextValue.invalid("telemetry resource #{section_name} must not be empty")
        end
        normalized[section_name] = normalized_section
      end

      new(normalized)
    end

    def self.merge(base, override)
      require_resource_or_nil(base, "base telemetry resource")
      require_resource_or_nil(override, "override telemetry resource")
      return nil if base.nil? && override.nil?
      return from_hash(override.to_h) if base.nil?
      return from_hash(base.to_h) if override.nil?

      base_value = base.to_h
      override_value = override.to_h
      merged = {}
      SECTION_FIELDS.each_key do |section|
        base_section = base_value[section]
        override_section = override_value[section]
        next if base_section.nil? && override_section.nil?

        merged[section] = (base_section || {}).merge(override_section || {})
      end
      from_hash(merged)
    end

    def to_h
      TelemetryContextValue.deep_copy(@value)
    end

    private

    def initialize(value)
      @value = TelemetryContextValue.deep_freeze(TelemetryContextValue.deep_copy(value))
      freeze
    end

    def self.require_resource_or_nil(value, label)
      return if value.nil? || value.is_a?(TelemetryResource)

      raise TelemetryContextValue.invalid("#{label} must be a LogBrew::TelemetryResource")
    end
    private_class_method :require_resource_or_nil
  end

  # Builder for one immutable telemetry resource.
  class TelemetryResourceBuilder
    def initialize
      @value = {}
    end

    def with_service(name:, version: nil)
      @value["service"] = named_version(name, version)
      self
    end

    def with_deployment(environment: nil, release: nil)
      @value["deployment"] = optional_fields(environment: environment, release: release)
      self
    end

    def with_runtime(name:, version: nil)
      @value["runtime"] = named_version(name, version)
      self
    end

    def with_framework(name:, version: nil)
      @value["framework"] = named_version(name, version)
      self
    end

    def with_operating_system(name:, version: nil, build: nil)
      @value["operatingSystem"] = optional_fields(name: name, version: version, build: build)
      self
    end

    def with_device(family: nil, model: nil, architecture: nil)
      @value["device"] = optional_fields(family: family, model: model, architecture: architecture)
      self
    end

    def with_application(name: nil, version: nil, build: nil)
      @value["application"] = optional_fields(name: name, version: version, build: build)
      self
    end

    def build
      TelemetryResource.from_hash(@value)
    end

    private

    def named_version(name, version)
      optional_fields(name: name, version: version)
    end

    def optional_fields(**values)
      values.each_with_object({}) do |(key, value), section|
        section[key.to_s] = value unless value.nil?
      end
    end
  end
end
