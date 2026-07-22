# frozen_string_literal: true

require_relative "http_client_tracing_support"

http_tracing_test("Net::HTTP is an exact no-parent pass-through") do
  http_require_tracing
  client = http_client
  callback_errors = []
  delegate = HttpTracingFakeNetHttp.new
  wrapped = LogBrew::HttpClientTracing.wrap_net_http(delegate, client: client, on_capture_error: ->(error) { callback_errors << error })
  request = Net::HTTP::Get.new("/sensitive/path?#{http_sensitive_query_key}=hidden")
  request["traceparent"] = "caller-value"
  response = wrapped.request(request)

  http_assert(response.equal?(delegate.request(Net::HTTP::Get.new("/control"))), "expected exact response object")
  http_assert(delegate.seen_traceparents.first == "caller-value", "expected caller header pass-through")
  http_assert(request["traceparent"] == "caller-value", "expected caller header unchanged")
  http_assert(http_events(client).empty?, "expected no span without parent")
  http_assert(callback_errors.empty?, "expected no callback without parent")
end

http_tracing_test("Net::HTTP no-parent skips tracing-only access") do
  http_require_tracing
  access_error = RuntimeError.new("tracing accessor failure")
  callback_errors = []
  client = http_client
  request = HttpTracingAccessNetRequest.new("/pass", method_error: access_error, snapshot_error: access_error)
  request["traceparent"] = "caller-value"
  delegate = HttpTracingAccessNetHttp.new(address_error: access_error)
  wrapped = LogBrew::HttpClientTracing.wrap_net_http(
    delegate,
    client: client,
    on_capture_error: ->(error) { callback_errors << error }
  )

  response = wrapped.request(request)

  http_assert(response.code == "202", "expected exact no-parent response")
  http_assert(request.method_reads.zero?, "expected no method access")
  http_assert(request.snapshot_reads.zero?, "expected no header snapshot access")
  http_assert(delegate.address_reads.zero?, "expected no address access")
  http_assert(callback_errors.empty?, "expected no callback")
  http_assert(http_events(client).empty?, "expected no span")
end

http_tracing_test("Net::HTTP setup failures stay advisory") do
  http_require_tracing
  metadata_error = RuntimeError.new("metadata failure detail")
  snapshot_error = RuntimeError.new("snapshot failure detail")
  app_error = IOError.new("original app failure")
  callback_errors = []
  client = http_client

  response_delegate = HttpTracingFakeNetHttp.new
  metadata_request = HttpTracingAccessNetRequest.new("/metadata", method_error: metadata_error)
  metadata_wrapper = LogBrew::HttpClientTracing.wrap_net_http(
    response_delegate,
    client: client,
    on_capture_error: ->(error) { callback_errors << error }
  )
  response = LogBrew::Trace.with_context(http_parent) { metadata_wrapper.request(metadata_request) }

  error_delegate = HttpTracingFakeNetHttp.new(error: app_error)
  snapshot_request = HttpTracingAccessNetRequest.new("/snapshot", snapshot_error: snapshot_error)
  snapshot_request["traceparent"] = "caller-value"
  snapshot_wrapper = LogBrew::HttpClientTracing.wrap_net_http(
    error_delegate,
    client: client,
    on_capture_error: ->(error) { callback_errors << error }
  )
  raised = nil
  begin
    LogBrew::Trace.with_context(http_parent) { snapshot_wrapper.request(snapshot_request) }
  rescue IOError => error
    raised = error
  end

  http_assert(response.code == "202", "expected setup-failure response")
  http_assert(raised.equal?(app_error), "expected original setup-failure exception")
  http_assert(snapshot_request["traceparent"] == "caller-value", "expected unchanged caller header")
  http_assert(callback_errors == [metadata_error, snapshot_error], "expected one callback per setup failure")
  http_assert(http_events(client).empty?, "expected no partial setup spans")
end

http_tracing_test("host normalization omits IP-like forms") do
  omitted = ["127.0.0.1", "::1", "127.1", "2130706433", "12.34.56"]

  omitted.each do |value|
    http_assert(LogBrew::HttpClientTracing.normalize_host(value).nil?, "expected omitted IP-like host")
  end
  http_assert(
    LogBrew::HttpClientTracing.normalize_host("API.Example.TEST.") == "api.example.test",
    "expected normalized domain"
  )
