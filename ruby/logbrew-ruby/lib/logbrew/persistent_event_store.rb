# frozen_string_literal: true

module LogBrew
  class PersistentEventStore
    EVENT_FILE = /\A(\d{20})\.event\z/.freeze
    TEMP_FILE = /\A\.tmp-[0-9a-f]{32}\z/.freeze
    LOCK_FILE = ".lock"
    ACK_FILE = ".ack"

    StoredRecord = Struct.new(:sequence, :json, :bytes, :durable) do
      def initialize(sequence, json, bytes, durable = true)
        super(sequence, json.dup.freeze, bytes, durable)
        freeze
      end
    end

    def self.open(path:)
      validate_path(path)
      new(path)
    rescue SdkError
      raise
    rescue StandardError
      raise SdkError.new("persistent_queue_error", "persistent queue could not be opened")
    end

    def self.validate_path(path)
      unless path.is_a?(String) && !path.empty? && File.absolute_path(path) == path && File.expand_path(path) == path
        raise SdkError.new("validation_error", "persistent_queue_path must be a normalized absolute path")
      end
    rescue ArgumentError
      raise SdkError.new("validation_error", "persistent_queue_path must be a normalized absolute path")
    end
    private_class_method :validate_path

    def initialize(path)
      @path = path.dup.freeze
      @owner_process_id = current_process_id
      @mutex = Mutex.new
      @closed = false
      @failed = false
      @directory_sync_pending = false
      @records = []
      @acknowledged_sequence = 0
      @next_sequence = 1
      @directory_io = nil
      @directory_identity = nil
      @lock_io = nil

      prepare_directory
      open_directory
      acquire_lock
      recover
    rescue StandardError
      close_resources
      raise
    end
    private_class_method :new

    def records
      assert_process_ownership
      @mutex.synchronize do
        ensure_usable
        assert_directory_identity
        @records.dup.freeze
      end
    end

    def prepare_delivery
      assert_process_ownership
      @mutex.synchronize do
        ensure_usable
        assert_directory_identity
        confirm_directory_sync
      end
      nil
    end

    def append(json)
      assert_process_ownership
      @mutex.synchronize do
        ensure_usable
        assert_directory_identity
        confirm_directory_sync
        validate_event_json(json)
        sequence = @next_sequence
        directory_synced = write_atomic(event_file_name(sequence), json)
        record = StoredRecord.new(sequence, json, json.bytesize, directory_synced)
        @records << record
        @next_sequence += 1
        record
      rescue SdkError => error
        @failed = true unless error.code == "persistence_commit_error"
        raise
      rescue StandardError
        @failed = true
        raise SdkError.new("persistent_queue_error", "persistent queue could not store an event")
      end
    end

    # Returns a content-free compaction error only after the accepted marker is durable.
    def acknowledge(records)
      assert_process_ownership
      @mutex.synchronize do
        ensure_usable
        assert_directory_identity
        return nil if records.empty?

        confirm_directory_sync
        validate_prefix(records)
        accepted_sequence = records.last.sequence
        marker_synced = write_atomic(ACK_FILE, "#{accepted_sequence}\n")
        unless marker_synced
          raise SdkError.new("persistent_queue_error", "persistent queue acknowledgement durability is incomplete")
        end

        @acknowledged_sequence = accepted_sequence
        @records.shift(records.length)
        compact_records(records)
      rescue SdkError
        raise
      rescue StandardError
        raise SdkError.new("persistent_queue_error", "persistent queue could not acknowledge events")
      end
    end

    def close
      assert_process_ownership
      @mutex.synchronize do
        return if @closed

        @closed = true
        close_resources
      end
      nil
    end

    private

    def prepare_directory
      if File.exist?(@path) || File.symlink?(@path)
        validate_directory(File.lstat(@path))
        return
      end

      parent = File.dirname(@path)
      parent_stat = File.lstat(parent)
      unless parent_stat.directory?
        raise SdkError.new("validation_error", "persistent queue parent directory must exist")
      end

      Dir.mkdir(@path, 0o700)
      validate_directory(File.lstat(@path))
    rescue Errno::ENOENT
      raise SdkError.new("validation_error", "persistent queue parent directory must exist")
    end

    def validate_directory(stat)
      unless stat.directory? && !stat.symlink? && stat.uid == Process.uid && (stat.mode & 0o777) == 0o700
        raise SdkError.new("persistent_queue_error", "persistent queue must use an owner-only dedicated directory")
      end
    end

    def open_directory
      @directory_io = File.open(@path, File::RDONLY | File::NOFOLLOW)
      directory_stat = @directory_io.stat
      validate_directory(directory_stat)
      @directory_identity = [directory_stat.dev, directory_stat.ino].freeze
    end

    def acquire_lock
      assert_directory_identity
      lock_path = File.join(@path, LOCK_FILE)
      @lock_io = File.open(lock_path, File::RDWR | File::CREAT | File::NOFOLLOW, 0o600)
      validate_private_file(@lock_io.stat)
      unless @lock_io.flock(File::LOCK_EX | File::LOCK_NB)
        raise SdkError.new("persistent_queue_error", "persistent queue is already in use")
      end
    rescue Errno::EWOULDBLOCK, Errno::EAGAIN
      raise SdkError.new("persistent_queue_error", "persistent queue is already in use")
    end

    def recover
      assert_directory_identity
      entries = Dir.children(@path)
      unexpected = entries.reject do |entry|
        entry == LOCK_FILE || entry == ACK_FILE || EVENT_FILE.match?(entry) || TEMP_FILE.match?(entry)
      end
      unless unexpected.empty?
        raise SdkError.new("persistent_queue_error", "persistent queue contains unexpected entries")
      end

      entries.each { |entry| validate_known_entry(entry) }
      @acknowledged_sequence = read_acknowledged_sequence

      cleaned = false
      entries.grep(TEMP_FILE).each do |entry|
        File.unlink(File.join(@path, entry))
        cleaned = true
      end

      event_entries = entries.grep(EVENT_FILE).sort
      recovered = []
      event_entries.each do |entry|
        sequence = Integer(EVENT_FILE.match(entry)[1], 10)
        if sequence <= @acknowledged_sequence
          File.unlink(File.join(@path, entry))
          cleaned = true
          next
        end

        json = read_event(entry)
        recovered << StoredRecord.new(sequence, json, json.bytesize)
      end
      sync_directory if cleaned

      @records = recovered
      latest_sequence = [@acknowledged_sequence, recovered.empty? ? 0 : recovered.last.sequence].max
      @next_sequence = latest_sequence + 1
    rescue SdkError
      raise
    rescue StandardError
      raise SdkError.new("persistent_queue_error", "persistent queue contains unreadable records")
    end

    def validate_known_entry(entry)
      path = File.join(@path, entry)
      stat = File.lstat(path)
      validate_private_file(stat)
    rescue Errno::ENOENT
      raise SdkError.new("persistent_queue_error", "persistent queue changed during recovery")
    end

    def validate_private_file(stat)
      unless stat.file? && !stat.symlink? && stat.uid == Process.uid && (stat.mode & 0o077).zero?
        raise SdkError.new("persistent_queue_error", "persistent queue contains unsafe files")
      end
    end

    def read_acknowledged_sequence
      path = File.join(@path, ACK_FILE)
      return 0 unless File.exist?(path)

      content = read_private_file(path)
      unless /\A\d{1,20}\n?\z/.match?(content)
        raise SdkError.new("persistent_queue_error", "persistent queue contains unreadable records")
      end

      Integer(content, 10)
    end

    def read_event(entry)
      json = read_private_file(File.join(@path, entry))
      json.force_encoding(Encoding::UTF_8)
      validate_event_json(json)
      json.freeze
    end

    def read_private_file(path)
      File.open(path, File::RDONLY | File::NOFOLLOW) do |file|
        validate_private_file(file.stat)
        file.read
      end
    end

    def validate_event_json(json)
      unless json.is_a?(String) && json.encoding == Encoding::UTF_8 && json.valid_encoding? && !json.empty?
        raise SdkError.new("persistent_queue_error", "persistent queue contains unreadable records")
      end

      event = JSON.parse(json)
      valid = event.is_a?(Hash) && event["type"].is_a?(String) && !event["type"].empty? &&
              event["timestamp"].is_a?(String) && !event["timestamp"].empty? &&
              event["id"].is_a?(String) && !event["id"].empty? && event["attributes"].is_a?(Hash)
      unless valid && JSON.generate(event) == json
        raise SdkError.new("persistent_queue_error", "persistent queue contains unreadable records")
      end
    rescue JSON::ParserError, JSON::GeneratorError, EncodingError
      raise SdkError.new("persistent_queue_error", "persistent queue contains unreadable records")
    end

    def validate_prefix(records)
      expected = @records.first(records.length)
      unless expected.length == records.length && expected.map(&:sequence) == records.map(&:sequence)
        raise SdkError.new("persistent_queue_error", "persistent queue acknowledgement is stale")
      end
    end

    def compact_records(records)
      compaction_failed = false
      records.each do |record|
        begin
          File.unlink(File.join(@path, event_file_name(record.sequence)))
        rescue Errno::ENOENT
          nil
        rescue StandardError
          compaction_failed = true
        end
      end

      begin
        sync_directory
      rescue StandardError
        compaction_failed = true
      end

      if compaction_failed
        SdkError.new("persistent_queue_error", "persistent queue accepted-prefix compaction is incomplete")
      end
    end

    def write_atomic(destination_name, content)
      assert_directory_identity
      temp_name = ".tmp-#{SecureRandom.hex(16)}"
      temp_path = File.join(@path, temp_name)
      destination_path = File.join(@path, destination_name)
      renamed = false

      begin
        File.open(temp_path, File::WRONLY | File::CREAT | File::EXCL | File::NOFOLLOW, 0o600) do |file|
          file.write(content)
          file.flush
          file.fsync
        end
        assert_directory_identity
        File.rename(temp_path, destination_path)
        renamed = true
        begin
          sync_directory
          true
        rescue StandardError
          @directory_sync_pending = true
          false
        end
      ensure
        File.unlink(temp_path) if !renamed && File.exist?(temp_path)
      end
    end

    def sync_directory
      @directory_io.fsync
    end

    def confirm_directory_sync
      return unless @directory_sync_pending

      sync_directory
      @directory_sync_pending = false
    rescue StandardError
      raise SdkError.new("persistence_commit_error", "persistent queue durability is unconfirmed")
    end

    def assert_directory_identity
      stat = File.lstat(@path)
      current_identity = [stat.dev, stat.ino]
      unless current_identity == @directory_identity
        raise SdkError.new("persistent_queue_error", "persistent queue directory changed while in use")
      end

      validate_directory(stat)
    rescue SdkError
      raise
    rescue StandardError
      raise SdkError.new("persistent_queue_error", "persistent queue directory changed while in use")
    end

    def event_file_name(sequence)
      format("%020d.event", sequence)
    end

    def ensure_usable
      raise SdkError.new("persistent_queue_error", "persistent queue is closed") if @closed
      raise SdkError.new("persistent_queue_error", "persistent queue requires recovery") if @failed
    end

    def assert_process_ownership
      return if current_process_id == @owner_process_id

      raise SdkError.new("process_ownership_error", "persistent queue must be opened in the current process")
    end

    def current_process_id
      process_id = Process.pid
      unless process_id.is_a?(Integer) && process_id.positive?
        raise SdkError.new("process_ownership_error", "persistent queue process identity is unavailable")
      end

      process_id
    end

    def close_resources
      if @lock_io
        @lock_io.flock(File::LOCK_UN) rescue nil
        @lock_io.close rescue nil
        @lock_io = nil
      end
      if @directory_io
        @directory_io.close rescue nil
        @directory_io = nil
      end
    end
  end
  private_constant :PersistentEventStore
end
