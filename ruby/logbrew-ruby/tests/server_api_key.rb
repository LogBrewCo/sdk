# frozen_string_literal: true

require_relative "../lib/logbrew"
require_relative "test_helpers"
include SdkTestHelpers

class KeyRecordingTransport
  attr_reader :api_keys

  def initialize
    @api_keys = []
  end

  def send(api_key, _body)
    @api_keys << api_key
    LogBrew::TransportResponse.new(202, 1)
  end
end

def sent_api_keys(**options)
  client = LogBrew::Client.create(sdk_name: "logbrew-ruby-test", sdk_version: "1.0.0", **options)
  client.log("evt_server_key_001", "2026-11-27T10:00:00Z", message: "first event", level: "info")
  transport = KeyRecordingTransport.new
  client.flush(transport)
  transport.api_keys
end

def with_server_api_key(value)
  previous = ENV.fetch("LOGBREW_SERVER_API_KEY", nil)
  ENV["LOGBREW_SERVER_API_KEY"] = value
  yield
ensure
  ENV["LOGBREW_SERVER_API_KEY"] = previous
end

with_server_api_key("env-server-key") do
  assert_values("client without key sends with LOGBREW_SERVER_API_KEY", sent_api_keys, ["env-server-key"])
  assert_values("explicit key wins", sent_api_keys(api_key: "explicit-key"), ["explicit-key"])
end

with_server_api_key(" ") do
  expect_sdk_error("configuration_error", "LOGBREW_SERVER_API_KEY") do
    LogBrew::Client.create(sdk_name: "logbrew-ruby-test", sdk_version: "1.0.0")
  end
end

puts "ruby server API key tests passed (3 tests)"
