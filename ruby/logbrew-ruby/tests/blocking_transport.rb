# frozen_string_literal: true

class BlockingTransport
  attr_reader :sent_bodies

  def initialize(status: 202, block_requests: nil)
    @status = status
    @remaining_blocks = block_requests
    @entered = Queue.new
    @release = Queue.new
    @sent_bodies = []
    @mutex = Mutex.new
  end

  def send(_api_key, body)
    blocked = @mutex.synchronize do
      @sent_bodies << body
      next true if @remaining_blocks.nil?
      next false unless @remaining_blocks.positive?

      @remaining_blocks -= 1
      true
    end
    if blocked
      @entered << true
      @release.pop
    end
    LogBrew::TransportResponse.new(@status, 1)
  end

  def wait_until_entered
    @entered.pop
  end

  def release
    @release << true
  end
end
