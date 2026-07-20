# frozen_string_literal: true

require "json"
require "logger"
require "net/http"
require "securerandom"
require "time"
require "timeout"
require "uri"

module LogBrew
  SEVERITY_VALUES = %w[trace debug info warn warning error fatal critical].freeze
  SEVERITY_ALIASES = {
    "trace" => "info",
    "debug" => "info",
    "info" => "info",
    "warn" => "warning",
    "warning" => "warning",
    "error" => "error",
    "fatal" => "critical",
    "critical" => "critical"
  }.freeze
  SPAN_STATUSES = %w[ok error].freeze
  ACTION_STATUSES = %w[queued running success failure].freeze
  METRIC_TEMPORALITIES_BY_KIND = {
    "counter" => %w[delta cumulative].freeze,
    "gauge" => %w[instant].freeze,
    "histogram" => %w[delta cumulative].freeze
  }.freeze
  METRIC_KINDS = METRIC_TEMPORALITIES_BY_KIND.keys.freeze
  NON_NEGATIVE_METRIC_KINDS = %w[counter histogram].freeze

  class SdkError < StandardError
    attr_reader :code

    def initialize(code, message)
      @code = code
      super("#{code}: #{message}")
    end
  end

  require_relative "logbrew/event_batcher"
  require_relative "logbrew/persistent_event_store"
  require_relative "logbrew/bounded_event_queue"

  class TransportError < StandardError
    attr_reader :code, :retryable

    def initialize(code, message, retryable: false)
      @code = code
      @retryable = retryable
      super(message)
    end

    def self.network(message)
      new("network_failure", message, retryable: true)
    end
  end

  class TransportResponse
    attr_reader :status_code, :attempts, :batches

    def initialize(status_code, attempts, batches = 1)
      @status_code = status_code
      @attempts = attempts
      @batches = batches
    end
  end

  class DeliveryFailure < SdkError
    attr_reader :automatic_pause_reason

    def initialize(code, message, automatic_retryable: false, automatic_pause_reason: nil)
      @automatic_retryable = automatic_retryable
      @automatic_pause_reason = automatic_pause_reason
      super(code, message)
    end

    def automatic_retryable?
      @automatic_retryable
    end
  end
  private_constant :DeliveryFailure

  class RecordingTransport
    attr_reader :sent_bodies

    def initialize(scripted_responses = [202])
      @scripted_responses = scripted_responses.empty? ? [202] : scripted_responses.dup
      @sent_bodies = []
    end

    def self.always_accept
      new([202])
    end

    def last_body
      @sent_bodies[-1]
    end

    def send(api_key, body)
      Validation.require_non_empty("api_key", api_key)
      @sent_bodies << body

      response = @scripted_responses.empty? ? 202 : @scripted_responses.shift
      raise response if response.is_a?(TransportError)
      raise response if response.is_a?(SdkError)

      status_code = response.is_a?(TransportResponse) ? response.status_code : response.to_i
      TransportResponse.new(status_code.zero? ? 202 : status_code, 1)
    end
  end

  class HttpTransport
    DEFAULT_ENDPOINT = "https://api.logbrew.co/v1/events"
    DEFAULT_TIMEOUT = 10

    attr_reader :endpoint, :headers, :timeout, :http_client

    def initialize(endpoint: DEFAULT_ENDPOINT, headers: {}, timeout: DEFAULT_TIMEOUT, http_client: nil)
      @endpoint = validate_endpoint(endpoint)
      @headers = copy_headers(headers)
      @timeout = validate_timeout(timeout)
      @http_client = http_client
    end

    def send(api_key, body)
      Validation.require_non_empty("api_key", api_key)
      raise SdkError.new("validation_error", "body must be non-empty") if body.nil?

      request = Net::HTTP::Post.new(request_path)
      request["authorization"] = "Bearer #{api_key}"
      request["content-type"] = "application/json"
      @headers.each { |name, value| request[name] = value }
      request.body = body

      response = HttpClientTracing.suppress do
        @http_client ? @http_client.request(request) : request_with_default_client(request)
      end
      TransportResponse.new(response.code.to_i, 1)
    rescue TransportError
      raise
    rescue IOError, SystemCallError, SocketError, Timeout::Error, EOFError, Net::OpenTimeout, Net::ReadTimeout => error
      raise TransportError.network("http transport failed: #{error.message}")
    end

    private

    def request_path
      path = @endpoint.path.empty? ? "/" : @endpoint.path
      return path if @endpoint.query.nil? || @endpoint.query.empty?

      "#{path}?#{@endpoint.query}"
    end

    def request_with_default_client(request)
      http = Net::HTTP.new(@endpoint.host, @endpoint.port)
      http.use_ssl = @endpoint.scheme == "https"
      http.open_timeout = @timeout
      http.read_timeout = @timeout
      http.write_timeout = @timeout if http.respond_to?(:write_timeout=)
      http.start { |client| client.request(request) }
    end

    def validate_endpoint(endpoint)
      uri = endpoint.is_a?(URI) ? endpoint : URI.parse(endpoint.to_s)
      unless uri.is_a?(URI::HTTP) && uri.host && !uri.host.empty?
        raise SdkError.new("configuration_error", "HTTP transport endpoint must use http or https")
      end

      uri
    rescue URI::InvalidURIError => error
      raise SdkError.new("configuration_error", "invalid HTTP transport endpoint: #{error.message}")
    end

    def copy_headers(headers)
      raise SdkError.new("configuration_error", "HTTP transport headers must be an object") unless headers.is_a?(Hash)

      headers.each_with_object({}) do |(name, value), copied|
        normalized_name = name.to_s
        raise SdkError.new("configuration_error", "HTTP transport header name must be non-empty") if normalized_name.strip.empty?
        raise SdkError.new("configuration_error", "HTTP transport header value must be non-null") if value.nil?

        copied[normalized_name] = value.to_s
      end
    end

    def validate_timeout(timeout)
      value = timeout.to_f
      raise SdkError.new("configuration_error", "HTTP transport timeout must be positive") unless value.positive? && value.finite?

      value
    end
  end

  class Logger < ::Logger
    DEFAULT_LOGGER_NAME = "ruby-logger"
    SEVERITY_TO_LOGBREW_LEVEL = {
      ::Logger::DEBUG => "info",
      ::Logger::INFO => "info",
      ::Logger::WARN => "warning",
      ::Logger::ERROR => "error",
      ::Logger::FATAL => "critical",
      ::Logger::UNKNOWN => "error"
    }.freeze

    def initialize(
      client:,
      logdev: File::NULL,
      logger_name: nil,
      event_id_prefix: "ruby_log",
      metadata: nil,
      transport: nil,
      flush_on_log: false,
      include_exception_backtrace: false,
      timestamp_provider: nil,
      on_error: nil,
      raise_errors: false,
      level: ::Logger::DEBUG,
      progname: nil,
      formatter: nil,
      datetime_format: nil
    )
      Validation.require_non_empty("logger name", logger_name) unless logger_name.nil?
      Validation.require_non_empty("event id prefix", event_id_prefix)
      raise SdkError.new("validation_error", "metadata must be an object") unless metadata.nil? || metadata.is_a?(Hash)

      @client = client
      @logger_name = logger_name
      @event_id_prefix = event_id_prefix
      @metadata = metadata || {}
      @transport = transport
      @flush_on_log = flush_on_log
      @include_exception_backtrace = include_exception_backtrace
      @timestamp_provider = timestamp_provider
      @on_error = on_error
      @raise_errors = raise_errors
      @next_event_number = 0

      super(logdev || File::NULL)
      self.level = level
      self.progname = progname unless progname.nil?
      self.formatter = formatter unless formatter.nil?
      self.datetime_format = datetime_format unless datetime_format.nil?
    end

    def add(severity, message = nil, progname = nil)
      severity = ::Logger::UNKNOWN if severity.nil?
      return true if severity < level

      resolved_message, resolved_progname = resolve_log_arguments(message, progname, block_given?) do
        yield
      end

      begin
        capture_logbrew_event(severity, resolved_message, resolved_progname)
      rescue StandardError => error
        handle_logbrew_error(error)
      end

      super(severity, resolved_message, resolved_progname)
    end

    def flush_logbrew(transport = @transport)
      return nil if transport.nil? || @client.pending_events.zero?

      @client.flush(transport)
    end

    private

    def resolve_log_arguments(message, progname, has_block)
      effective_progname = progname.nil? ? self.progname : progname
      return [message, effective_progname] unless message.nil?

      if has_block
        [yield, effective_progname]
      else
        [effective_progname, self.progname]
      end
    end

    def capture_logbrew_event(severity, message, progname)
      @next_event_number += 1
      @client.log(
        "#{@event_id_prefix}_#{@next_event_number}",
        logbrew_timestamp,
        message: logbrew_message(message),
        level: logbrew_level(severity),
        logger: event_logger_name(progname),
        metadata: logbrew_metadata(severity, message, progname)
      )
      flush_logbrew if @flush_on_log
    end

    def handle_logbrew_error(error)
      @on_error.call(error) if @on_error.respond_to?(:call)
      raise error if @raise_errors
    end

    def logbrew_timestamp
      timestamp = @timestamp_provider.respond_to?(:call) ? @timestamp_provider.call : Time.now
      return timestamp.iso8601 if timestamp.respond_to?(:iso8601)

      timestamp.to_s
    end

    def logbrew_message(message)
      return message.message if message.is_a?(Exception)
      return message if message.is_a?(String)

      message.inspect
    end

    def logbrew_level(severity)
      SEVERITY_TO_LOGBREW_LEVEL.fetch(severity.to_i, severity.to_i >= ::Logger::FATAL ? "critical" : "info")
    end

    def event_logger_name(progname)
      configured = @logger_name || progname || self.progname || DEFAULT_LOGGER_NAME
      configured.to_s
    end

    def logbrew_metadata(severity, message, progname)
      copy_metadata(@metadata).tap do |metadata|
        metadata["rubySeverity"] = severity_label(severity)
        metadata["progname"] = progname.to_s if primitive_metadata_value?(progname) && !progname.to_s.empty?
        add_exception_metadata(metadata, message) if message.is_a?(Exception)
      end
    end

    def severity_label(severity)
      ::Logger::SEV_LABEL[severity.to_i] || "ANY"
    end

    def add_exception_metadata(metadata, exception)
      metadata["exceptionType"] = exception.class.name
      metadata["exceptionMessage"] = exception.message
      metadata["exceptionBacktrace"] = exception.backtrace.join("\n") if @include_exception_backtrace && exception.backtrace
    end

    def copy_metadata(metadata)
      metadata.each_with_object({}) do |(key, value), copied|
        copied[key.to_s] = value if primitive_metadata_value?(value)
      end
    end

    def primitive_metadata_value?(value)
      return true if value.nil? || value == true || value == false
      return true if value.is_a?(String) || value.is_a?(Integer)

      value.is_a?(Float) && value.finite?
    end
  end
  # Rack-compatible middleware for Rails, Sinatra, and other Rack-based Ruby apps.
  #
  # The middleware captures completed requests as span events and unhandled app
  # exceptions as issue plus error-span events. It does not require the rack or
  # rails gems at runtime; any app object that responds to `call(env)` is enough.
  class RackMiddleware
    DEFAULT_EVENT_ID_PREFIX = "ruby_rack"
    DEFAULT_SPAN_LOGGER = "rack"

    def initialize(
      app,
      client:,
      transport: nil,
      flush_on_response: false,
      event_id_prefix: DEFAULT_EVENT_ID_PREFIX,
      metadata: nil,
      timestamp_provider: nil,
      include_exception_backtrace: false,
      on_error: nil,
      raise_errors: false
    )
      raise SdkError.new("validation_error", "rack app must respond to call") unless app.respond_to?(:call)
      Validation.require_non_empty("event id prefix", event_id_prefix)
      raise SdkError.new("validation_error", "metadata must be an object") unless metadata.nil? || metadata.is_a?(Hash)

      @app = app
      @client = client
      @transport = transport
      @flush_on_response = flush_on_response
      @event_id_prefix = event_id_prefix
      @metadata = metadata || {}
      @timestamp_provider = timestamp_provider
      @include_exception_backtrace = include_exception_backtrace
      @on_error = on_error
      @raise_errors = raise_errors
      @next_event_number = 0
    end

    def call(env)
      started_at = monotonic_time
      begin
        response = @app.call(env)
      rescue StandardError => error
        safely_capture do
          elapsed_ms = duration_ms(started_at)
          capture_exception_issue(env, error)
          capture_request_span(env, 500, elapsed_ms, "error")
          flush_if_configured
        end
        raise
      end

      status_code = rack_status(response)
      safely_capture do
        capture_request_span(env, status_code, duration_ms(started_at), status_code >= 500 ? "error" : "ok")
        flush_if_configured
      end
      response
    end

    private

    def capture_request_span(env, status_code, elapsed_ms, status)
      @client.span(
        next_event_id("span"),
        logbrew_timestamp,
        name: request_name(env),
        traceId: trace_id(env),
        spanId: span_id(env),
        status: status,
        durationMs: elapsed_ms,
        metadata: request_metadata(env, status_code)
      )
    end

    def capture_exception_issue(env, error)
      @client.issue(
        next_event_id("issue"),
        logbrew_timestamp,
        title: error.class.name,
        level: "error",
        message: error.message,
        metadata: exception_metadata(env, error)
      )
    end

    def next_event_id(kind)
      @next_event_number += 1
      "#{@event_id_prefix}_#{kind}_#{@next_event_number}"
    end

    def logbrew_timestamp
      timestamp = @timestamp_provider.respond_to?(:call) ? @timestamp_provider.call : Time.now
      return timestamp.iso8601 if timestamp.respond_to?(:iso8601)

      timestamp.to_s
    end

    def request_name(env)
      "#{request_method(env)} #{request_path(env)}"
    end

    def request_method(env)
      value = env_value(env, "REQUEST_METHOD")
      value.nil? || value.empty? ? "GET" : value
    end

    def request_path(env)
      value = env_value(env, "PATH_INFO")
      value = env_value(env, "REQUEST_PATH") if value.nil? || value.empty?
      value = env_value(env, "REQUEST_URI").to_s.split("?", 2)[0] if value.nil? || value.empty?
      value.nil? || value.empty? ? "/" : value
    end

    def trace_id(env)
      env_value(env, "logbrew.trace_id") ||
        env_value(env, "action_dispatch.request_id") ||
        env_value(env, "HTTP_X_REQUEST_ID") ||
        SecureRandom.hex(16)
    end

    def span_id(env)
      env_value(env, "logbrew.span_id") || SecureRandom.hex(8)
    end

    def request_metadata(env, status_code)
      copy_metadata(@metadata).tap do |metadata|
        metadata["source"] = DEFAULT_SPAN_LOGGER
        metadata["http.method"] = request_method(env)
        metadata["http.path"] = request_path(env)
        metadata["http.status_code"] = status_code
        add_env_metadata(metadata, "rack.url_scheme", env)
        add_env_metadata(metadata, "action_dispatch.request_id", env)
        add_env_metadata(metadata, "HTTP_X_REQUEST_ID", env)
      end
    end

    def exception_metadata(env, error)
      request_metadata(env, 500).tap do |metadata|
        metadata["exceptionType"] = error.class.name
        metadata["exceptionMessage"] = error.message
        metadata["exceptionBacktrace"] = error.backtrace.join("\n") if @include_exception_backtrace && error.backtrace
      end
    end

    def rack_status(response)
      return response[0].to_i if response.respond_to?(:[]) && !response[0].nil?

      500
    end

    def env_value(env, key)
      return nil unless env.respond_to?(:[])

      value = env[key]
      return nil unless primitive_metadata_value?(value)

      text = value.to_s
      text.empty? ? nil : text
    end

    def add_env_metadata(metadata, key, env)
      value = env_value(env, key)
      metadata[key] = value unless value.nil?
    end

    def copy_metadata(metadata)
      metadata.each_with_object({}) do |(key, value), copied|
        copied[key.to_s] = value if primitive_metadata_value?(value)
      end
    end

    def primitive_metadata_value?(value)
      return true if value.nil? || value == true || value == false
      return true if value.is_a?(String) || value.is_a?(Integer)

      value.is_a?(Float) && value.finite?
    end

    def monotonic_time
      Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end

    def duration_ms(started_at)
      ((monotonic_time - started_at) * 1000.0).round(3)
    end

    def flush_if_configured
      return unless @flush_on_response && !@transport.nil? && @client.pending_events.positive?

      @client.flush(@transport)
    end

    def safely_capture
      yield
    rescue StandardError => error
      @on_error.call(error) if @on_error.respond_to?(:call)
      raise error if @raise_errors
    end
  end

  # Rails.error subscriber for handled and manually reported Rails exceptions.
  #
  # Register an instance with `Rails.error.subscribe(...)` from a Rails
  # initializer. This class avoids a hard Rails dependency so the core gem stays
  # usable in plain Ruby and Rack apps.
  class RailsErrorSubscriber
    DEFAULT_EVENT_ID_PREFIX = "ruby_rails_error"
    SEVERITY_TO_ISSUE_LEVEL = {
      "info" => "info",
      "warning" => "warning",
      "error" => "error"
    }.freeze

    def initialize(
      client:,
      transport: nil,
      flush_on_report: false,
      event_id_prefix: DEFAULT_EVENT_ID_PREFIX,
      metadata: nil,
      timestamp_provider: nil,
      include_exception_backtrace: false,
      on_error: nil,
      raise_errors: false
    )
      Validation.require_non_empty("event id prefix", event_id_prefix)
      raise SdkError.new("validation_error", "metadata must be an object") unless metadata.nil? || metadata.is_a?(Hash)

      @client = client
      @transport = transport
      @flush_on_report = flush_on_report
      @event_id_prefix = event_id_prefix
      @metadata = metadata || {}
      @timestamp_provider = timestamp_provider
      @include_exception_backtrace = include_exception_backtrace
      @on_error = on_error
      @raise_errors = raise_errors
      @next_event_number = 0
    end

    def report(error, handled: true, severity: :error, context: nil, source: nil, **_options)
      capture_safely do
        @next_event_number += 1
        @client.issue(
          "#{@event_id_prefix}_#{@next_event_number}",
          logbrew_timestamp,
          title: error_title(error),
          level: issue_level(severity),
          message: error_message(error),
          metadata: rails_metadata(error, handled, severity, context, source)
        )
        flush_if_configured
      end
    end

    private

    def logbrew_timestamp
      timestamp = @timestamp_provider.respond_to?(:call) ? @timestamp_provider.call : Time.now
      return timestamp.iso8601 if timestamp.respond_to?(:iso8601)

      timestamp.to_s
    end

    def error_title(error)
      return error.class.name if error.is_a?(Exception)

      "RailsError"
    end

    def error_message(error)
      return error.message if error.is_a?(Exception)
      return error if error.is_a?(String)

      error.inspect
    end

    def issue_level(severity)
      SEVERITY_TO_ISSUE_LEVEL.fetch(severity.to_s, "error")
    end

    def rails_metadata(error, handled, severity, context, source)
      copy_metadata(@metadata).tap do |metadata|
        metadata["source"] = "rails.error"
        metadata["rails.handled"] = handled ? true : false
        metadata["rails.severity"] = severity.to_s
        metadata["rails.source"] = source.to_s if primitive_metadata_value?(source) && !source.to_s.empty?
        add_context_metadata(metadata, context)
        add_exception_metadata(metadata, error) if error.is_a?(Exception)
      end
    end

    def add_context_metadata(metadata, context)
      return if context.nil?
      return unless context.is_a?(Hash)

      context.each do |key, value|
        metadata["context.#{key}"] = value if primitive_metadata_value?(value)
      end
    end

    def add_exception_metadata(metadata, exception)
      metadata["exceptionType"] = exception.class.name
      metadata["exceptionMessage"] = exception.message
      metadata["exceptionBacktrace"] = exception.backtrace.join("\n") if @include_exception_backtrace && exception.backtrace
    end

    def copy_metadata(metadata)
      metadata.each_with_object({}) do |(key, value), copied|
        copied[key.to_s] = value if primitive_metadata_value?(value)
      end
    end

    def primitive_metadata_value?(value)
      return true if value.nil? || value == true || value == false
      return true if value.is_a?(String) || value.is_a?(Integer)

      value.is_a?(Float) && value.finite?
    end

    def flush_if_configured
      return unless @flush_on_report && !@transport.nil? && @client.pending_events.positive?

      @client.flush(@transport)
    end

    def capture_safely
      yield
    rescue StandardError => error
      @on_error.call(error) if @on_error.respond_to?(:call)
      raise error if @raise_errors
    end
  end

  module Validation
    module_function

    def require_non_empty(label, value)
      return if value.is_a?(String) && value.valid_encoding? && !value.strip.empty?

      raise SdkError.new("validation_error", "#{label} must be non-empty")
    end

    def require_allowed_value(label, value, allowed_values)
      require_non_empty(label, value)
      return if allowed_values.include?(value)

      raise SdkError.new("validation_error", "#{label} must be one of: #{allowed_values.join(', ')}")
    end

    def require_timestamp(timestamp)
      require_non_empty("timestamp", timestamp)
      return if timestamp.end_with?("Z")

      time_parts = timestamp.split("T", 2)
      raise timestamp_error(timestamp) if time_parts.length < 2

      time_portion = time_parts[1]
      return if time_portion.include?("+")
      return if time_portion.rindex("-") && time_portion.rindex("-").positive?

      raise timestamp_error(timestamp)
    end

    def require_metadata(metadata)
      return nil if metadata.nil?
      raise SdkError.new("validation_error", "metadata must be an object") unless metadata.is_a?(Hash)

      metadata.each_with_object({}) do |(key, value), copied|
        normalized_key = key.to_s
        require_non_empty("metadata key", normalized_key)
        unless value.nil? || value.is_a?(String) || value.is_a?(Integer) || value.is_a?(Float) ||
               value == true || value == false
          raise SdkError.new(
            "validation_error",
            "metadata value for #{normalized_key} must be a string, number, boolean, or null"
          )
        end
        raise SdkError.new("validation_error", "metadata value for #{normalized_key} must be finite") if numeric_nan?(value)

        copied[normalized_key] = value
      end
    end

    def require_finite_number(label, value)
      unless value.is_a?(Integer) || value.is_a?(Float)
        raise SdkError.new("validation_error", "#{label} must be a finite number")
      end
      raise SdkError.new("validation_error", "#{label} must be a finite number") if numeric_nan?(value)

      value
    end

    def read(attributes, key)
      return nil unless attributes.is_a?(Hash)

      attributes[key] || attributes[key.to_sym]
    end

    def timestamp_error(timestamp)
      SdkError.new("validation_error", "timestamp must include a timezone offset: #{timestamp}")
    end

    def numeric_nan?(value)
      value.is_a?(Float) && (value.nan? || value.infinite?)
    end
  end

  class Client
    DEFAULT_AUTOMATIC_FLUSH_INTERVAL = 5.0
    DEFAULT_AUTOMATIC_FLUSH_THRESHOLD = 100
    DEFAULT_AUTOMATIC_RETRY_BASE_DELAY = 0.25
    DEFAULT_AUTOMATIC_RETRY_MAX_DELAY = 30.0

    def self.create(
      api_key:,
      sdk_name:,
      sdk_version:,
      max_retries: 2,
      max_queue_size: BoundedEventQueue::DEFAULT_MAX_SIZE,
      max_queue_bytes: BoundedEventQueue::DEFAULT_MAX_BYTES,
      on_event_dropped: nil,
      max_batch_size: EventBatcher::DEFAULT_MAX_SIZE,
      max_batch_bytes: EventBatcher::DEFAULT_MAX_BYTES,
      persistent_queue_path: nil
    )
      Validation.require_non_empty("api_key", api_key)
      Validation.require_non_empty("sdk_name", sdk_name)
      Validation.require_non_empty("sdk_version", sdk_version)
      raise SdkError.new("validation_error", "max_retries must be non-negative") if max_retries.negative?

      new(
        api_key: api_key,
        sdk: {
          "name" => sdk_name.dup.freeze,
          "language" => "ruby",
          "version" => sdk_version.dup.freeze
        }.freeze,
        max_retries: max_retries,
        max_queue_size: max_queue_size,
        max_queue_bytes: max_queue_bytes,
        on_event_dropped: on_event_dropped,
        max_batch_size: max_batch_size,
        max_batch_bytes: max_batch_bytes,
        persistent_queue_path: persistent_queue_path
      )
    end

    def self.create_automatic(
      api_key:,
      sdk_name:,
      sdk_version:,
      transport:,
      flush_interval: DEFAULT_AUTOMATIC_FLUSH_INTERVAL,
      flush_threshold: DEFAULT_AUTOMATIC_FLUSH_THRESHOLD,
      retry_base_delay: DEFAULT_AUTOMATIC_RETRY_BASE_DELAY,
      retry_max_delay: DEFAULT_AUTOMATIC_RETRY_MAX_DELAY,
      **options
    )
      max_queue_size = options.fetch(:max_queue_size, BoundedEventQueue::DEFAULT_MAX_SIZE)
      AutomaticDelivery.validate!(
        transport: transport,
        flush_interval: flush_interval,
        flush_threshold: flush_threshold,
        retry_base_delay: retry_base_delay,
        retry_max_delay: retry_max_delay,
        max_queue_size: max_queue_size
      )
      client = create(
        api_key: api_key,
        sdk_name: sdk_name,
        sdk_version: sdk_version,
        **options
      )
      client.send(
        :enable_automatic_delivery,
        transport: transport,
        flush_interval: flush_interval,
        flush_threshold: flush_threshold,
        retry_base_delay: retry_base_delay,
        retry_max_delay: retry_max_delay
      )
      client
    end

    def initialize(
      api_key:,
      sdk:,
      max_retries:,
      max_queue_size: BoundedEventQueue::DEFAULT_MAX_SIZE,
      max_queue_bytes: BoundedEventQueue::DEFAULT_MAX_BYTES,
      on_event_dropped: nil,
      max_batch_size: EventBatcher::DEFAULT_MAX_SIZE,
      max_batch_bytes: EventBatcher::DEFAULT_MAX_BYTES,
      persistent_queue_path: nil
    )
      @api_key = api_key
      @sdk = sdk
      @max_retries = max_retries
      @event_batcher = EventBatcher.new(sdk: sdk, max_size: max_batch_size, max_bytes: max_batch_bytes)
      event_store = nil
      begin
        event_store = PersistentEventStore.open(path: persistent_queue_path) unless persistent_queue_path.nil?
        @event_queue = BoundedEventQueue.new(
          max_size: max_queue_size,
          max_bytes: max_queue_bytes,
          max_event_bytes: @event_batcher.max_event_bytes,
          on_event_dropped: on_event_dropped,
          event_store: event_store
        )
      rescue StandardError
        event_store&.close
        raise
      end
      @state_mutex = Mutex.new
      @flush_mutex = Mutex.new
      @closed = false
      @closing = false
      @retry_batch = nil
      @automatic_delivery = nil
    end

    def pending_events
      @event_queue.length
    end

    def pending_event_bytes
      @event_queue.pending_bytes
    end

    def dropped_events
      @event_queue.dropped_events
    end

    def delivery_health
      controller = @automatic_delivery
      unless controller.nil?
        controller.assert_process_ownership!
        return controller.snapshot
      end

      metrics = queue_metrics
      state = @state_mutex.synchronize { @closed ? "closed" : "manual" }
      DeliveryHealth.new(
        state: state,
        queued_events: metrics.fetch(:queued_events),
        queued_bytes: metrics.fetch(:queued_bytes),
        dropped_events: metrics.fetch(:dropped_events),
        in_flight: false,
        last_outcome: "none",
        consecutive_failures: 0,
        pause_reason: nil,
        successful_flushes: 0,
        failed_flushes: 0,
        retry_delay_ms: 0
      )
    end

    def recover_automatic_delivery
      controller = require_automatic_delivery
      controller.assert_process_ownership!
      flush
    end

    def stop_automatic_delivery
      controller = require_automatic_delivery
      controller.stop
    end

    def preview_json
      snapshot = @event_queue.snapshot
      JSON.pretty_generate("sdk" => @sdk, "events" => snapshot.events)
    end

    def purge_pending_events
      ensure_not_reentrant_flush
      controller = @automatic_delivery
      controller&.assert_process_ownership!
      @flush_mutex.synchronize do
        @state_mutex.synchronize { ensure_open }
        @retry_batch = nil
        removed = @event_queue.purge
        controller&.queue_changed
        removed
      end
    end

    def release(id, timestamp, attributes)
      push_event("release", id, timestamp, validate_release(attributes))
    end

    def environment(id, timestamp, attributes)
      push_event("environment", id, timestamp, validate_environment(attributes))
    end

    def issue(id, timestamp, attributes)
      push_event("issue", id, timestamp, validate_issue(attributes))
    end

    def log(id, timestamp, attributes)
      push_event("log", id, timestamp, validate_log(attributes))
    end

    def span(id, timestamp, attributes)
      push_event("span", id, timestamp, validate_span(attributes))
    end

    def metric(id, timestamp, attributes)
      push_event("metric", id, timestamp, validate_metric(attributes))
    end

    def action(id, timestamp, attributes)
      push_event("action", id, timestamp, validate_action(attributes))
    end

    def flush(transport = nil)
      ensure_not_reentrant_flush
      controller = @automatic_delivery
      controller&.assert_process_ownership!
      resolved_transport = resolve_transport(transport)
      @flush_mutex.synchronize do
        @state_mutex.synchronize { ensure_open }
        previous = controller&.begin_explicit_flush
        begin
          response = flush_internal(resolved_transport)
          controller&.complete_explicit_flush(previous, response)
          response
        rescue StandardError => error
          controller&.fail_explicit_flush(previous, error)
          raise
        end
      end
    end

    def shutdown(transport = nil)
      ensure_not_reentrant_flush
      controller = @automatic_delivery
      controller&.assert_process_ownership!
      resolved_transport = resolve_transport(transport)
      controller&.prepare_shutdown
      @flush_mutex.synchronize do
        @state_mutex.synchronize do
          ensure_open
          @closing = true
        end

        succeeded = false
        failure = nil
        begin
          response = flush_internal(resolved_transport)
          @event_queue.close
          succeeded = true
          controller&.complete_shutdown(response)
          response
        rescue StandardError => error
          failure = error
          raise
        ensure
          @state_mutex.synchronize do
            @closed = true if succeeded
            @closing = false
          end
          controller&.resume_after_failed_shutdown(failure) unless succeeded
        end
      end
    end

    private

    def push_event(type, id, timestamp, attributes)
      @automatic_delivery&.assert_process_ownership!
      Validation.require_non_empty("event id", id)
      Validation.require_timestamp(timestamp)
      event = {
        "type" => type,
        "timestamp" => timestamp,
        "id" => id,
        "attributes" => attributes
      }
      notice = @state_mutex.synchronize do
        ensure_open
        @event_queue.enqueue(event_id: id, event_type: type, event: event)
      end
      @event_queue.notify_drop(notice)
      @automatic_delivery&.notify_capture if notice.nil?
    end

    def enable_automatic_delivery(transport:, flush_interval:, flush_threshold:, retry_base_delay:, retry_max_delay:)
      @automatic_delivery = AutomaticDelivery.new(
        client: self,
        transport: transport,
        flush_interval: flush_interval,
        flush_threshold: flush_threshold,
        retry_base_delay: retry_base_delay,
        retry_max_delay: retry_max_delay
      )
    end

    def perform_automatic_flush(controller, generation, transport)
      @flush_mutex.synchronize do
        begin
          @state_mutex.synchronize { ensure_open }
          response = flush_internal(transport)
          controller.complete_automatic_flush(generation, response)
        rescue StandardError => error
          controller.fail_automatic_flush(generation, error)
        end
      end
    end

    def flush_internal(transport)
      snapshot = @event_queue.snapshot
      return TransportResponse.new(204, 0, 0) if snapshot.event_count.zero?

      remaining_events = snapshot.event_count
      attempts = 0
      batches = 0
      status_code = 204

      while remaining_events.positive?
        batch = @retry_batch || @event_batcher.next_batch(
          @event_queue.snapshot.serialized_events,
          limit: remaining_events
        )
        @retry_batch = batch
        response = send_batch(transport, batch.body)
        compaction_error = @event_queue.acknowledge(batch)
        @retry_batch = nil
        raise compaction_error unless compaction_error.nil?
        remaining_events -= batch.event_count
        attempts += response.attempts
        batches += 1
        status_code = response.status_code
      end

      TransportResponse.new(status_code, attempts, batches)
    end

    def send_batch(transport, body)
      max_attempts = @max_retries + 1
      (1..max_attempts).each do |attempt|
        begin
          response = transport.send(@api_key, body)
          if response.status_code == 401 || response.status_code == 403
            raise DeliveryFailure.new(
              "unauthenticated",
              "transport rejected the API key",
              automatic_pause_reason: "authentication"
            )
          end

          if response.status_code >= 200 && response.status_code < 300
            return TransportResponse.new(response.status_code, attempt)
          end
          retryable_status = response.status_code == 408 || response.status_code >= 500
          next if retryable_status && attempt < max_attempts

          if retryable_status
            raise DeliveryFailure.new(
              "transport_error",
              "unexpected transport status #{response.status_code}",
              automatic_retryable: true
            )
          end

          pause_reason = case response.status_code
                         when 429 then "quota"
                         when 400, 422 then "validation"
                         else "nonretryable"
                         end

          raise DeliveryFailure.new(
            "transport_error",
            "unexpected transport status #{response.status_code}",
            automatic_pause_reason: pause_reason
          )
        rescue TransportError => error
          next if error.retryable && attempt < max_attempts

          raise DeliveryFailure.new(
            error.code,
            error.message,
            automatic_retryable: error.retryable
          )
        end
      end
      raise DeliveryFailure.new("transport_error", "exhausted retries", automatic_retryable: true)
    end

    def require_automatic_delivery
      return @automatic_delivery unless @automatic_delivery.nil?

      raise SdkError.new("automatic_delivery_error", "client does not own automatic delivery")
    end

    def resolve_transport(transport)
      resolved = transport || @automatic_delivery&.transport
      unless resolved.respond_to?(:send)
        raise SdkError.new("validation_error", "transport must respond to send")
      end

      resolved
    end

    def queue_metrics
      @event_queue.metrics
    end

    def ensure_not_reentrant_flush
      return unless @flush_mutex.owned?

      raise SdkError.new("flush_error", "flush is already in progress")
    end

    def ensure_open
      raise SdkError.new("shutdown_error", "client is already shut down") if @closed
      raise SdkError.new("shutdown_error", "client is shutting down") if @closing
    end

    def validate_release(attributes)
      version = Validation.read(attributes, "version")
      Validation.require_non_empty("release version", version)
      commit = Validation.read(attributes, "commit")
      Validation.require_non_empty("release commit", commit) unless commit.nil?
      with_metadata(
        {
          "version" => version
        }.tap do |payload|
          payload["commit"] = commit unless commit.nil?
          notes = Validation.read(attributes, "notes")
          payload["notes"] = notes unless notes.nil?
        end,
        attributes
      )
    end

    def validate_environment(attributes)
      name = Validation.read(attributes, "name")
      Validation.require_non_empty("environment name", name)
      with_metadata(
        {
          "name" => name
        }.tap do |payload|
          region = Validation.read(attributes, "region")
          payload["region"] = region unless region.nil?
        end,
        attributes
      )
    end

    def validate_issue(attributes)
      title = Validation.read(attributes, "title")
      level = Validation.read(attributes, "level")
      Validation.require_non_empty("issue title", title)
      level = normalize_severity("issue level", level)
      with_metadata(
        {
          "title" => title,
          "level" => level
        }.tap do |payload|
          message = Validation.read(attributes, "message")
          payload["message"] = message unless message.nil?
        end,
        attributes
      )
    end

    def validate_log(attributes)
      message = Validation.read(attributes, "message")
      level = Validation.read(attributes, "level")
      Validation.require_non_empty("log message", message)
      level = normalize_severity("log level", level)
      with_metadata(
        {
          "message" => message,
          "level" => level
        }.tap do |payload|
          logger = Validation.read(attributes, "logger")
          payload["logger"] = logger unless logger.nil?
        end,
        attributes
      )
    end

    def normalize_severity(label, level)
      Validation.require_allowed_value(label, level, SEVERITY_VALUES)
      SEVERITY_ALIASES.fetch(level)
    end

    def validate_span(attributes)
      name = Validation.read(attributes, "name")
      trace_id = Validation.read(attributes, "traceId")
      span_id = Validation.read(attributes, "spanId")
      status = Validation.read(attributes, "status")
      Validation.require_non_empty("span name", name)
      Validation.require_non_empty("span traceId", trace_id)
      Validation.require_non_empty("span spanId", span_id)
      Validation.require_allowed_value("span status", status, SPAN_STATUSES)

      parent_span_id = Validation.read(attributes, "parentSpanId")
      Validation.require_non_empty("span parentSpanId", parent_span_id) unless parent_span_id.nil?
      duration_ms = Validation.read(attributes, "durationMs")
      if !duration_ms.nil? && (!duration_ms.is_a?(Numeric) || duration_ms.negative?)
        raise SdkError.new("validation_error", "span durationMs must be non-negative")
      end
      span_events = SpanEvents.validate(Validation.read(attributes, "events"))

      with_metadata(
        {
          "name" => name,
          "traceId" => trace_id,
          "spanId" => span_id
        }.tap do |payload|
          payload["parentSpanId"] = parent_span_id unless parent_span_id.nil?
          payload["status"] = status
          payload["durationMs"] = duration_ms unless duration_ms.nil?
          payload["events"] = span_events unless span_events.nil?
        end,
        attributes
      )
    end

    def validate_metric(attributes)
      name = Validation.read(attributes, "name")
      kind = Validation.read(attributes, "kind")
      unit = Validation.read(attributes, "unit")
      temporality = Validation.read(attributes, "temporality")
      Validation.require_non_empty("metric name", name)
      Validation.require_allowed_value("metric kind", kind, METRIC_KINDS)
      value = Validation.require_finite_number("metric value", Validation.read(attributes, "value"))
      Validation.require_non_empty("metric unit", unit)
      Validation.require_allowed_value("metric temporality for #{kind}", temporality, METRIC_TEMPORALITIES_BY_KIND[kind])
      if NON_NEGATIVE_METRIC_KINDS.include?(kind) && value.negative?
        raise SdkError.new("validation_error", "metric #{kind} value must be non-negative")
      end

      with_metadata(
        {
          "name" => name,
          "kind" => kind,
          "value" => value,
          "unit" => unit,
          "temporality" => temporality
        },
        attributes
      )
    end

    def validate_action(attributes)
      name = Validation.read(attributes, "name")
      status = Validation.read(attributes, "status")
      Validation.require_non_empty("action name", name)
      Validation.require_allowed_value("action status", status, ACTION_STATUSES)
      with_metadata({ "name" => name, "status" => status }, attributes)
    end

    def with_metadata(payload, attributes)
      metadata = Validation.require_metadata(Validation.read(attributes, "metadata"))
      payload["metadata"] = metadata unless metadata.nil?
      payload
    end
  end

  require_relative "logbrew/automatic_delivery"
end

%w[product_timeline traceparent trace span_events operation_tracing http_client_tracing support_ticket worker_lifecycle].each do |path|
  require_relative "logbrew/#{path}"
end
