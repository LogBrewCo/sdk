# frozen_string_literal: true

require_relative "../logbrew" unless defined?(LogBrew::Client)
require_relative "queue_carrier"
require "uri"

module LogBrew
  module Rails
    singleton_class.attr_reader :runtime

    # Immutable, environment-derived settings for the automatic Rails adapter.
    class Configuration
      DEFAULT_ENDPOINT = LogBrew::HttpTransport::DEFAULT_ENDPOINT
      DEFAULT_REQUEST_TIMEOUT_MS = 10_000
      DEFAULT_FLUSH_INTERVAL_MS = 5_000
      DEFAULT_FLUSH_THRESHOLD = 100
      MAX_LABEL_BYTES = 255
      MAX_ENDPOINT_BYTES = 2_048
      LOOPBACK_HOSTS = %w[localhost 127.0.0.1 ::1 [::1]].freeze

      ATTRIBUTES = %i[
        enabled api_key service_name app_environment rails_version release endpoint
        request_timeout flush_interval flush_threshold capture_exception_messages
        capture_rails_logs include_exception_backtrace
      ].freeze
      private_constant :ATTRIBUTES
      attr_reader(*ATTRIBUTES.drop(1).reject { |name| name.to_s.start_with?("capture_", "include_") })

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
          capture_rails_logs: boolean_value(environment, "LOGBREW_CAPTURE_RAILS_LOGS", false),
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
          capture_rails_logs: false,
          include_exception_backtrace: false
        )
      end

      def self.optional_text(value)
        return nil if value.nil?

        text = value.to_s.strip
        text.empty? ? nil : text
      end

      def self.server_key_value(value)
        text = optional_text(value)
        return nil if text.nil?
        if text.bytesize > 4_096 || !text.valid_encoding?
          raise SdkError.new("configuration_error", "LOGBREW_SERVER_API_KEY is invalid")
        end

        text
      end

      def self.bounded_label(value, label)
        text = optional_text(value)
        raise SdkError.new("configuration_error", "#{label} must be non-empty") if text.nil?
        if text.bytesize > MAX_LABEL_BYTES || !text.valid_encoding? || text.match?(/[[:cntrl:]]/)
          raise SdkError.new("configuration_error", "#{label} must be at most #{MAX_LABEL_BYTES} bytes")
        end

        text.freeze
      end

      def self.optional_bounded_label(value, label)
        text = optional_text(value)
        return nil if text.nil?

        bounded_label(text, label)
      end

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
      private_class_method :optional_text, :server_key_value, :bounded_label,
                           :optional_bounded_label, :boolean_value, :integer_value, :endpoint_value

      def initialize(**attributes)
        raise ArgumentError, "Rails configuration attributes do not match" unless attributes.keys.sort == ATTRIBUTES.sort

        ATTRIBUTES.each { |name| instance_variable_set("@#{name}", attributes.fetch(name)) }
        @api_key = @api_key&.dup&.freeze
        freeze
      end

      def enabled?
        @enabled
      end

      def capture_exception_messages?
        @capture_exception_messages
      end

      def capture_rails_logs?
        @capture_rails_logs
      end

      def include_exception_backtrace?
        @include_exception_backtrace
      end
    end

    # Owns one lazy automatic-delivery client per operating-system process.
    class Runtime
      include CaptureHelpers
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

      def metadata
        @metadata ||= {
          "service" => @configuration.service_name,
          "environment" => @configuration.app_environment,
          "framework" => "rails",
          "framework.version" => @configuration.rails_version,
          "release" => @configuration.release
        }.compact.freeze
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
          flush_threshold: configuration.flush_threshold,
          context: client_context(configuration)
        )
      end

      def client_context(configuration)
        resource = LogBrew::TelemetryResource.create
          .with_service(name: configuration.service_name)
          .with_deployment(
            environment: configuration.app_environment,
            release: configuration.release
          )
          .with_framework(name: "rails", version: configuration.rails_version)
          .build
        LogBrew::TelemetryContext.create.with_resource(resource).build
      end

      def record_process_context(created)
        timestamp = logbrew_timestamp
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
    end

    # Adds one bounded, trace-aware LogBrew sink without replacing the app logger.
    module ApplicationLogCapture
      MAX_MESSAGE_CHARACTERS = 2_048
      SINK_IVAR = :@logbrew_rails_log_sink
      ROOT_IVAR = :@logbrew_rails_application_root
      GUARD_KEY = :logbrew_rails_log_capture
      ORIGIN_KEY = :logbrew_rails_log_origin
      LIBRARY_ROOT = File.expand_path("..", __dir__)
      LOGGER_PATH = ::Logger.instance_method(:add).source_location&.first
      LOGGER_WRAPPER_PATH = %r{/active_support/(?:broadcast_logger|tagged_logging|logger(?:_silence|_thread_safe_level)?)\.rb\z}
      GEM_ROOTS = (defined?(::Gem) ? ::Gem.path : []).map { |root| "#{File.expand_path(root)}#{File::SEPARATOR}" }.freeze
      LEVELS = LogBrew::Logger::SEVERITY_TO_LOGBREW_LEVEL
      private_constant :MAX_MESSAGE_CHARACTERS, :SINK_IVAR, :ROOT_IVAR, :GUARD_KEY, :ORIGIN_KEY,
                       :LIBRARY_ROOT, :LOGGER_PATH, :LOGGER_WRAPPER_PATH, :GEM_ROOTS, :LEVELS

      class Sink < ::Logger
        def initialize(runtime, application_root, level)
          @runtime = runtime
          @application_root = File.expand_path(application_root.to_s)
          super(File::NULL)
          self.level = level
        end

        def add(severity, message = nil, progname = nil)
          severity ||= ::Logger::UNKNOWN
          return true if severity < level

          resolved = message.nil? ? (block_given? ? yield : progname) : message
          ApplicationLogCapture.capture(@runtime, @application_root, severity, resolved)
          true
        end
      end
      private_constant :Sink

      module LoggerTap
        def add(severity, message = nil, progname = nil, &block)
          severity ||= ::Logger::UNKNOWN
          configured_progname = respond_to?(:progname) ? self.progname : nil
          captured = message.nil? && block.nil? ? (progname || configured_progname) : message
          wrapped = block && proc { captured = block.call }
          result = super(severity, message, progname, &wrapped)
          sink = instance_variable_get(SINK_IVAR)
          if sink && severity >= level
            sink.level = level
            sink.add(severity, captured)
          end
          result
        end
      end
      private_constant :LoggerTap

      module BroadcastOrigin
        def dispatch(...)
          previous = Thread.current[ORIGIN_KEY]
          origin = ApplicationLogCapture.application_caller?(instance_variable_get(ROOT_IVAR))
          Thread.current[ORIGIN_KEY] = origin
          super
        ensure
          Thread.current[ORIGIN_KEY] = previous
        end
        private :dispatch
      end
      private_constant :BroadcastOrigin

      module_function

      def install(logger, runtime, application_root: nil)
        return logger unless runtime.configuration.capture_rails_logs?
        return logger if application_root.nil?
        return logger unless logger.respond_to?(:add) || logger.respond_to?(:broadcast_to)
        return logger unless logger.instance_variable_get(SINK_IVAR).nil?

        level = logger.respond_to?(:level) ? logger.level : ::Logger::DEBUG
        root = File.expand_path(application_root.to_s)
        sink = Sink.new(runtime, root, level)
        if logger.respond_to?(:broadcast_to)
          logger.instance_variable_set(ROOT_IVAR, root)
          logger.singleton_class.prepend(BroadcastOrigin)
          logger.broadcast_to(sink)
        else
          logger.singleton_class.prepend(LoggerTap)
        end
        logger.instance_variable_set(SINK_IVAR, sink)
        logger
      rescue StandardError => error
        runtime.report_error("application_log_installation", error)
        logger
      end

      def capture(runtime, application_root, severity, message)
        return if LogBrew::Trace.current.nil? || Thread.current[GUARD_KEY]
        origin = Thread.current[ORIGIN_KEY]
        origin = application_caller?(application_root) if origin.nil?
        return unless origin

        Thread.current[GUARD_KEY] = true
        begin
          client = runtime.client
          return if client.nil?

          text = message.is_a?(String) ? message : message.inspect
          truncated = text.length > MAX_MESSAGE_CHARACTERS
          metadata = runtime.metadata.merge(
            "source" => "rails.logger",
            "rubySeverity" => ::Logger::SEV_LABEL[severity.to_i] || "ANY",
            "messageState" => truncated ? "truncated" : "captured"
          )
          client.log(
            "ruby_rails_log_#{SecureRandom.hex(8)}",
            Time.now.utc.iso8601(6),
            message: text[0, MAX_MESSAGE_CHARACTERS],
            level: LEVELS.fetch(severity.to_i, severity.to_i >= ::Logger::FATAL ? "critical" : "info"),
            logger: "rails",
            metadata: metadata
          )
        rescue StandardError => error
          runtime.report_error("application_log_capture", error)
        ensure
          Thread.current[GUARD_KEY] = false
        end
      end

      def application_caller?(application_root)
        location = caller_locations(2, 24).find do |caller|
          path = caller.absolute_path || caller.path
          path && !path.start_with?(LIBRARY_ROOT) && path != LOGGER_PATH && !path.match?(LOGGER_WRAPPER_PATH)
        end
        return false if location.nil?

        path = File.expand_path(location.absolute_path || location.path)
        return false if GEM_ROOTS.any? { |root| path.start_with?(root) }

        path == application_root || path.start_with?("#{application_root}#{File::SEPARATOR}")
      rescue StandardError
        false
      end
    end
    private_constant :ApplicationLogCapture

    # Adds bounded child spans to Net::HTTP calls made inside an active Rails trace.
    module OutboundHttp
      module Request
        def request(request, body = nil, &block)
          runtime = LogBrew::Rails.runtime
          client = LogBrew::Trace.current && runtime&.client
          return super unless client

          LogBrew::HttpClientTracing.capture_net_http(
            self,
            request,
            client: client,
            on_capture_error: ->(error) { runtime.report_error("outbound_http_capture", error) }
          ) { super(request, body, &block) }
        end
      end

      module_function

      def install
        Net::HTTP.prepend(Request) unless Net::HTTP.ancestors.include?(Request)
      end
    end

    # One privacy-bounded producer or worker operation for ActiveJob.
    class ActiveJobOperation
      attr_reader :context

      def self.create(runtime, job, kind, carrier: nil)
        client = runtime&.client
        return if client.nil?

        new(runtime, client, job, kind, carrier)
      rescue StandardError => error
        runtime&.report_error("active_job_capture", error)
        nil
      end

      def initialize(runtime, client, job, kind, carrier)
        @runtime = runtime
        @client = client
        @kind = kind
        @context = kind == :enqueue ? OperationTracing.child_context : QueueCarrier.child_context(QueueCarrier.read(carrier))
        @job_class = bounded_identifier(job.class.name, "ActiveJob")
        @adapter = bounded_identifier(job.class.respond_to?(:queue_adapter_name) ? job.class.queue_adapter_name : nil, "active_job")
        @retry_count = normalized_retry_count(job.respond_to?(:executions) ? job.executions : nil)
        @queue_wait_ms = kind == :perform ? QueueCarrier.queue_wait_ms(QueueCarrier.read(carrier)) : nil
        @started_at = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        @timestamp = Time.now.utc.iso8601(6)
        @finished = false
      end

      def around
        result = Trace.with_context(@context) { yield }
        finish
        result
      rescue Exception => error # rubocop:disable Lint/RescueException
        finish(error)
        raise
      end

      def finish(error = nil)
        return if @finished

        @finished = true
        options = {
          timestamp: @timestamp,
          source: "rails.active_job",
          system: @adapter,
          operation: @kind.to_s,
          metadata: operation_metadata
        }
        OperationTracing.capture_span(@client, "queue", "active_job.#{@kind}", @context, @started_at, options, error)
      rescue StandardError => capture_error
        @runtime.report_error("active_job_capture", capture_error)
      end

      def capture_terminal_issue(error)
        return unless error.is_a?(StandardError)

        metadata = operation_metadata.merge(
          "source" => "rails.active_job",
          "handled" => false,
          "mechanism" => "rails.active_job",
          "issueGroupingKey" => grouping_key(error),
          "issueGroupingSource" => "exception_type_job_file"
        )
        attributes = IssueDiagnostics.from_exception(
          error,
          title: IssueDiagnostics.safe_exception_type(error),
          message: @runtime.configuration.capture_exception_messages? ? error.message : nil,
          mechanism_type: "rails.active_job",
          handled: false,
          metadata: metadata
        )
        Trace.with_context(@context) do
          @client.issue("ruby_active_job_issue_#{@context.span_id}", Time.now.utc.iso8601, attributes)
        end
      rescue StandardError => capture_error
        @runtime.report_error("active_job_capture", capture_error)
      end

      private

      def operation_metadata
        @runtime.metadata.merge("activeJob.class" => @job_class).tap do |metadata|
          metadata["retryCount"] = @retry_count unless @retry_count.nil?
          metadata["queueWaitMs"] = @queue_wait_ms unless @queue_wait_ms.nil?
        end
      end

      def grouping_key(error)
        frame = IssueDiagnostics.stack_frames_from_exception(error).first
        file = frame.nil? ? "" : frame.fetch("filename")
        values = [IssueDiagnostics.safe_exception_type(error), @job_class, file]
        "rails-active-job-#{Digest::SHA256.hexdigest(values.join("\n"))}"
      end

      def bounded_identifier(value, fallback)
        text = value.to_s
        text.match?(/\A[A-Za-z_][A-Za-z0-9_:.-]{0,254}\z/) ? text : fallback
      end

      def normalized_retry_count(value)
        [[value, 0].max, 1_000].min if value.is_a?(Integer)
      end
    end
    private_constant :ActiveJobOperation

    # Adapter-neutral ActiveJob tracing installed through the Rails lazy-load hook.
    module ActiveJobExtension
      def enqueue(options = {})
        operation = ActiveJobOperation.create(LogBrew::Rails.runtime, self, :enqueue)
        return super if operation.nil?

        previous = @logbrew_enqueue_operation
        @logbrew_enqueue_operation = operation
        operation.around { super }
      ensure
        @logbrew_enqueue_operation = previous unless operation.nil?
      end

      def serialize
        payload = super
        operation = @logbrew_enqueue_operation
        return payload if operation.nil?

        begin
          payload[QueueCarrier::KEY] = QueueCarrier.create(operation.context)
        rescue StandardError => error
          LogBrew::Rails.runtime&.report_error("active_job_capture", error)
        end
        payload
      end

      def deserialize(payload)
        result = super
        begin
          @logbrew_queue_carrier = QueueCarrier.read(payload[QueueCarrier::KEY]) if payload.is_a?(Hash)
        rescue StandardError => error
          LogBrew::Rails.runtime&.report_error("active_job_capture", error)
        end
        result
      end

      def perform_now
        operation = ActiveJobOperation.create(LogBrew::Rails.runtime, self, :perform, carrier: @logbrew_queue_carrier)
        return super if operation.nil?

        previous = @logbrew_perform_operation
        @logbrew_perform_operation = operation
        begin
          Trace.with_context(operation.context) { super }
        rescue Exception => error # rubocop:disable Lint/RescueException
          operation.finish(error)
          operation.capture_terminal_issue(error)
          raise
        ensure
          unless operation.nil?
            operation.finish
            @logbrew_perform_operation = previous
          end
        end
      end

      def _perform_job
        operation = @logbrew_perform_operation
        operation.nil? ? super : operation.around { super }
      end
    end

    # Buffers only the slowest request-local framework operations without raw
    # SQL, cache keys, absolute paths, or exception messages.
    module RequestOperations
      LIMIT = 8
      STATE_KEY = :logbrew_rails_request_operations
      EVENTS = /\A(?:(sql)\.active_record|(cache)_(read|write|delete|exist\?|fetch_hit|generate)\.active_support|(render)_(template|partial|collection)\.action_view)\z/
      private_constant :LIMIT, :STATE_KEY, :EVENTS

      module_function

      def install(notifications)
        @mutex ||= Mutex.new
        @mutex.synchronize { @subscription ||= notifications.subscribe(EVENTS) { |*event| record(*event) } }
      end

      def within
        previous = Thread.current[STATE_KEY]
        Thread.current[STATE_KEY] = [0, []]
        yield
      ensure
        Thread.current[STATE_KEY] = previous
      end

      def record(name, started_at, finished_at, _id = nil, payload = {})
        state = Thread.current[STATE_KEY]
        match = EVENTS.match(name.to_s)
        return if state.nil? || match.nil? || !payload.is_a?(Hash)
        duration_ms = ((finished_at - started_at) * 1_000).round(3)
        return unless duration_ms.finite? && !duration_ms.negative?
        kind, operation = match[1] ? %w[database query] : [match[2] ? "cache" : "view", match[3] || match[5]]
        metadata = { "rails.notification" => name.to_s }
        metadata["cache.hit"] = payload[:hit] if kind == "cache" && [true, false].include?(payload[:hit])
        template = template_path(payload[:identifier]) if kind == "view"
        metadata["view.template"] = template unless template.nil?
        error = payload[:exception_object]
        state[0] += 1
        timestamp = started_at.iso8601(6) if started_at.respond_to?(:iso8601)
        timestamp ||= Time.now.utc.iso8601(6)
        state[1] << [duration_ms, kind, operation, metadata, error.is_a?(Exception) ? error : nil, timestamp, started_at]
        state[1].sort_by! { |item| [item[0], item[1], item[2]] }
        state[1].shift if state[1].length > LIMIT
      rescue StandardError
        nil
      end

      def snapshot
        Thread.current[STATE_KEY] || [0, []]
      end

      def template_path(identifier)
        text = identifier.to_s.tr("\\", "/")
        relative = text.split("/app/views/", 2)[1]
        return if relative.nil? || relative.empty? || relative.bytesize > 255 || relative.match?(/[[:cntrl:]]/) || relative.split("/").include?("..")

        relative
      end
      private_class_method :template_path
    end
    private_constant :RequestOperations

    # Internal Rack adapter that replaces concrete request paths with Rails
    # route templates while reusing the core request/error lifecycle.
    class RailsRackMiddleware < LogBrew::RackMiddleware
      private

      def capture_request_span(*arguments)
        super.tap do
          RequestOperations.snapshot[1].sort_by(&:last).each do |duration_ms, kind, name, metadata, error, timestamp|
            LogBrew::OperationTracing.capture_span(
              @client, kind, name, LogBrew::OperationTracing.child_context, nil,
              { duration_ms: duration_ms, timestamp: timestamp, source: "rails.active_support", system: kind == "database" ? "active_record" : "rails", operation: name, metadata: metadata, on_error: @on_error }, error
            )
          end
        end
      end

      def exception_mechanism_type
        "rails.middleware"
      end

      def exception_grouping_prefix
        "rails-exception"
      end

      def exception_status_code(error)
        return super unless defined?(::ActionDispatch::ExceptionWrapper)

        status = ::ActionDispatch::ExceptionWrapper.status_code_for_exception(error.class.name)
        status.is_a?(Integer) && status.between?(400, 599) ? status : super
      rescue StandardError
        super
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
        super.tap do |metadata|
          metadata.delete("http.path")
          metadata.delete("action_dispatch.request_id")
          metadata.delete("HTTP_X_REQUEST_ID")
          metadata["source"] = "rails"
          metadata["http.route"] = route_template(env)
          metadata["http.status_class"] = "#{status_code.to_i / 100}xx"
          controller, action = controller_and_action(env)
          metadata["rails.controller"] = controller unless controller.nil?
          metadata["rails.action"] = action unless action.nil?
          observed, operations = RequestOperations.snapshot
          metadata["rails.operations.observed"] = observed
          metadata["rails.operations.captured"] = operations.length
          metadata["rails.operations.truncated"] = observed > operations.length
        end
      end

      def route_template(env)
        route = bounded_route(env_value(env, "action_dispatch.route_uri_pattern")) ||
                bounded_route(matched_route_pattern(env))
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

        %i[controller action].map { |key| bounded_identifier(parameters[key] || parameters[key.to_s]) }
      end

      def bounded_route(value)
        return nil if value.nil?

        route = value.to_s.split(/[?#]/, 2).first.to_s.strip
        return nil if route.empty? || route.bytesize > 255 || !route.valid_encoding?

        route.start_with?("/") ? route : "/#{route}"
      end

      def bounded_identifier(value)
        value.to_s[/\A[a-zA-Z0-9_\/.-]{1,128}\z/]
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

        RequestOperations.within { adapter.call(environment) }
      end

      private

      def adapter_for(active_client)
        @mutex.synchronize do
          return @adapter if @adapter_client.equal?(active_client) && !@adapter.nil?

          @adapter = RailsRackMiddleware.new(
            @app,
            client: active_client,
            flush_on_response: false,
            metadata: @runtime.metadata,
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

          @subscriber = LogBrew::RailsErrorSubscriber.new(
            client: active_client,
            flush_on_report: false,
            metadata: @runtime.metadata,
            include_exception_message: @runtime.configuration.capture_exception_messages?,
            include_exception_backtrace: @runtime.configuration.include_exception_backtrace?,
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
