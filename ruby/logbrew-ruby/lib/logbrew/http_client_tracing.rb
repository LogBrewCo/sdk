# frozen_string_literal: true

require "ipaddr"

module LogBrew
  class HttpClientTraceOperation
    attr_reader :context, :traceparent

    def initialize(client:, parent:, source:, method:, host:, on_capture_error:)
      @client = client
      @context = Trace.create(
        trace_id: parent.trace_id,
        span_id: Trace.generate_span_id,
        parent_span_id: parent.span_id,
        trace_flags: parent.trace_flags
      )
      @traceparent = Trace.create_headers(@context).fetch("traceparent")
      @source = source
      @method = HttpClientTracing.normalize_method(method)
      @host = HttpClientTracing.normalize_host(host)
      @on_capture_error = on_capture_error
      @started_at = HttpClientTracing.monotonic_time
      @mutex = Mutex.new
      @finished = false
    end

    def around
      HttpClientTracing.with_operation(self) { yield }
    end

    def finish(status_code: nil, error: nil)
      should_capture = @mutex.synchronize do
        next false if @finished

        @finished = true
        true
      end
      return unless should_capture

      capture(status_code, error)
    end

    def capture_error(error)
      HttpClientTracing.report_capture_error(@on_capture_error, error)
    end

    private

    def capture(status_code, error)
      normalized_status = HttpClientTracing.normalize_status_code(status_code)
      metadata = {
        method: @method,
        source: @source,
        sampled: @context.sampled
      }
      metadata[:host] = @host if @host
      metadata[:statusCode] = normalized_status if normalized_status
      metadata[:exceptionType] = error.class.name if error
      status = error || (normalized_status && normalized_status >= 400) ? "error" : "ok"

      @client.span(
        "ruby_http_span_#{@context.span_id}",
        Time.now.utc.iso8601,
        {
          name: "http.client:#{@method}",
          traceId: @context.trace_id,
          spanId: @context.span_id,
          parentSpanId: @context.parent_span_id,
          status: status,
          durationMs: ((HttpClientTracing.monotonic_time - @started_at) * 1000.0).round(3),
          metadata: metadata
        }
      )
    rescue StandardError => capture_error
      HttpClientTracing.report_capture_error(@on_capture_error, capture_error)
    end
  end

  class NetHttpTracingClient
    attr_reader :http

    def initialize(http, client:, on_capture_error: nil)
      @http = http
      @client = client
      @on_capture_error = on_capture_error
    end

    def request(request, body = nil, &block)
      prepared = HttpClientTracing.prepare(
        client: @client,
        source: "net_http",
        on_capture_error: @on_capture_error
      ) do
        [request.method, address, HttpClientTracing::NetHttpHeaderSnapshot.new(request)]
      end
      return @http.request(request, body, &block) unless prepared

      operation, header = prepared
      begin
        header.inject(operation.traceparent)
      rescue StandardError => error
        operation.capture_error(error)
        HttpClientTracing.reset_header(header, operation)
        return @http.request(request, body, &block)
      end

      response = nil
      begin
        response = operation.around { @http.request(request, body, &block) }
      rescue StandardError => error
        operation.finish(error: error)
        raise
      ensure
        HttpClientTracing.reset_header(header, operation)
      end
      operation.finish(status_code: HttpClientTracing.read_status(response, :code, operation))
      response
    end

    def start(*arguments)
      unless block_given?
        started = @http.start(*arguments)
        return started.equal?(@http) ? self : started
      end

      @http.start(*arguments) { yield self }
    end

    def method_missing(name, *arguments, &block)
      return super unless @http.respond_to?(name)

      @http.public_send(name, *arguments, &block)
    end

    def respond_to_missing?(name, include_private = false)
      @http.respond_to?(name, include_private) || super
    end
  end

  module HttpClientTracing
    ACTIVE_OPERATION_KEY = :logbrew_http_client_operation
    SUPPRESSION_KEY = :logbrew_http_client_suppression
    SOURCES = %w[net_http faraday].freeze
    private_constant :ACTIVE_OPERATION_KEY, :SUPPRESSION_KEY, :SOURCES

    class NetHttpHeaderSnapshot
      def initialize(request)
        @request = request
        @values = request.get_fields("traceparent")
      end

      def inject(traceparent)
        @request["traceparent"] = traceparent
      end

      def reset
        @request.delete("traceparent")
        Array(@values).each { |value| @request.add_field("traceparent", value) }
      end
    end

    class FaradayHeaderSnapshot
      def initialize(headers)
        @headers = headers
        @present = headers.key?("traceparent")
        @value = headers["traceparent"]
      end

      def inject(traceparent)
        @headers["traceparent"] = traceparent
      end

      def reset
        if @present
          @headers["traceparent"] = @value
        else
          @headers.delete("traceparent")
        end
      end
    end

    module_function

    def wrap_net_http(http, client:, on_capture_error: nil)
      return http if http.is_a?(NetHttpTracingClient)

      NetHttpTracingClient.new(http, client: client, on_capture_error: on_capture_error)
    end

    def prepare(client:, source:, on_capture_error: nil)
      parent = Trace.current
      return nil unless parent
      return nil if suppressed? || active_operation?
      return nil unless SOURCES.include?(source)

      method, host, header = yield
      operation = HttpClientTraceOperation.new(
        client: client,
        parent: parent,
        source: source,
        method: method,
        host: host,
        on_capture_error: on_capture_error
      )
      [operation, header]
    rescue StandardError => error
      report_capture_error(on_capture_error, error)
      nil
    end

    def with_operation(operation)
      previous = Thread.current[ACTIVE_OPERATION_KEY]
      Thread.current[ACTIVE_OPERATION_KEY] = operation
      Trace.with_context(operation.context) { yield }
    ensure
      Thread.current[ACTIVE_OPERATION_KEY] = previous
    end

    def suppress
      previous = Thread.current[SUPPRESSION_KEY]
      Thread.current[SUPPRESSION_KEY] = true
      yield
    ensure
      Thread.current[SUPPRESSION_KEY] = previous
    end

    def active_operation?
      !Thread.current[ACTIVE_OPERATION_KEY].nil?
    end

    def suppressed?
      Thread.current[SUPPRESSION_KEY] == true
    end

    def normalize_method(method)
      value = method.to_s.strip.upcase
      value.empty? ? "HTTP" : value[0, 32]
    end

    def normalize_host(host)
      value = host.to_s.strip.downcase.sub(/\.+\z/, "")
      return nil if value.empty? || value.bytesize > 253
      return nil if value.match?(/\A[0-9.]+\z/)
      return nil unless value.match?(/\A[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\z/)

      begin
        IPAddr.new(value)
        nil
      rescue IPAddr::InvalidAddressError
        value
      end
    end

    def normalize_status_code(status_code)
      value = status_code.to_i
      value.positive? && value <= 999 ? value : nil
    end

    def read_status(response, method, operation)
      response.public_send(method)
    rescue StandardError => error
      operation.capture_error(error)
      nil
    end

    def reset_header(header, operation)
      header.reset
    rescue StandardError => error
      operation.capture_error(error)
    end

    def monotonic_time
      Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end

    def report_capture_error(callback, error)
      callback.call(error) if callback.respond_to?(:call)
    rescue StandardError
      nil
    end
  end
end
