# frozen_string_literal: true

require "logger"
require "rack/mock"

ENV["RAILS_ENV"] = "production"
ENV["LOGBREW_SERVER_API_KEY"] = "LOGBREW_SERVER_API_KEY"
ENV["LOGBREW_ENDPOINT"] = ENV.fetch("LOGBREW_CAPTURE_ENDPOINT")
ENV["LOGBREW_RELEASE"] = "checkout@1.2.3"
ENV["LOGBREW_ENVIRONMENT"] = "production"
ENV["LOGBREW_SERVICE_NAME"] = "checkout-api"
ENV["LOGBREW_CAPTURE_RAILS_LOGS"] = "true"

require "rails"
require "action_controller/railtie"
require "logbrew-sdk"

class CheckoutProbe < Rails::Application
  config.root = __dir__
  config.secret_key_base = "capture-probe-secret-key-base"
  config.eager_load = false
  config.logger = Logger.new(File::NULL, level: Logger::INFO)
  config.hosts.clear
end
CheckoutProbe.initialize!

class CheckoutController < ActionController::Base
  protect_from_forgery with: :exception

  around_action do |_controller, action|
    LogBrew::Telemetry.with_context(LogBrew::TelemetryContext.create.with_subject(id: "user_123", kind: "user").build) { action.call }
  end

  def show
    Rails.logger.info("checkout started")
    render json: { ok: true }
  end

  def fail
    Rails.logger.warn("payment step failing")
    raise "payment declined"
  end
end

CheckoutProbe.routes.draw do
  get "/checkout/:cart_id", to: "checkout#show"
  get "/fail/:cart_id", to: "checkout#fail"
end

requests = Rack::MockRequest.new(CheckoutProbe)
traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
abort "success request failed" unless requests.get("/checkout/cart-1", "HTTP_TRACEPARENT" => traceparent).status == 200
abort "failing request did not fail" unless requests.get("/fail/cart-2", "HTTP_TRACEPARENT" => traceparent).status == 500
LogBrew::Rails.shutdown
