# frozen_string_literal: true

require "faraday"
require_relative "../logbrew"

module LogBrew
  class FaradayTracingMiddleware < ::Faraday::Middleware
    def initialize(app, client:, on_capture_error: nil)
      super(app)
      @client = client
      @on_capture_error = on_capture_error
    end

    def call(env)
      prepared = HttpClientTracing.prepare(
        client: @client,
        source: "faraday",
        on_capture_error: @on_capture_error
      ) do
        url = env.url
        [env.method, url && url.host, HttpClientTracing::FaradayHeaderSnapshot.new(env.request_headers)]
      end
      return @app.call(env) unless prepared

      operation, header = prepared
      begin
        header.inject(operation.traceparent)
      rescue StandardError => error
        operation.capture_error(error)
        HttpClientTracing.reset_header(header, operation)
        return @app.call(env)
      end

      response = nil
      begin
        response = operation.around { @app.call(env) }
      rescue StandardError => error
        operation.finish(error: error)
        raise
      ensure
        HttpClientTracing.reset_header(header, operation)
      end

      begin
        response.on_complete do |completed|
          operation.finish(status_code: HttpClientTracing.read_status(completed, :status, operation))
        end
      rescue StandardError => error
        operation.capture_error(error)
        operation.finish(status_code: HttpClientTracing.read_status(response, :status, operation))
      end
      response
    end
  end
end