end

http_tracing_test("Net::HTTP propagates one child and returns the request header") do
  http_require_tracing
  client = http_client
  delegate = HttpTracingFakeNetHttp.new
  wrapped = LogBrew::HttpClientTracing.wrap_net_http(delegate, client: client)
  request = Net::HTTP::Post.new("/sensitive/path?#{http_sensitive_query_key}=hidden")
  request["traceparent"] = "caller-value"
  request["authorization"] = "Bearer hidden"
  request.body = "sensitive-body"
  parent = http_parent

  caller_parent = nil
  response = LogBrew::Trace.with_context(parent) do
    result = wrapped.request(request)
    caller_parent = LogBrew::Trace.current
    result
  end
  propagated = http_traceparent_parts(delegate.seen_traceparents.fetch(0))
  span = http_span(client)
  metadata = span.fetch("metadata")

  http_assert(response.code == "202", "expected response")
  http_assert(propagated == ["00", parent.trace_id, span.fetch("spanId"), parent.trace_flags], "expected exact child traceparent")
  http_assert(request["traceparent"] == "caller-value", "expected caller header restoration")
  http_assert(caller_parent.equal?(parent), "expected caller trace state")
  http_assert(span.fetch("traceId") == parent.trace_id, "expected parent trace")
  http_assert(span.fetch("parentSpanId") == parent.span_id, "expected parent span")
  http_assert(span.fetch("status") == "ok", "expected success span")
  http_assert(metadata == {
    "method" => "POST",
    "host" => "api.example.test",
    "statusCode" => 202,
    "source" => "net_http",
    "sampled" => true
  }, "expected fixed metadata")
  serialized = JSON.generate(span)
  (%w[sensitive/path hidden sensitive-body authorization scheme port query fragment] + [http_sensitive_query_key]).each do |forbidden|
    http_assert(!serialized.include?(forbidden), "expected #{forbidden} privacy")
  end
end

http_tracing_test("Net::HTTP preserves start blocks, streaming, and return values") do
  http_require_tracing
  server = HttpTracingServer.new("/stream" => { body: "streamed-body" })
  begin
    client = http_client
    uri = URI("#{server.endpoint}/stream")
    wrapped = LogBrew::HttpClientTracing.wrap_net_http(Net::HTTP.new(uri.host, uri.port), client: client)
    yielded_client = nil
    yielded_response = nil
    chunks = []
    parent = http_parent

    response = LogBrew::Trace.with_context(parent) do
      wrapped.start do |started|
        yielded_client = started
        started.request(Net::HTTP::Get.new(uri.request_uri)) do |stream|
          yielded_response = stream
          stream.read_body { |chunk| chunks << chunk }
          :ignored_block_result
        end
      end
    end

    http_assert(yielded_client.equal?(wrapped), "expected wrapped started client")
    http_assert(response.equal?(yielded_response), "expected Net::HTTP response return")
    http_assert(chunks.join == "streamed-body", "expected streamed body")
    http_assert(http_events(client).length == 1, "expected one span across start/request recursion")
  ensure
    server.close
  end
end

http_tracing_test("Net::HTTP start without a block keeps the tracing wrapper") do
  http_require_tracing
  client = http_client
  delegate = HttpTracingFakeNetHttp.new
  wrapped = LogBrew::HttpClientTracing.wrap_net_http(delegate, client: client)

  started = wrapped.start
  LogBrew::Trace.with_context(http_parent) { started.request(Net::HTTP::Get.new("/started")) }

  http_assert(started.equal?(wrapped), "expected caller-visible tracing wrapper")
  http_assert(delegate.started?, "expected delegate connection to remain started")
  http_assert(http_events(client).length == 1, "expected started request tracing")
end

