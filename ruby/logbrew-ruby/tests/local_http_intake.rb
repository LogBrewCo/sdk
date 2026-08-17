# frozen_string_literal: true

require "socket"

HttpIntakeRecord = Struct.new(:method, :path, :headers, :body, keyword_init: true)

class LocalHttpIntake
  attr_reader :endpoint, :records, :last_method, :last_path, :last_authorization, :last_content_type,
              :last_source, :last_body, :bodies, :request_count

  def initialize(statuses = [202], host: "127.0.0.1", path: "/v1/events", concurrent: false, split: false, &response)
    @server = TCPServer.new("127.0.0.1", 0)
    @endpoint = "http://#{host}:#{@server.addr[1]}#{path}"
    @statuses = statuses.dup
    @response = response
    @concurrent = concurrent
    @split = split
    @records = Queue.new
    @workers = []
    @bodies = []
    @request_count = 0
    @closed = false
    @thread = Thread.new { accept_loop }
  end

  def close
    @closed = true
    @server.close unless @server.closed?
    @thread.join(2)
    @workers.each { |worker| worker.join(2) }
  end

  private

  def accept_loop
    until @closed
      socket = @server.accept
      worker = @concurrent ? Thread.new(socket) { |accepted| serve(accepted) } : serve(socket)
      @workers << worker if worker.is_a?(Thread)
    end
  rescue IOError, Errno::EBADF
    nil
  end

  def serve(socket)
    handle(socket)
  ensure
    socket.close unless socket.closed?
  end

  def handle(socket)
    request = socket.gets.to_s.strip.split(" ")
    headers = {}
    while (line = socket.gets)
      line = line.chomp
      break if line.empty?

      name, value = line.split(":", 2)
      headers[name.to_s.downcase] = value.to_s.strip
    end
    body = socket.read(headers.fetch("content-length", "0").to_i).to_s
    record = HttpIntakeRecord.new(method: request[0].to_s, path: request[1].to_s, headers: headers, body: body)
    @records << record
    @last_method, @last_path, @last_body = record.method, record.path, body
    @last_authorization = headers.fetch("authorization", "")
    @last_content_type = headers.fetch("content-type", "")
    @last_source = headers.fetch("x-logbrew-source", "")
    @bodies << body
    @request_count += 1
    status, payload = @response ? @response.call(record) : [@statuses.shift || 202, ""]
    socket.write("HTTP/1.1 #{status} OK\r\nContent-Length: #{payload.bytesize}\r\nConnection: close\r\n\r\n")
    midpoint = @split ? payload.bytesize / 2 : payload.bytesize
    socket.write(payload.byteslice(0, midpoint))
    socket.flush
    sleep(0.01) if @split && payload.bytesize > 1
    socket.write(payload.byteslice(midpoint, payload.bytesize - midpoint))
  end
end
