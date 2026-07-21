# frozen_string_literal: true

require "logbrew"
require "logbrew/sidekiq"
require "sidekiq"

transport = LogBrew::HttpTransport.new(timeout: 10)
client = LogBrew::Client.create_automatic(
  api_key: ENV.fetch("LOGBREW_API_KEY"),
  sdk_name: "checkout-worker",
  sdk_version: "1.0.0",
  transport: transport
)
instrumentation = LogBrew::Sidekiq::Instrumentation.create(client: client, max_retries: 25)

Sidekiq.configure_client { |config| instrumentation.register_client(config) }
Sidekiq.configure_server do |config|
  instrumentation.register_client(config)
  instrumentation.register_server(config)
  config.on(:quiet) { instrumentation.quiet }
  config.on(:shutdown) { instrumentation.shutdown }
end