http_tracing_test("Net::HTTP preserves exact exceptions and completes once") do
  http_require_tracing
  client = http_client
  error = IOError.new("sensitive failure text")
  delegate = HttpTracingFakeNetHttp.new(error: error)
  wrapped = LogBrew::HttpClientTracing.wrap_net_http(delegate, client: client)
  request = Net::HTTP::Get.new("/sensitive")
  request["traceparent"] = "caller-value"
  raised = nil

  begin
    LogBrew::Trace.with_context(http_parent) { wrapped.request(request) }
  rescue IOError => captured
    raised = captured
  end

  span = http_span(client)
  http_assert(raised.equal?(error), "expected exact exception object")
  http_assert(request["traceparent"] == "caller-value", "expected header restoration after exception")
  http_assert(http_events(client).length == 1, "expected exact-once exception span")
  http_assert(span.fetch("status") == "error", "expected error span")
  http_assert(span.fetch("metadata").fetch("exceptionType") == "IOError", "expected exception type")
  http_assert(!JSON.generate(span).include?(error.message), "expected exception message privacy")
end

http_tracing_test("Net::HTTP repeated sends get distinct children and duplicate wrapping is idempotent") do
  http_require_tracing
  client = http_client
  delegate = HttpTracingFakeNetHttp.new
  wrapped = LogBrew::HttpClientTracing.wrap_net_http(delegate, client: client)
  duplicate = LogBrew::HttpClientTracing.wrap_net_http(wrapped, client: client)
  parent = http_parent

  LogBrew::Trace.with_context(parent) do
    duplicate.request(Net::HTTP::Get.new("/one"))
    duplicate.request(Net::HTTP::Get.new("/two"))
  end

  spans = http_events(client).map { |event| event.fetch("attributes") }
  http_assert(duplicate.equal?(wrapped), "expected duplicate wrapping to return existing wrapper")
  http_assert(spans.length == 2, "expected one span per send")
  http_assert(spans.map { |span| span.fetch("spanId") }.uniq.length == 2, "expected distinct child spans")
  http_assert(delegate.seen_traceparents.uniq.length == 2, "expected distinct propagated children")
end

http_tracing_test("Net::HTTP capture failures stay advisory") do
  http_require_tracing
  client = http_client
  client.shutdown(LogBrew::RecordingTransport.always_accept)
  callback_errors = []
  delegate = HttpTracingFakeNetHttp.new
  wrapped = LogBrew::HttpClientTracing.wrap_net_http(delegate, client: client, on_capture_error: ->(error) { callback_errors << error })

  response = LogBrew::Trace.with_context(http_parent) { wrapped.request(Net::HTTP::Get.new("/ok")) }

  http_assert(response.code == "202", "expected app response")
  http_assert(callback_errors.length == 1, "expected one capture callback")
end

http_tracing_test("Net::HTTP partial injection failure returns pass-through state") do
  http_require_tracing
  injection_error = RuntimeError.new("injection failure detail")
  callback_errors = []
  client = http_client
  delegate = HttpTracingFakeNetHttp.new
  request = HttpTracingHostileInjectNetRequest.new("/inject", injection_error)
  request["traceparent"] = "caller-value"
  request.arm
  wrapped = LogBrew::HttpClientTracing.wrap_net_http(
    delegate,
    client: client,
    on_capture_error: ->(error) { callback_errors << error }
  )

  response = LogBrew::Trace.with_context(http_parent) { wrapped.request(request) }

  http_assert(response.code == "202", "expected Net::HTTP pass-through response")
  http_assert(delegate.seen_traceparents == ["caller-value"], "expected original pass-through header")
  http_assert(request["traceparent"] == "caller-value", "expected caller header after injection failure")
  http_assert(callback_errors == [injection_error], "expected injection callback")
  http_assert(http_events(client).empty?, "expected no span after failed injection")
end

