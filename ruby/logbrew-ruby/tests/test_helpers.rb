# frozen_string_literal: true

module SdkTestHelpers
  def assert(condition, message)
    raise message unless condition
  end

  def assert_values(message, actual, expected)
    assert(actual == expected, "#{message}: #{actual.inspect}")
  end

  def expect_sdk_error(code, message_fragment = nil, forbidden: nil)
    yield
    raise "expected #{code}"
  rescue LogBrew::SdkError => error
    assert(error.code == code, "expected #{code}, got #{error.code}")
    unless message_fragment.nil?
      assert(error.message.include?(message_fragment), "expected error containing #{message_fragment}")
    end
    Array(forbidden).each { |text| assert(!error.message.include?(text), "error exposed forbidden text") }
    error
  end
end
