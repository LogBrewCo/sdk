# frozen_string_literal: true

require "time"

module LogBrew
  # Privacy-bounded builders and validators for first-class issue evidence.
  #
  # Generated exception frames contain code identity only. They are newest
  # first, use basename-only filenames, and never include source text, local
  # variables, arguments, raw stack strings, or exception messages.
  module IssueDiagnostics
    MAX_STACK_FRAMES = 32
    MAX_BREADCRUMBS = 64
    MAX_EXCEPTION_TYPE = 256
    MAX_MECHANISM_TYPE = 64
    MAX_FRAME_FILENAME = 2_048
    MAX_FRAME_FUNCTION = 256
    MAX_FRAME_MODULE = 512
    MAX_BREADCRUMB_NAME = 64
    MAX_BREADCRUMB_MESSAGE = 512
    MAX_BREADCRUMB_DATA_FIELDS = 8
    MAX_BREADCRUMB_DATA_STRING = 256
    MAX_COORDINATE = 2_147_483_647

    MACHINE_NAME = /\A[A-Za-z][A-Za-z0-9_.:-]{0,63}\z/.freeze
    DATA_KEY = /\A[A-Za-z][A-Za-z0-9_.-]{0,63}\z/.freeze
    DEBUG_ID = /\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\z/.freeze
    RFC3339 = /\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})\z/.freeze
    CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/.freeze
    BREADCRUMB_LEVELS = {
      "trace" => "debug",
      "debug" => "debug",
      "log" => "info",
      "info" => "info",
      "warn" => "warning",
      "warning" => "warning",
      "error" => "error",
      "fatal" => "critical",
      "critical" => "critical"
    }.freeze

    module_function

    # Build a complete issue attribute payload from an exception. Exception
    # text remains application-controlled through the explicit message option.
    def from_exception(
      error,
      title: nil,
      level: "error",
      message: nil,
      mechanism_type: "ruby.exception",
      handled: true,
      metadata: nil,
      breadcrumbs: nil,
      breadcrumbs_truncated: false,
      include_stack_frames: true,
      context: nil
    )
      unless error.is_a?(Exception)
        raise validation("issue error must be an exception")
      end

      exception_type = safe_exception_type(error)
      attributes = {
        "title" => title.nil? ? exception_type : title,
        "level" => level,
        "exception" => exception(
          type: exception_type,
          mechanism_type: mechanism_type,
          handled: handled
        )
      }
      attributes["message"] = message unless message.nil?
      if include_stack_frames
        frames = stack_frames_from_exception(error)
        attributes["stackFrames"] = frames unless frames.empty?
      end
      attributes["breadcrumbs"] = breadcrumbs unless breadcrumbs.nil?
      attributes["breadcrumbsTruncated"] = true if breadcrumbs_truncated
      attributes["metadata"] = metadata unless metadata.nil?
      validated = validate_issue_attributes(attributes)
      unless context.nil?
        unless context.is_a?(TelemetryContext)
          raise validation("issue context must be a LogBrew::TelemetryContext")
        end
        validated["context"] = context
      end
      validated
    end

    # Build a typed exception identity and optional observation mechanism.
    def exception(type:, mechanism_type: nil, handled: nil)
      value = { "type" => require_text("issue exception type", type, MAX_EXCEPTION_TYPE, true) }
      unless mechanism_type.nil? && handled.nil?
        if mechanism_type.nil? || (handled != true && handled != false)
          raise validation("issue exception mechanism must include type and handled")
        end
        value["mechanism"] = {
          "type" => require_machine_name(
            "issue exception mechanism type",
            mechanism_type,
            MAX_MECHANISM_TYPE,
            true
          ),
          "handled" => handled
        }
      end
      value
    end

    # Build one explicit structured frame. Absolute filenames are reduced to
    # their basename and URL query or fragment text is removed.
    def stack_frame(
      filename:,
      line:,
      column: 1,
      function: nil,
      module_name: nil,
      in_app: nil,
      debug_id: nil
    )
      frame = {
        "filename" => filename,
        "line" => line,
        "column" => column
      }
      frame["function"] = function unless function.nil?
      frame["module"] = module_name unless module_name.nil?
      frame["inApp"] = in_app unless in_app.nil?
      frame["debugId"] = debug_id unless debug_id.nil?
      validate_stack_frame(frame)
    end

    # Project an exception backtrace into at most 32 newest-first code frames.
    def stack_frames_from_exception(error)
      unless error.is_a?(Exception)
        raise validation("issue error must be an exception")
      end

      locations = safe_backtrace_locations(error)
      frames = locations.first(MAX_STACK_FRAMES).map { |location| frame_from_location(location) }.compact
      return frames unless frames.empty?

      safe_backtrace(error).first(MAX_STACK_FRAMES).map { |line| frame_from_backtrace_line(line) }.compact
    end

    # Build one oldest-to-newest breadcrumb with bounded flat primitive data.
    def breadcrumb(timestamp:, category:, type: nil, level: nil, message: nil, data: nil)
      value = {
        "timestamp" => timestamp,
        "category" => category
      }
      value["type"] = type unless type.nil?
      value["level"] = level unless level.nil?
      value["message"] = message unless message.nil?
      value["data"] = data unless data.nil?
      validate_breadcrumb(value)
    end

    # Validate and detach a complete issue attribute payload.
    def validate_issue_attributes(attributes)
      unless attributes.is_a?(Hash)
        raise validation("issue attributes must be an object")
      end

      title = read_required(attributes, "title", "issue title")
      Validation.require_non_empty("issue title", title)
      level = read_required(attributes, "level", "issue level")
      Validation.require_allowed_value("issue level", level, SEVERITY_VALUES)
      payload = {
        "title" => copy_string(title),
        "level" => SEVERITY_ALIASES.fetch(level)
      }

      if has_key?(attributes, "message")
        message = read_value(attributes, "message")
        unless message.is_a?(String) && message.valid_encoding?
          raise validation("issue message must be a string")
        end
        payload["message"] = message.dup
      end
      payload["exception"] = validate_exception(read_value(attributes, "exception")) if has_key?(attributes, "exception")
      payload["stackFrames"] = validate_stack_frames(read_value(attributes, "stackFrames")) if has_key?(attributes, "stackFrames")
      payload["breadcrumbs"] = validate_breadcrumbs(read_value(attributes, "breadcrumbs")) if has_key?(attributes, "breadcrumbs")
      if has_key?(attributes, "breadcrumbsTruncated")
        truncated = read_value(attributes, "breadcrumbsTruncated")
        unless truncated == true || truncated == false
          raise validation("issue breadcrumbsTruncated must be a boolean")
        end
        payload["breadcrumbsTruncated"] = true if truncated
      end

      if has_key?(attributes, "metadata")
        metadata = Validation.require_metadata(read_value(attributes, "metadata"))
        payload["metadata"] = detach_metadata(metadata) unless metadata.nil?
      end
      payload
    end

    def validate_exception(input)
      unless input.is_a?(Hash)
        raise validation("issue exception must be an object")
      end
      reject_unknown_keys(input, %w[type mechanism], "issue exception")
      type = read_required(input, "type", "issue exception type")
      value = {
        "type" => require_text("issue exception type", type, MAX_EXCEPTION_TYPE, true)
      }
      return value unless has_key?(input, "mechanism")

      mechanism = read_value(input, "mechanism")
      unless mechanism.is_a?(Hash)
        raise validation("issue exception mechanism must be an object")
      end
      reject_unknown_keys(mechanism, %w[type handled], "issue exception mechanism")
      mechanism_type = read_required(mechanism, "type", "issue exception mechanism type")
      handled = read_required(mechanism, "handled", "issue exception mechanism handled")
      unless handled == true || handled == false
        raise validation("issue exception mechanism handled must be a boolean")
      end
      value["mechanism"] = {
        "type" => require_machine_name(
          "issue exception mechanism type",
          mechanism_type,
          MAX_MECHANISM_TYPE,
          true
        ),
        "handled" => handled
      }
      value
    end

    def validate_stack_frames(input)
      unless input.is_a?(Array) && input.length.between?(1, MAX_STACK_FRAMES)
        raise validation("issue stackFrames must contain 1-32 frames")
      end
      input.map { |frame| validate_stack_frame(frame) }
    end

    def validate_stack_frame(input)
      unless input.is_a?(Hash)
        raise validation("issue stack frame must be an object")
      end
      reject_unknown_keys(input, %w[filename line column function module inApp debugId], "issue stack frame")
      filename = read_required(input, "filename", "issue stack frame filename")
      line = require_coordinate("issue stack frame line", read_required(input, "line", "issue stack frame line"))
      column = require_coordinate(
        "issue stack frame column",
        read_required(input, "column", "issue stack frame column")
      )
      value = {
        "filename" => sanitize_filename(filename),
        "line" => line,
        "column" => column
      }
      if has_key?(input, "function")
        value["function"] = require_text(
          "issue stack frame function",
          read_value(input, "function"),
          MAX_FRAME_FUNCTION,
          false
        )
      end
      if has_key?(input, "module")
        value["module"] = require_text(
          "issue stack frame module",
          read_value(input, "module"),
          MAX_FRAME_MODULE,
          true
        )
      end
      if has_key?(input, "inApp")
        in_app = read_value(input, "inApp")
        unless in_app == true || in_app == false
          raise validation("issue stack frame inApp must be a boolean")
        end
        value["inApp"] = in_app
      end
      if has_key?(input, "debugId")
        debug_id = read_value(input, "debugId")
        normalized = debug_id.is_a?(String) ? debug_id.strip.downcase : ""
        raise validation("issue stack frame debugId is invalid") unless normalized.match?(DEBUG_ID)

        value["debugId"] = normalized
      end
      value
    end

    def validate_breadcrumbs(input)
      unless input.is_a?(Array) && input.length.between?(1, MAX_BREADCRUMBS)
        raise validation("issue breadcrumbs must contain 1-64 entries")
      end
      input.map { |item| validate_breadcrumb(item) }
    end

    def validate_breadcrumb(input)
      unless input.is_a?(Hash)
        raise validation("issue breadcrumb must be an object")
      end
      reject_unknown_keys(input, %w[timestamp type category level message data], "issue breadcrumb")
      timestamp = read_required(input, "timestamp", "issue breadcrumb timestamp")
      require_breadcrumb_timestamp(timestamp)
      category = read_required(input, "category", "issue breadcrumb category")
      value = {
        "timestamp" => timestamp.dup,
        "category" => require_machine_name(
          "issue breadcrumb category",
          category,
          MAX_BREADCRUMB_NAME,
          true
        )
      }
      if has_key?(input, "type")
        value["type"] = require_machine_name(
          "issue breadcrumb type",
          read_value(input, "type"),
          MAX_BREADCRUMB_NAME,
          true
        )
      end
      if has_key?(input, "level")
        level = read_value(input, "level")
        normalized = level.is_a?(String) ? BREADCRUMB_LEVELS[level] : nil
        unless normalized
          raise validation(
            "issue breadcrumb level must be one of: trace, debug, info, log, warn, warning, error, fatal, critical"
          )
        end
        value["level"] = normalized
      end
      if has_key?(input, "message")
        value["message"] = require_text(
          "issue breadcrumb message",
          read_value(input, "message"),
          MAX_BREADCRUMB_MESSAGE,
          false
        )
      end
      value["data"] = validate_breadcrumb_data(read_value(input, "data")) if has_key?(input, "data")
      value
    end

    def validate_breadcrumb_data(input)
      unless input.is_a?(Hash)
        raise validation("issue breadcrumb data must be an object")
      end
      if input.length > MAX_BREADCRUMB_DATA_FIELDS
        raise validation("issue breadcrumb data must contain at most 8 fields")
      end

      input.each_with_object({}) do |(raw_key, raw_value), copied|
        key = raw_key.to_s
        unless key.match?(DATA_KEY)
          raise validation("issue breadcrumb data keys must be stable machine names")
        end
        copied[key] = validate_breadcrumb_data_value(key, raw_value)
      end
    end

    def validate_breadcrumb_data_value(key, value)
      return value if value.nil? || value == true || value == false || value.is_a?(Integer)
      return value if value.is_a?(Float) && value.finite?
      if value.is_a?(String)
        return require_text(
          "issue breadcrumb data value for #{key}",
          value,
          MAX_BREADCRUMB_DATA_STRING,
          false
        )
      end

      raise validation("issue breadcrumb data value for #{key} must be a finite primitive")
    end

    def safe_exception_type(error)
      candidate = error.class.name
      candidate = "anonymous_exception" if candidate.nil? || candidate.to_s.strip.empty?
      safe_generated_text(candidate, MAX_EXCEPTION_TYPE, true, "Exception")
    rescue StandardError
      "Exception"
    end

    def safe_backtrace_locations(error)
      locations = error.backtrace_locations
      locations.respond_to?(:first) ? locations.first(MAX_STACK_FRAMES) : []
    rescue StandardError
      []
    end

    def safe_backtrace(error)
      backtrace = error.backtrace
      backtrace.is_a?(Array) ? backtrace.first(MAX_STACK_FRAMES) : []
    rescue StandardError
      []
    end

    def frame_from_location(location)
      path = safe_location_value(location, :absolute_path) || safe_location_value(location, :path)
      filename = generated_filename(path)
      line = safe_location_value(location, :lineno)
      line = 1 unless line.is_a?(Integer) && line.between?(1, MAX_COORDINATE)
      function = safe_generated_text(safe_location_value(location, :base_label), MAX_FRAME_FUNCTION, false, nil)
      frame = { "filename" => filename, "line" => line, "column" => 1 }
      frame["function"] = function unless function.nil?
      validate_stack_frame(frame)
    rescue StandardError
      nil
    end

    def frame_from_backtrace_line(line)
      return nil unless line.is_a?(String) && line.valid_encoding?

      match = line.match(/\A(.+):(\d+)(?::in [`'](.+?)[`'])?\z/)
      return nil unless match

      line_number = match[2].to_i
      line_number = 1 unless line_number.between?(1, MAX_COORDINATE)
      function = safe_generated_text(match[3], MAX_FRAME_FUNCTION, false, nil)
      frame = {
        "filename" => generated_filename(match[1]),
        "line" => line_number,
        "column" => 1
      }
      frame["function"] = function unless function.nil?
      validate_stack_frame(frame)
    rescue StandardError
      nil
    end

    def safe_location_value(location, method_name)
      return nil unless location.respond_to?(method_name)

      location.public_send(method_name)
    rescue StandardError
      nil
    end

    def generated_filename(path)
      candidate = path.is_a?(String) ? path : "unknown.rb"
      filename = sanitize_filename(candidate)
      basename(filename)
    rescue SdkError
      "unknown.rb"
    end

    def sanitize_filename(value)
      unless value.is_a?(String) && value.valid_encoding?
        raise validation("issue stack frame filename is invalid")
      end

      filename = value.strip
      file_url = filename.downcase.start_with?("file://")
      filename = filename[7..-1] if file_url
      query = filename.index("?")
      fragment = filename.index("#")
      finish = [query, fragment].compact.min
      filename = filename[0...finish] unless finish.nil?
      filename = filename.strip
      absolute = file_url || filename.start_with?("/", "\\") || filename.match?(/\A[A-Za-z]:[\\\/]/)
      filename = basename(filename) if absolute
      require_text("issue stack frame filename", filename, MAX_FRAME_FILENAME, true)
    end

    def basename(value)
      value.tr("\\", "/").split("/").last.to_s
    end

    def require_coordinate(label, value)
      unless value.is_a?(Integer) && value.between?(1, MAX_COORDINATE)
        raise validation("#{label} must be a positive integer")
      end
      value
    end

    def require_breadcrumb_timestamp(value)
      unless value.is_a?(String) && value.valid_encoding? && value.match?(RFC3339)
        raise validation("issue breadcrumb timestamp must be RFC 3339 with an explicit timezone")
      end
      Time.iso8601(value)
    rescue ArgumentError
      raise validation("issue breadcrumb timestamp must be RFC 3339 with an explicit timezone")
    end

    def require_machine_name(label, value, maximum, allow_colon)
      normalized = value.is_a?(String) ? value.strip : ""
      pattern = allow_colon ? MACHINE_NAME : DATA_KEY
      unless normalized.length <= maximum && normalized.match?(pattern)
        raise validation("#{label} must be a stable machine name")
      end
      normalized.dup
    end

    def require_text(label, value, maximum, reject_location_text)
      unless value.is_a?(String) && value.valid_encoding? && !value.strip.empty? && value.length <= maximum &&
             !value.match?(CONTROL_CHARACTERS) && (!reject_location_text || !value.match?(/[?#]/))
        raise validation("#{label} is invalid or exceeds #{maximum} characters")
      end
      value.dup
    end

    def safe_generated_text(value, maximum, reject_location_text, fallback)
      return fallback if value.nil?

      require_text("generated issue text", value.to_s, maximum, reject_location_text)
    rescue SdkError
      fallback
    end

    def read_required(input, key, label)
      raise validation("#{label} must be provided") unless has_key?(input, key)

      read_value(input, key)
    end

    def read_value(input, key)
      return input[key] if input.key?(key)

      input[key.to_sym]
    end

    def has_key?(input, key)
      input.key?(key) || input.key?(key.to_sym)
    end

    def reject_unknown_keys(input, allowed, label)
      unknown = input.keys.map(&:to_s).reject { |key| allowed.include?(key) }
      return if unknown.empty?

      raise validation("#{label} contains unsupported field #{unknown.first}")
    end

    def detach_metadata(metadata)
      metadata.each_with_object({}) do |(key, value), copied|
        copied[key.to_s.dup] = value.is_a?(String) ? value.dup : value
      end
    end

    def copy_string(value)
      value.is_a?(String) ? value.dup : value
    end

    def validation(message)
      SdkError.new("validation_error", message)
    end

    private_class_method(
      :validate_exception,
      :validate_stack_frames,
      :validate_stack_frame,
      :validate_breadcrumbs,
      :validate_breadcrumb,
      :validate_breadcrumb_data,
      :validate_breadcrumb_data_value,
      :safe_backtrace_locations,
      :safe_backtrace,
      :frame_from_location,
      :frame_from_backtrace_line,
      :safe_location_value,
      :generated_filename,
      :sanitize_filename,
      :basename,
      :require_coordinate,
      :require_breadcrumb_timestamp,
      :require_machine_name,
      :require_text,
      :safe_generated_text,
      :read_required,
      :read_value,
      :has_key?,
      :reject_unknown_keys,
      :detach_metadata,
      :copy_string,
      :validation
    )
  end
end