http_tracing_test("Net::HTTP status capture failure preserves the response") do
  http_require_tracing
  status_error = RuntimeError.new("status failure detail")
  callback_errors = []
  client = http_client
  response = HttpTracingHostileStatusResponse.new(status_error)
  delegate = HttpTracingFakeNetHttp.new(response: response)
  wrapped = LogBrew::HttpClientTracing.wrap_net_http(
    delegate,
    client: client,
    on_capture_error: ->(error) { callback_errors << error }
  )

  returned = LogBrew::Trace.with_context(http_parent) { wrapped.request(Net::HTTP::Get.new("/status")) }

  http_assert(returned.equal?(response), "expected exact response after status capture failure")
  http_assert(callback_errors == [status_error], "expected status capture callback")
  http_assert(http_events(client).length == 1, "expected status-less completion span")
  http_assert(!http_span(client).fetch("metadata").key?("statusCode"), "expected omitted unavailable status")
end

http_tracing_test("Net::HTTP restoration failures cannot replace success or error") do
  http_require_tracing
  reset_error = RuntimeError.new("caller-state failure detail")
  callback_errors = []
  client = http_client
  success_delegate = HttpTracingFakeNetHttp.new
  success_request = HttpTracingHostileNetRequest.new("/success", reset_error)
  success_request["traceparent"] = "caller-value"
  success_request.fail_reset = true
  success_wrapper = LogBrew::HttpClientTracing.wrap_net_http(
    success_delegate,
    client: client,
    on_capture_error: ->(error) { callback_errors << error }
  )

  response = LogBrew::Trace.with_context(http_parent) { success_wrapper.request(success_request) }
  http_assert(response.code == "202", "expected success despite restoration failure")

  app_error = IOError.new("original app failure")
  error_delegate = HttpTracingFakeNetHttp.new(error: app_error)
  error_request = HttpTracingHostileNetRequest.new("/error", reset_error)
  error_request["traceparent"] = "caller-value"
  error_request.fail_reset = true
  error_wrapper = LogBrew::HttpClientTracing.wrap_net_http(
    error_delegate,
    client: client,
    on_capture_error: ->(error) { callback_errors << error }
  )
  raised = nil
  begin
    LogBrew::Trace.with_context(http_parent) { error_wrapper.request(error_request) }
  rescue IOError => captured
    raised = captured
  end

  http_assert(raised.equal?(app_error), "expected original app error despite restoration failure")
  http_assert(callback_errors == [reset_error, reset_error], "expected fixed caller-state callbacks")
  http_assert(http_events(client).length == 2, "expected exact-once spans despite restoration failures")
end

http_tracing_test("SDK self-delivery is suppressed and cannot recurse") do
  http_require_tracing
  server = HttpTracingServer.new("/v1/events" => { status: 202, body: "" })
  begin
    uri = URI(server.endpoint)
    client = http_client
    client.log("evt_app_log", "2026-07-20T12:00:00Z", message: "app event", level: "info")
    wrapped = LogBrew::HttpClientTracing.wrap_net_http(Net::HTTP.new(uri.host, uri.port), client: client)
    transport = LogBrew::HttpTransport.new(endpoint: "#{server.endpoint}/v1/events", http_client: wrapped)

    LogBrew::Trace.with_context(http_parent) { client.flush(transport) }
    record = Timeout.timeout(2) { server.records.pop }

    http_assert(record.headers["traceparent"].nil?, "expected no SDK propagation")
    http_assert(JSON.parse(record.body).fetch("events").length == 1, "expected no recursive span")
    http_assert(client.pending_events.zero?, "expected accepted app event")
  ensure
    server.close
  end
end

http_tracing_test("Faraday is an exact no-parent pass-through") do
  http_require_tracing
  client = http_client
  callback_errors = []
  seen = nil
  connection = Faraday.new("http://example.test") do |builder|
    builder.use LogBrew::FaradayTracingMiddleware, client: client, on_capture_error: ->(error) { callback_errors << error }
    builder.adapter(:test) do |stub|
      stub.get("/sensitive") do |env|
        seen = env.request_headers["traceparent"]
        [200, { "content-type" => "text/plain" }, "exact-body"]
      end
    end
  end

  response = connection.get("/sensitive") { |request| request.headers["traceparent"] = "caller-value" }

  http_assert(response.status == 200 && response.body == "exact-body", "expected exact Faraday response")
  http_assert(seen == "caller-value", "expected caller propagation pass-through")
  http_assert(response.env.request_headers["traceparent"] == "caller-value", "expected caller header unchanged")
  http_assert(http_events(client).empty?, "expected no Faraday span without parent")
  http_assert(callback_errors.empty?, "expected no Faraday callback without parent")
