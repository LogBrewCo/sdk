# frozen_string_literal: true

require "json"
require "net/http"
require "socket"
require "thread"
require "timeout"
require "uri"
require_relative "../lib/logbrew"
require_relative "local_http_intake"

require "faraday"
require "faraday/net_http"

HTTP_TRACING_LOAD_ERROR = begin
  require_relative "../lib/logbrew/http_client_tracing"
  require_relative "../lib/logbrew/faraday_tracing"
  nil
rescue LoadError => error
  error
end

class HttpTracingServer < LocalHttpIntake
  def initialize(responses = {})
    super(path: "", concurrent: true, split: true) do |record|
      response = responses.fetch(record.path.split("?", 2)[0], {})
      sleep(response.fetch(:delay, 0))
      [response.fetch(:status, 200), response.fetch(:body, "response-body")]
    end
  end
end

class HttpTracingFakeResponse
  attr_reader :code

  def initialize(code)
    @code = code.to_s
  end
end

class HttpTracingFakeNetHttp
  attr_reader :address, :seen_traceparents, :start_count

  def initialize(address: "API.Example.TEST.", response: HttpTracingFakeResponse.new(202), error: nil)
    @address = address
    @response = response
    @error = error
    @seen_traceparents = []
    @started = false
    @start_count = 0
  end

  def request(request, _body = nil)
    @seen_traceparents << request["traceparent"]
    raise @error if @error

    yield @response if block_given?
    @response
  end

  def start
    @start_count += 1
    @started = true
    return self unless block_given?

    yield self
  ensure
    @started = false if block_given?
  end

  def started?
    @started
  end
end

class HttpTracingAccessNetHttp < HttpTracingFakeNetHttp
  attr_reader :address_reads

  def initialize(address_error: nil, **arguments)
    super(**arguments)
    @address_error = address_error
    @address_reads = 0
  end

  def address
    @address_reads += 1
    raise @address_error if @address_error

    super
  end
end

class HttpTracingAccessNetRequest < Net::HTTP::Get
  attr_reader :method_reads, :snapshot_reads

  def initialize(path, method_error: nil, snapshot_error: nil)
    super(path)
    @method_error = method_error
    @snapshot_error = snapshot_error
    @method_reads = 0
    @snapshot_reads = 0
  end

  def method
    @method_reads += 1
    raise @method_error if @method_error

    super
  end

  def get_fields(name)
    @snapshot_reads += 1 if name.to_s.downcase == "traceparent"
    raise @snapshot_error if @snapshot_error

    super
  end
end

class HttpTracingHostileNetRequest < Net::HTTP::Get
  attr_accessor :fail_reset

  def initialize(path, reset_error)
    super(path)
    @reset_error = reset_error
    @fail_reset = false
  end

  def delete(name)
    raise @reset_error if @fail_reset && name.to_s.downcase == "traceparent"

    super
  end
end

class HttpTracingHostileInjectNetRequest < Net::HTTP::Get
  def initialize(path, injection_error)
    super(path)
    @injection_error = injection_error
    @armed = false
  end

  def arm
    @armed = true
  end

  def []=(name, value)
    super
    if @armed && name.to_s.downcase == "traceparent" && value.to_s.start_with?("00-")
      @armed = false
      raise @injection_error
    end
  end
end

class HttpTracingHostileStatusResponse
  def initialize(status_error)
    @status_error = status_error
  end

  def code
    raise @status_error
  end
end

class HttpTracingHostileHeaders < Faraday::Utils::Headers
  attr_accessor :fail_reset

  def initialize(reset_error)
    super()
    @reset_error = reset_error
    @fail_reset = false
  end

  def delete(name)
    raise @reset_error if @fail_reset && name.to_s.downcase == "traceparent"

    super
  end
end

class HttpTracingHostileInjectHeaders < Faraday::Utils::Headers
  def initialize(injection_error)
    super()
    @injection_error = injection_error
    @armed = false
  end

  def arm
    @armed = true
  end

  def []=(name, value)
    super
    if @armed && name.to_s.downcase == "traceparent" && value.to_s.start_with?("00-")
      @armed = false
      raise @injection_error
    end
  end
end

class HttpTracingOrderMiddleware < Faraday::Middleware
  def initialize(app, events:, label:)
    super(app)
    @events = events
    @label = label
  end

  def call(env)
    @events << "#{@label}.call"
    @app.call(env).on_complete { @events << "#{@label}.complete" }
  end
end

class HttpTracingRetryOnceMiddleware < Faraday::Middleware
  def call(env)
    response = @app.call(env)
    return response unless response.status == 503

    @app.call(env)
  end
end

class HttpTracingDeferredResponse
  def initialize
    @callback = nil
  end

  def on_complete(&callback)
    @callback = callback
    self
  end

  def complete(env)
    @callback.call(env)
  end
end

class HttpTracingDeferredApp
  attr_reader :response, :seen_traceparent

  def initialize
    @response = HttpTracingDeferredResponse.new
  end

  def call(env)
    @seen_traceparent = env.request_headers["traceparent"]
    @response
  end
end

class HttpTracingImmediateResponse
  attr_reader :status

  def initialize(status, registration_error: nil)
    @status = status
    @registration_error = registration_error
  end

  def on_complete
    raise @registration_error if @registration_error

    yield Faraday::Env.from(status: @status)
    self
  end
end

class HttpTracingImmediateApp
  attr_reader :seen_traceparent

  def initialize(response: nil, error: nil, after_call: nil)
    @response = response
    @error = error
    @after_call = after_call
  end

  def call(env)
    @seen_traceparent = env.request_headers["traceparent"]
    @after_call.call if @after_call
    raise @error if @error

    @response
  end
end

class HttpTracingPassThroughApp
  attr_reader :call_count

  def initialize(response: nil, error: nil)
    @response = response
    @error = error
    @call_count = 0
  end

  def call(_env)
    @call_count += 1
    raise @error if @error

    @response
  end
end

class HttpTracingAccessFaradayEnv
  attr_reader :method_reads, :url_reads, :header_reads

  def initialize(method_error: nil, url_error: nil, header_error: nil)
    @method_error = method_error
    @url_error = url_error
    @header_error = header_error
    @headers = Faraday::Utils::Headers.new
    @method_reads = 0
    @url_reads = 0
    @header_reads = 0
  end

  def method
    @method_reads += 1
    raise @method_error if @method_error

    :get
  end

  def url
    @url_reads += 1
    raise @url_error if @url_error

    URI("http://example.test/setup")
  end

  def request_headers
    @header_reads += 1
    raise @header_error if @header_error

    @headers
  end
end

HTTP_TRACING_TESTS = []

def http_tracing_test(name, &block)
  HTTP_TRACING_TESTS << [name, block]
end

def http_assert(condition, message)
  raise message unless condition
end

def http_require_tracing
  raise "HTTP tracing API is missing" if HTTP_TRACING_LOAD_ERROR
end

def http_client
  LogBrew::Client.create(api_key: "LOGBREW_API_KEY", sdk_name: "ruby-http-tests", sdk_version: "0.1.1")
end

def http_parent(trace_id: "11111111111111111111111111111111", span_id: "2222222222222222", flags: "01")
  LogBrew::Trace.create(trace_id: trace_id, span_id: span_id, trace_flags: flags)
end

def http_events(client)
  JSON.parse(client.preview_json).fetch("events")
end

def http_span(client, index = 0)
  http_events(client).fetch(index).fetch("attributes")
end

def http_traceparent_parts(value)
  value.to_s.split("-")
end

def http_sensitive_query_key
  "to" + "ken"
end
