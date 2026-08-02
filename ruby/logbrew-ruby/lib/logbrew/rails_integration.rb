# frozen_string_literal: true

require_relative "../logbrew" unless defined?(LogBrew::Client)
require "uri"

module LogBrew
  module Rails
    # Immutable, environment-derived settings for the automatic Rails adapter.
    class Configuration
      DEFAULT_ENDPOINT = LogBrew::HttpTransport::DEFAULT_ENDPOINT
      DEFAULT_REQUEST_TIMEOUT_MS = 10_000
      DEFAULT_FLUSH_INTERVAL_MS = 5_000
      DEFAULT_FLUSH_THRESHOLD = 100
      MAX_LABEL_BYTES = 255
      MAX_ENDPOINT_BYTES = 2_048
      LOOPBACK_HOSTS = %w[localhost 127.0.0.1 ::1 [::1]].freeze

      attr_reader(
        :api_key,
        :service_name,
        :app_environment,
        :rails_version,
        :release,
        :endpoint,
        :request_timeout,
        :flush_interval,
        :flush_threshold
      )

      def self.from_environment(environment, application_name:, rails_environment:, rails_version:)
        unless environment.respond_to?(:[]) && environment.respond_to?(:key?)
          raise SdkError.new("configuration_error", "Rails environment must provide key lookup")
        end

        enabled_setting = boolean_value(environment, "LOGBREW_ENABLED", nil)
        return disabled(application_name, rails_environment, rails_version) if enabled_setting == false

        canonical_key = server_key_value(environment["LOGBREW_SERVER_API_KEY"])
        if canonical_key.nil?
          legacy_present = %w[LOGBREW_API_KEY LOGBREW_INGEST_KEY].any? do |name|
            !optional_text(environment[name]).nil?
          end
          if enabled_setting == true || legacy_present || environment.key?("LOGBREW_SERVER_API_KEY")
            raise SdkError.new(
              "configuration_error",
              "set LOGBREW_SERVER_API_KEY to a non-empty server API key, or set LOGBREW_ENABLED=false"
            )
          end
          return disabled(application_name, rails_environment, rails_version)
        end

        new(
          enabled: true,
          api_key: canonical_key,
          service_name: bounded_label(
            optional_text(environment["LOGBREW_SERVICE_NAME"]) || application_name,
            "LOGBREW_SERVICE_NAME"
          ),
          app_environment: bounded_label(
            optional_text(environment["LOGBREW_ENVIRONMENT"]) || rails_environment,
            "LOGBREW_ENVIRONMENT"
          ),
          rails_version: bounded_label(rails_version, "Rails version"),
          release: optional_bounded_label(environment["LOGBREW_RELEASE"], "LOGBREW_RELEASE"),
          endpoint: endpoint_value(environment["LOGBREW_ENDPOINT"]),
          request_timeout: integer_value(
            environment,
            "LOGBREW_REQUEST_TIMEOUT_MS",
            DEFAULT_REQUEST_TIMEOUT_MS,
            1,
            600_000
          ) / 1_000.0,
          flush_interval: integer_value(
            environment,
            "LOGBREW_FLUSH_INTERVAL_MS",
            DEFAULT_FLUSH_INTERVAL_MS,
            10,
            3_600_000
          ) / 1_000.0,
          flush_threshold: integer_value(
            environment,
            "LOGBREW_FLUSH_THRESHOLD",
            DEFAULT_FLUSH_THRESHOLD,
            1,
            1_000
          ),
          capture_exception_messages: boolean_value(
            environment,
            "LOGBREW_CAPTURE_EXCEPTION_MESSAGES",
            false
          ),
          include_exception_backtrace: boolean_value(
            environment,
            "LOGBREW_INCLUDE_EXCEPTION_BACKTRACE",
            false
          )
        )
      end

      def self.disabled(application_name, rails_environment, rails_version)
        new(
          enabled: false,
          api_key: nil,
          service_name: bounded_label(application_name, "Rails application name"),
          app_environment: bounded_label(rails_environment, "Rails environment"),
          rails_version: bounded_label(rails_version, "Rails version"),
          release: nil,
          endpoint: DEFAULT_ENDPOINT,
          request_timeout: DEFAULT_REQUEST_TIMEOUT_MS / 1_000.0,
          flush_interval: DEFAULT_FLUSH_INTERVAL_MS / 1_000.0,
          flush_threshold: DEFAULT_FLUSH_THRESHOLD,
          capture_exception_messages: false,
          include_exception_backtrace: false
        )
      end

      def self.optional_text(value)
        return nil if value.nil?

        text = value.to_s.strip
        text.empty? ? nil : text
      end
      private_class_method :optional_text

      def self.server_key_value(value)
        text = optional_text(value)
        return nil if text.nil?
        if text.bytesize > 4_096 || !text.valid_encoding?
          raise SdkError.new("configuration_error", "LOGBREW_SERVER_API_KEY is invalid")
        end

        text
      end
      private_class_method :server_key_value

      def self.bounded_label(value, label)
        text = optional_text(value)
        raise SdkError.new("configuration_error", "#{label} must be non-empty") if text.nil?
        if text.bytesize > MAX_LABEL_BYTES || !text.valid_encoding? || text.match?(/[[:cntrl:]]/)
          raise SdkError.new("configuration_error", "#{label} must be at most #{MAX_LABEL_BYTES} bytes")
        end

        text.freeze
      end
      private_class_method :bounded_label

      def self.optional_bounded_label(value, label)
        text = optional_text(value)
        return nil if text.nil?

        bounded_label(text, label)
      end
      private_class_method :optional_bounded_label

      def self.boolean_value(environment, name, default)
        value = optional_text(environment[name])
        return default if value.nil? && !environment.key?(name)

        case value&.downcase
        when "true", "1", "yes", "on" then true
        when "false", "0", "no", "off" then false
        else
          raise SdkError.new("configuration_error", "#{name} must be true or false")
        end
      end
      private_class_method :boolean_value

      def self.integer_value(environment, name, default, minimum, maximum)
        text = optional_text(environment[name])
        return default if text.nil? && !environment.key?(name)

        value = Integer(text, 10)
        return value if value >= minimum && value <= maximum

        raise ArgumentError
      rescue ArgumentError, TypeError
        raise SdkError.new(
          "configuration_error",
          "#{name} must be an integer between #{minimum} and #{maximum}"
        )
      end
      private_class_method :integer_value

      def self.endpoint_value(value)
        text = optional_text(value) || DEFAULT_ENDPOINT
        if text.bytesize > MAX_ENDPOINT_BYTES
          raise SdkError.new("configuration_error", "LOGBREW_ENDPOINT is too long")
        end

        uri = URI.parse(text)
        valid_http = uri.is_a?(URI::HTTP) && !uri.host.to_s.empty?
        safe_scheme = uri.scheme == "https" || (
          uri.scheme == "http" && LOOPBACK_HOSTS.include?(uri.host.to_s.downcase)
        )
        if !valid_http || !safe_scheme || !uri.userinfo.nil? || !uri.fragment.nil?
          raise SdkError.new(
            "configuration_error",
            "LOGBREW_ENDPOINT must use https, or http on localhost, without embedded user info or a fragment"
          )
        end

        uri.to_s.freeze
      rescue URI::InvalidURIError
        raise SdkError.new("configuration_error", "LOGBREW_ENDPOINT must be a valid HTTP URL")
      end
      private_class_method :endpoint_value

      def initialize(
        enabled:,
        api_key:,
        service_name:,
        app_environment:,
        rails_version:,
        release:,
        endpoint:,
        request_timeout:,
        flush_interval:,
        flush_threshold:,
        capture_exception_messages:,
        include_exception_backtrace:
      )
        @enabled = enabled
        @api_key = api_key&.dup&.freeze
        @service_name = service_name
        @app_environment = app_environment
        @rails_version = rails_version
        @release = release
        @endpoint = endpoint
        @request_timeout = request_timeout
        @flush_interval = flush_interval
        @flush_threshold = flush_threshold
        @capture_exception_messages = capture_exception_messages
        @include_exception_backtrace = include_exception_backtrace
        freeze
      end

      def enabled?
        @enabled
      end

      def capture_exception_messages?
        @capture_exception_messages
      end

      def include_exception_backtrace?
        @include_exception_backtrace
      end
    end

    # Owns one lazy automatic-delivery client per operating-system process.
    class Runtime
      attr_reader :configuration

      def initialize(
        configuration,
        transport_factory: nil,
        client_factory: nil,
        timestamp_provider: nil,
        process_id_provider: nil,
        on_error: nil
      )
        unless configuration.is_a?(Configuration)
          raise SdkError.new("configuration_error", "Rails runtime requires a Rails configuration")
        end

        @configuration = configuration
        @transport_factory = transport_factory || method(:build_transport)
        @client_factory = client_factory || method(:build_client)
        @timestamp_provider = timestamp_provider || -> { Time.now.utc }
        @process_id_provider = process_id_provider || -> { Process.pid }
        @on_error = on_error
        @mutex = Mutex.new
        @state_process_id = @process_id_provider.call
        @client = nil
        @shutdown_response = nil
      end

      def client
        return nil unless @configuration.enabled?

        prepare_process_state
        @mutex.synchronize do
          return nil unless @shutdown_response.nil?

          @client ||= create_client
        end
      rescue StandardError => error
        report_error("client_initialization", error)
        nil
      end

      def delivery_health
        active_client = client
        active_client&.delivery_health
      rescue StandardError => error
        report_error("delivery_health", error)
        nil
      end

      def shutdown
        return nil unless @configuration.enabled?

        prepare_process_state
        @mutex.synchronize do
          return @shutdown_response unless @shutdown_response.nil?
          return nil if @client.nil?

          @shutdown_response = @client.shutdown
        end
      rescue StandardError => error
        report_error("shutdown", error)
        nil
      end

      def report_error(stage, error)
        return unless @on_error.respond_to?(:call)

        @on_error.call(stage.to_s, error)
      rescue StandardError
        nil
      end

      private

      def prepare_process_state
        process_id = @process_id_provider.call
        return if @state_process_id == process_id

        @mutex = Mutex.new
        @client = nil
        @shutdown_response = nil
        @state_process_id = process_id
      end

      def create_client
        transport = @transport_factory.call(@configuration)
        created = @client_factory.call(@configuration, transport)
        record_process_context(created)
        created
      end

      def build_transport(configuration)
        LogBrew::HttpTransport.new(
          endpoint: configuration.endpoint,
          timeout: configuration.request_timeout
        )
      end

      def build_client(configuration, transport)
        LogBrew::Client.create_automatic(
          api_key: configuration.api_key,
          sdk_name: "logbrew-ruby-rails",
          sdk_version: LogBrew::VERSION,
          transport: transport,
          flush_interval: configuration.flush_interval,
          flush_threshold: configuration.flush_threshold
        )
      end

      def record_process_context(created)
        timestamp = logbrew_timestamp
        metadata = base_metadata
        created.environment(
          "ruby_rails_environment_#{SecureRandom.hex(8)}",
          timestamp,
          name: @configuration.app_environment,
          metadata: metadata
        )
        return if @configuration.release.nil?

        created.release(
          "ruby_rails_release_#{SecureRandom.hex(8)}",
          timestamp,
          version: @configuration.release,
          metadata: metadata
        )
      end

      def base_metadata
        {
          "service" => @configuration.service_name,
          "environment" => @configuration.app_environment,
          "framework" => "rails",
          "framework.version" => @configuration.rails_version
        }
      end

      def logbrew_timestamp
        timestamp = @timestamp_provider.call
        return timestamp.iso8601 if timestamp.respond_to?(:iso8601)

        timestamp.to_s
      end
    end

    # Internal Rack adapter that replaces concrete request paths with Rails
    # route templates while reusing the core request/error lifecycle.
    class RailsRackMiddleware < LogBrew::RackMiddleware
      private

      def exception_mechanism_type
        "rails.middleware"
      end

      def exception_grouping_prefix
        "rails-exception"
      end

      def request_name(env)
        "#{request_method(env)} #{route_template(env)}"
      end

      def request_method(env)
        value = env_value(env, "REQUEST_METHOD").to_s.upcase
        value.match?(/\A[A-Z]{1,16}\z/) ? value : "GET"
      end

      def request_path(env)
        route_template(env)
      end

      def request_metadata(env, status_code)
        metadata = super
        metadata.delete("http.path")
        metadata.delete("action_dispatch.request_id")
        metadata.delete("HTTP_X_REQUEST_ID")
        metadata["source"] = "rails"
        metadata["http.method"] = request_method(env)
        metadata["http.route"] = route_template(env)
        metadata["http.status_code"] = status_code
        metadata["http.status_class"] = "#{status_code.to_i / 100}xx"
        controller, action = controller_and_action(env)
        metadata["rails.controller"] = controller unless controller.nil?
        metadata["rails.action"] = action unless action.nil?
        metadata
      end

      def route_template(env)
        route = bounded_route(env_value(env, "action_dispatch.route_uri_pattern"))
        return route unless route.nil?

        route = bounded_route(matched_route_pattern(env))
        return route unless route.nil?

        controller, action = controller_and_action(env)
        return "/#{controller}##{action}" unless controller.nil? || action.nil?

        "<unmatched>"
      end

      def matched_route_pattern(env)
        return nil unless env.respond_to?(:[])

        route = env["action_dispatch.route"]
        return nil unless route.respond_to?(:path)

        path = route.path
        return nil unless path.respond_to?(:spec)

        path.spec.to_s
      rescue StandardError
        nil
      end

      def controller_and_action(env)
        return [nil, nil] unless env.respond_to?(:[])

        parameters = env["action_dispatch.request.path_parameters"]
        return [nil, nil] unless parameters.is_a?(Hash)

        [bounded_identifier(parameters[:controller] || parameters["controller"]),
         bounded_identifier(parameters[:action] || parameters["action"])]
      end

      def bounded_route(value)
        return nil if value.nil?

        route = value.to_s.split(/[?#]/, 2).first.to_s.strip
        return nil if route.empty? || route.bytesize > 255 || !route.valid_encoding?

        route.start_with?("/") ? route : "/#{route}"
      end

      def bounded_identifier(value)
        return nil if value.nil?

        identifier = value.to_s
        return nil unless identifier.match?(/\A[a-zA-Z0-9_\/.-]{1,128}\z/)

        identifier
      end
    end
    private_constant :RailsRackMiddleware

    # Rails middleware entry point. Capture failures never call the app twice.
    class RequestMiddleware
      def initialize(app, runtime: LogBrew::Rails.runtime)
        raise SdkError.new("validation_error", "Rails app must respond to call") unless app.respond_to?(:call)
        raise SdkError.new("configuration_error", "LogBrew Rails runtime is not installed") if runtime.nil?

        @app = app
        @runtime = runtime
        @mutex = Mutex.new
        @adapter_client = nil
        @adapter = nil
      end

      def call(environment)
        active_client = @runtime.client
        return @app.call(environment) if active_client.nil?

        adapter = adapter_for(active_client)
        return @app.call(environment) if adapter.nil?

        adapter.call(environment)
      end

      private

      def adapter_for(active_client)
        @mutex.synchronize do
          return @adapter if @adapter_client.equal?(active_client) && !@adapter.nil?

          @adapter = RailsRackMiddleware.new(
            @app,
            client: active_client,
            flush_on_response: false,
            metadata: base_metadata,
            include_exception_message: @runtime.configuration.capture_exception_messages?,
            include_exception_backtrace: @runtime.configuration.include_exception_backtrace?,
            on_error: ->(error) { @runtime.report_error("request_capture", error) }
          )
          @adapter_client = active_client
          @adapter
        end
      rescue StandardError => error
        @runtime.report_error("request_adapter", error)
        nil
      end

      def base_metadata
        configuration = @runtime.configuration
        {
          "service" => configuration.service_name,
          "environment" => configuration.app_environment,
          "framework" => "rails",
          "framework.version" => configuration.rails_version
        }.tap do |metadata|
          metadata["release"] = configuration.release unless configuration.release.nil?
        end
      end
    end

    # Rails.error subscriber for handled reports. Unhandled errors stay owned
    # by the request middleware so one exception cannot create two issues.
    class ErrorReporter
      CONTEXT_KEYS = %w[controller action].freeze

      def initialize(runtime)
        @runtime = runtime
        @mutex = Mutex.new
        @subscriber_client = nil
        @subscriber = nil
      end

      def report(error, handled: true, severity: :error, context: nil, source: nil, **options)
        return nil unless handled

        active_client = @runtime.client
        return nil if active_client.nil?

        subscriber_for(active_client).report(
          error,
          handled: true,
          severity: severity,
          context: safe_context(context),
          source: bounded_source(source),
          **options
        )
      rescue StandardError => capture_error
        @runtime.report_error("handled_error_capture", capture_error)
        nil
      end

      private

      def subscriber_for(active_client)
        @mutex.synchronize do
          return @subscriber if @subscriber_client.equal?(active_client) && !@subscriber.nil?

          configuration = @runtime.configuration
          @subscriber = LogBrew::RailsErrorSubscriber.new(
            client: active_client,
            flush_on_report: false,
            metadata: {
              "service" => configuration.service_name,
              "environment" => configuration.app_environment,
              "framework" => "rails",
              "framework.version" => configuration.rails_version
            },
            include_exception_message: configuration.capture_exception_messages?,
            include_exception_backtrace: configuration.include_exception_backtrace?,
            on_error: ->(error) { @runtime.report_error("handled_error_capture", error) }
          )
          @subscriber_client = active_client
          @subscriber
        end
      end

      def safe_context(context)
        return nil unless context.is_a?(Hash)

        CONTEXT_KEYS.each_with_object({}) do |key, safe|
          value = context[key] || context[key.to_sym]
          next if value.nil?

          text = value.to_s
          safe[key] = text if text.match?(/\A[a-zA-Z0-9_\/.-]{1,128}\z/)
        end
      end

      def bounded_source(source)
        return nil if source.nil?

        value = source.to_s
        value.match?(/\A[a-zA-Z0-9_.:-]{1,64}\z/) ? value : "rails"
      end
    end
  end
end