end

http_tracing_test("Faraday no-parent skips tracing-only access") do
  http_require_tracing
  access_error = RuntimeError.new("tracing accessor failure")
  callback_errors = []
  client = http_client
  response = HttpTracingImmediateResponse.new(202)
  app = HttpTracingPassThroughApp.new(response: response)
  middleware = LogBrew::FaradayTracingMiddleware.new(
    app,
    client: client,
    on_capture_error: ->(error) { callback_errors << error }
  )
  env = HttpTracingAccessFaradayEnv.new(
    method_error: access_error,
    url_error: access_error,
    header_error: access_error
  )

  returned = middleware.call(env)

  http_assert(returned.equal?(response), "expected exact no-parent Faraday response")
  http_assert(app.call_count == 1, "expected one no-parent Faraday call")
  http_assert([env.method_reads, env.url_reads, env.header_reads] == [0, 0, 0], "expected no tracing access")
  http_assert(callback_errors.empty?, "expected no Faraday callback")
  http_assert(http_events(client).empty?, "expected no Faraday span")
end

http_tracing_test("Faraday setup failures stay advisory") do
  http_require_tracing
  metadata_error = RuntimeError.new("metadata failure detail")
  snapshot_error = RuntimeError.new("snapshot failure detail")
  app_error = IOError.new("original app failure")
  callback_errors = []
  client = http_client

  response = HttpTracingImmediateResponse.new(202)
  response_app = HttpTracingPassThroughApp.new(response: response)
  metadata_middleware = LogBrew::FaradayTracingMiddleware.new(
    response_app,
    client: client,
    on_capture_error: ->(error) { callback_errors << error }
  )
  metadata_env = HttpTracingAccessFaradayEnv.new(url_error: metadata_error)
  returned = LogBrew::Trace.with_context(http_parent) { metadata_middleware.call(metadata_env) }

  error_app = HttpTracingPassThroughApp.new(error: app_error)
  snapshot_middleware = LogBrew::FaradayTracingMiddleware.new(
    error_app,
    client: client,
    on_capture_error: ->(error) { callback_errors << error }
  )
  snapshot_env = HttpTracingAccessFaradayEnv.new(header_error: snapshot_error)
  raised = nil
  begin
    LogBrew::Trace.with_context(http_parent) { snapshot_middleware.call(snapshot_env) }
  rescue IOError => error
    raised = error
  end

  http_assert(returned.equal?(response), "expected exact setup-failure Faraday response")
  http_assert(raised.equal?(app_error), "expected original setup-failure Faraday exception")
  http_assert(response_app.call_count == 1 && error_app.call_count == 1, "expected one call per setup failure")
  http_assert(callback_errors == [metadata_error, snapshot_error], "expected one Faraday callback per setup failure")
  http_assert(http_events(client).empty?, "expected no partial Faraday setup spans")
end

http_tracing_test("Faraday propagates one child and returns caller headers") do
  http_require_tracing
  client = http_client
  seen = nil
  connection = Faraday.new("http://API.Example.TEST.:8443") do |builder|
    builder.use LogBrew::FaradayTracingMiddleware, client: client
    builder.adapter(:test) do |stub|
      stub.post("/sensitive?#{http_sensitive_query_key}=hidden") do |env|
        seen = env.request_headers["traceparent"]
        [201, { "set-cookie" => "sensitive" }, "sensitive-response"]
      end
    end
  end
  parent = http_parent
  caller_parent = nil
  response = LogBrew::Trace.with_context(parent) do
    result = connection.post("/sensitive?#{http_sensitive_query_key}=hidden", "sensitive-body") do |request|
      request.headers["traceparent"] = "caller-value"
      request.headers["authorization"] = "Bearer hidden"
    end
    caller_parent = LogBrew::Trace.current
    result
  end
  span = http_span(client)

  http_assert(response.status == 201, "expected Faraday status")
  http_assert(http_traceparent_parts(seen) == ["00", parent.trace_id, span.fetch("spanId"), parent.trace_flags], "expected Faraday child")
  http_assert(response.env.request_headers["traceparent"] == "caller-value", "expected Faraday header restoration")
  http_assert(caller_parent.equal?(parent), "expected Faraday caller trace state")
  http_assert(span.fetch("metadata") == {
    "method" => "POST",
    "host" => "api.example.test",
    "statusCode" => 201,
    "source" => "faraday",
    "sampled" => true
  }, "expected fixed Faraday metadata")
  serialized = JSON.generate(span)
  (%w[8443 sensitive hidden sensitive-body sensitive-response set-cookie authorization scheme port query fragment] + [http_sensitive_query_key]).each do |forbidden|
    http_assert(!serialized.include?(forbidden), "expected Faraday #{forbidden} privacy")
  end
