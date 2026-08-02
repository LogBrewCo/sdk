# frozen_string_literal: true

require "json"
require "logbrew"

module CheckoutFailureFixture
  def self.fail_checkout
    raise RuntimeError, "sensitive provider response fixture"
  end
end

client = LogBrew::Client.create(
  api_key: "LOGBREW_API_KEY",
  sdk_name: "checkout-ruby-service",
  sdk_version: "1.4.2"
)
breadcrumbs = [
  LogBrew::IssueDiagnostics.breadcrumb(
    timestamp: "2026-08-02T10:14:58.125+00:00",
    category: "checkout.navigation",
    type: "navigation",
    level: "info",
    message: "User reached payment review",
    data: { step: "payment" }
  ),
  LogBrew::IssueDiagnostics.breadcrumb(
    timestamp: "2026-08-02T10:14:59Z",
    category: "checkout.request",
    type: "http",
    level: "warn",
    data: { method: "POST", statusCode: 503 }
  )
]

begin
  CheckoutFailureFixture.fail_checkout
rescue RuntimeError => error
  client.issue(
    "evt_issue_checkout_failure",
    "2026-08-02T10:15:00Z",
    LogBrew::IssueDiagnostics.from_exception(
      error,
      message: "Checkout could not be completed.",
      mechanism_type: "ruby.exception",
      handled: true,
      metadata: { routeTemplate: "/checkout/:cart_id" },
      breadcrumbs: breadcrumbs
    )
  )
end

puts client.preview_json

response = client.shutdown(LogBrew::RecordingTransport.always_accept)
warn JSON.generate(ok: true, status: response.status_code, events: 1)
