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
    attr_reader :status_code, :attempts

    def initialize(status_code, attempts)
      @status_code = status_code
      @attempts = attempts
    end
  end

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
    DEFAULT_ENDPOINT = "https://api.logbrew.com/v1/events"
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

      response = @http_client ? @http_client.request(request) : request_with_default_client(request)
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
      return if value.is_a?(String) && !value.strip.empty?

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
    def self.create(api_key:, sdk_name:, sdk_version:, max_retries: 2)
      Validation.require_non_empty("api_key", api_key)
      Validation.require_non_empty("sdk_name", sdk_name)
      Validation.require_non_empty("sdk_version", sdk_version)
      raise SdkError.new("validation_error", "max_retries must be non-negative") if max_retries.negative?

      new(
        api_key: api_key,
        sdk: { "name" => sdk_name, "language" => "ruby", "version" => sdk_version },
        max_retries: max_retries
      )
    end

    def initialize(api_key:, sdk:, max_retries:)
      @api_key = api_key
      @sdk = sdk
      @max_retries = max_retries
      @events = []
      @closed = false
    end

    def pending_events
      @events.length
    end

    def preview_json
      JSON.pretty_generate("sdk" => @sdk, "events" => @events)
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

    def flush(transport)
      raise SdkError.new("shutdown_error", "client is already shut down") if @closed

      flush_internal(transport)
    end

    def shutdown(transport)
      raise SdkError.new("shutdown_error", "client is already shut down") if @closed

      response = flush_internal(transport)
      @closed = true
      response
    end

    private

    def push_event(type, id, timestamp, attributes)
      raise SdkError.new("shutdown_error", "client is already shut down") if @closed

      Validation.require_non_empty("event id", id)
      Validation.require_timestamp(timestamp)
      @events << {
        "type" => type,
        "timestamp" => timestamp,
        "id" => id,
        "attributes" => attributes
      }
    end

    def flush_internal(transport)
      return TransportResponse.new(204, 0) if @events.empty?

      body = preview_json
      max_attempts = @max_retries + 1
      (1..max_attempts).each do |attempt|
        begin
          response = transport.send(@api_key, body)
          raise SdkError.new("unauthenticated", "transport rejected the API key") if response.status_code == 401

          if response.status_code >= 200 && response.status_code < 300
            @events.clear
            return TransportResponse.new(response.status_code, attempt)
          end
          next if response.status_code >= 500 && attempt < max_attempts

          raise SdkError.new("transport_error", "unexpected transport status #{response.status_code}")
        rescue TransportError => error
          next if error.retryable && attempt < max_attempts

          raise SdkError.new(error.code, error.message)
        end
      end
      raise SdkError.new("transport_error", "exhausted retries")
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

      with_metadata(
        {
          "name" => name,
          "traceId" => trace_id,
          "spanId" => span_id
        }.tap do |payload|
          payload["parentSpanId"] = parent_span_id unless parent_span_id.nil?
          payload["status"] = status
          payload["durationMs"] = duration_ms unless duration_ms.nil?
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
end