end

http_tracing_test("Faraday preserves middleware completion order") do
  http_require_tracing
  client = http_client
  order = []
  connection = Faraday.new("http://example.test") do |builder|
    builder.use HttpTracingOrderMiddleware, events: order, label: "outer"
    builder.use LogBrew::FaradayTracingMiddleware, client: client
    builder.use HttpTracingOrderMiddleware, events: order, label: "inner"
    builder.adapter(:test) { |stub| stub.get("/") { [204, {}, ""] } }
  end

  response = LogBrew::Trace.with_context(http_parent) { connection.get("/") }

  http_assert(response.status == 204, "expected middleware response")
  http_assert(order == %w[outer.call inner.call inner.complete outer.complete], "expected middleware order")
  http_assert(http_events(client).length == 1, "expected one middleware span")
end

http_tracing_test("Faraday preserves exact errors and completes once") do
  http_require_tracing
  client = http_client
  error = RuntimeError.new("sensitive Faraday failure")
  connection = Faraday.new("http://example.test") do |builder|
    builder.use LogBrew::FaradayTracingMiddleware, client: client
    builder.adapter(:test) { |stub| stub.get("/") { raise error } }
  end
  raised = nil

  begin
    LogBrew::Trace.with_context(http_parent) { connection.get("/") }
  rescue RuntimeError => captured
    raised = captured
  end

  span = http_span(client)
  http_assert(raised.equal?(error), "expected exact Faraday exception")
  http_assert(http_events(client).length == 1, "expected one Faraday error span")
  http_assert(span.fetch("status") == "error", "expected Faraday error status")
  http_assert(span.fetch("metadata").fetch("exceptionType") == "RuntimeError", "expected Faraday exception type")
  http_assert(!JSON.generate(span).include?(error.message), "expected Faraday exception message privacy")
end

http_tracing_test("Faraday deferred completion uses the captured operation") do
  http_require_tracing
  client = http_client
  app = HttpTracingDeferredApp.new
  middleware = LogBrew::FaradayTracingMiddleware.new(app, client: client)
  env = Faraday::Env.from(method: :get, url: URI("http://example.test/deferred"), request_headers: Faraday::Utils::Headers.new)
  env.request_headers["traceparent"] = "caller-value"
  parent = http_parent

  returned = LogBrew::Trace.with_context(parent) { middleware.call(env) }
  http_assert(returned.equal?(app.response), "expected deferred response object")
  http_assert(env.request_headers["traceparent"] == "caller-value", "expected immediate deferred header restoration")
  http_assert(http_traceparent_parts(app.seen_traceparent)[1] == parent.trace_id, "expected captured propagation")
  http_assert(LogBrew::Trace.current.nil?, "expected parent scope closed")

  completion_env = Faraday::Env.from(status: 202)
  Thread.new { app.response.complete(completion_env) }.join
  span = http_span(client)
  http_assert(span.fetch("traceId") == parent.trace_id, "expected captured trace on completion thread")
  http_assert(span.fetch("parentSpanId") == parent.span_id, "expected captured parent on completion thread")
end

http_tracing_test("Faraday restoration failures cannot replace success or error") do
  http_require_tracing
  reset_error = RuntimeError.new("caller-state failure detail")
  callback_errors = []
  client = http_client
  success_headers = HttpTracingHostileHeaders.new(reset_error)
  success_app = HttpTracingImmediateApp.new(
    response: HttpTracingImmediateResponse.new(202),
    after_call: -> { success_headers.fail_reset = true }
  )
  success_middleware = LogBrew::FaradayTracingMiddleware.new(
    success_app,
    client: client,
    on_capture_error: ->(error) { callback_errors << error }
  )
  success_env = Faraday::Env.from(method: :get, url: URI("http://example.test/success"))
  success_env.request_headers = success_headers

  response = LogBrew::Trace.with_context(http_parent) { success_middleware.call(success_env) }
  http_assert(response.status == 202, "expected Faraday success despite restoration failure")

  app_error = IOError.new("original Faraday failure")
  error_headers = HttpTracingHostileHeaders.new(reset_error)
  error_app = HttpTracingImmediateApp.new(error: app_error, after_call: -> { error_headers.fail_reset = true })
  error_middleware = LogBrew::FaradayTracingMiddleware.new(
    error_app,
    client: client,
    on_capture_error: ->(error) { callback_errors << error }
  )
  error_env = Faraday::Env.from(method: :get, url: URI("http://example.test/error"))
  error_env.request_headers = error_headers
  raised = nil
  begin
    LogBrew::Trace.with_context(http_parent) { error_middleware.call(error_env) }
  rescue IOError => captured
    raised = captured
  end

  http_assert(raised.equal?(app_error), "expected original Faraday error despite restoration failure")
  http_assert(callback_errors == [reset_error, reset_error], "expected Faraday caller-state callbacks")
  http_assert(http_events(client).length == 2, "expected Faraday exact-once spans")
end

http_tracing_test("Faraday completion registration failure closes the operation") do
  http_require_tracing
  registration_error = RuntimeError.new("registration failure detail")
  callback_errors = []
  client = http_client
  response = HttpTracingImmediateResponse.new(202, registration_error: registration_error)
  app = HttpTracingImmediateApp.new(response: response)
  middleware = LogBrew::FaradayTracingMiddleware.new(
    app,
    client: client,
    on_capture_error: ->(error) { callback_errors << error }
  )
  env = Faraday::Env.from(method: :get, url: URI("http://example.test/registration"), request_headers: Faraday::Utils::Headers.new)

  returned = LogBrew::Trace.with_context(http_parent) { middleware.call(env) }

  http_assert(returned.equal?(response), "expected original response after registration failure")
  http_assert(callback_errors == [registration_error], "expected registration callback")
  http_assert(http_events(client).length == 1, "expected operation completion after registration failure")
  http_assert(http_span(client).fetch("metadata").fetch("statusCode") == 202, "expected available response status")
end

http_tracing_test("Faraday concurrent out-of-order responses stay isolated") do
  http_require_tracing
  server = HttpTracingServer.new(
    "/slow" => { status: 202, delay: 0.08 },
    "/fast" => { status: 503, delay: 0.0 }
  )
  begin
    client = http_client
    connection = Faraday.new(server.endpoint) do |builder|
      builder.use LogBrew::FaradayTracingMiddleware, client: client
      builder.adapter :net_http
    end
    parents = [
      http_parent(trace_id: "11111111111111111111111111111111", span_id: "2222222222222222"),
      http_parent(trace_id: "33333333333333333333333333333333", span_id: "4444444444444444")
    ]
    paths = %w[/slow /fast]
    threads = paths.each_with_index.map do |path, index|
      Thread.new { LogBrew::Trace.with_context(parents[index]) { connection.get(path) } }
    end
    responses = threads.map(&:value)
    spans = http_events(client).map { |event| event.fetch("attributes") }

    http_assert(responses.map(&:status).sort == [202, 503], "expected concurrent responses")
    http_assert(spans.length == 2, "expected concurrent spans")
    parents.each do |parent|
      span = spans.find { |candidate| candidate.fetch("traceId") == parent.trace_id }
      http_assert(span && span.fetch("parentSpanId") == parent.span_id, "expected isolated parent")
    end
    statuses = spans.map { |span| span.fetch("metadata").fetch("statusCode") }.sort
    http_assert(statuses == [202, 503], "expected isolated status")
  ensure
    server.close
  end
end

http_tracing_test("Faraday retries create distinct children") do
  http_require_tracing
  client = http_client
  attempts = 0
  seen = []
  connection = Faraday.new("http://example.test") do |builder|
    builder.use HttpTracingRetryOnceMiddleware
    builder.use LogBrew::FaradayTracingMiddleware, client: client
    builder.adapter(:test) do |stub|
      stub.get("/") do |env|
        attempts += 1
        seen << env.request_headers["traceparent"]
        [attempts == 1 ? 503 : 202, {}, ""]
      end
    end
  end

  response = LogBrew::Trace.with_context(http_parent) { connection.get("/") }
  spans = http_events(client).map { |event| event.fetch("attributes") }

  http_assert(response.status == 202, "expected retry response")
  http_assert(attempts == 2, "expected two attempts")
  http_assert(spans.length == 2, "expected one span per attempt")
  http_assert(seen.uniq.length == 2, "expected distinct retry headers")
  http_assert(spans.map { |span| span.fetch("spanId") }.uniq.length == 2, "expected distinct retry children")
end

http_tracing_test("duplicate Faraday middleware emits one span") do
  http_require_tracing
  client = http_client
  connection = Faraday.new("http://example.test") do |builder|
    builder.use LogBrew::FaradayTracingMiddleware, client: client
    builder.use LogBrew::FaradayTracingMiddleware, client: client
    builder.adapter(:test) { |stub| stub.get("/") { [200, {}, ""] } }
  end

  LogBrew::Trace.with_context(http_parent) { connection.get("/") }
  http_assert(http_events(client).length == 1, "expected duplicate middleware suppression")
end

http_tracing_test("Faraday capture failures stay advisory") do
  http_require_tracing
  client = http_client
  client.shutdown(LogBrew::RecordingTransport.always_accept)
  callback_errors = []
  connection = Faraday.new("http://example.test") do |builder|
    builder.use LogBrew::FaradayTracingMiddleware, client: client, on_capture_error: ->(error) { callback_errors << error }
    builder.adapter(:test) { |stub| stub.get("/") { [200, {}, "ok"] } }
  end

  response = LogBrew::Trace.with_context(http_parent) { connection.get("/") }
  http_assert(response.status == 200 && response.body == "ok", "expected Faraday app response")
  http_assert(callback_errors.length == 1, "expected one Faraday capture callback")
end

http_tracing_test("Faraday partial injection failure returns pass-through state") do
  http_require_tracing
  injection_error = RuntimeError.new("injection failure detail")
  callback_errors = []
  client = http_client
  headers = HttpTracingHostileInjectHeaders.new(injection_error)
  headers["traceparent"] = "caller-value"
  headers.arm
  response = HttpTracingImmediateResponse.new(202)
  app = HttpTracingImmediateApp.new(response: response)
  middleware = LogBrew::FaradayTracingMiddleware.new(
    app,
    client: client,
    on_capture_error: ->(error) { callback_errors << error }
  )
  env = Faraday::Env.from(method: :get, url: URI("http://example.test/inject"))
  env.request_headers = headers

  returned = LogBrew::Trace.with_context(http_parent) { middleware.call(env) }

  http_assert(returned.equal?(response), "expected Faraday pass-through response")
  http_assert(app.seen_traceparent == "caller-value", "expected Faraday original pass-through header")
  http_assert(headers["traceparent"] == "caller-value", "expected Faraday caller header after injection failure")
  http_assert(callback_errors == [injection_error], "expected Faraday injection callback")
  http_assert(http_events(client).empty?, "expected no Faraday span after failed injection")
end

failures = []
HTTP_TRACING_TESTS.each do |name, test|
  test.call
rescue StandardError => error
  failures << [name, error]
end

if failures.any?
  failures.each { |name, error| warn "FAIL #{name}: #{error.class}: #{error.message}" }
  raise "ruby HTTP client tracing tests failed (#{failures.length}/#{HTTP_TRACING_TESTS.length})"
end

puts "ruby HTTP client tracing tests ok (#{HTTP_TRACING_TESTS.length} tests)"
