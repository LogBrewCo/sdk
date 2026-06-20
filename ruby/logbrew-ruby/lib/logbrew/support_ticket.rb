# frozen_string_literal: true

module LogBrew
  # Local-only support-ticket payload drafts for explicit user or agent handoff.
  module SupportTicketDraft
    SOURCES = %w[cli sdk website docs mobile].freeze
    CATEGORIES = %w[
      sdk_install_failure
      ingest_failure
      auth_failure
      project_setup
      dashboard_issue
      docs_confusion
      cli_issue
      mobile_issue
      billing_question
      other
    ].freeze
    SENSITIVE_KEY_MARKERS = %w[
      apikey
      auth
      authorization
      authtoken
      bearer
      clientsecret
      connectionstring
      cookie
      credential
      dsn
      email
      errormessage
      exceptionmessage
      password
      passwd
      privatekey
      refreshtoken
      secret
      session
      setcookie
      stacktrace
      token
      traceback
    ].freeze
    REDACTED = "[redacted]"
    MAX_DEPTH = 5
    MAX_ARRAY_LENGTH = 20
    MAX_STRING_LENGTH = 500

    module_function

    def create(source:, category:, title:, description:, **options)
      Validation.require_allowed_value("support ticket source", source, SOURCES)
      Validation.require_allowed_value("support ticket category", category, CATEGORIES)

      draft = {
        "source" => source,
        "category" => category,
        "title" => required_string("support ticket title", title),
        "description" => required_string("support ticket description", description)
      }
      add_optional_string(draft, "project_id", options[:project_id])
      add_optional_string(draft, "environment", options[:environment])
      add_optional_string(draft, "runtime", options[:runtime])
      add_optional_string(draft, "framework", options[:framework])
      add_optional_string(draft, "sdk_package", options[:sdk_package])
      add_optional_string(draft, "sdk_version", options[:sdk_version])
      add_optional_string(draft, "release", options[:release])
      add_trace_id(draft, options[:trace_id])
      add_optional_string(draft, "event_id", options[:event_id])
      add_diagnostics(draft, options[:diagnostics]) if options.key?(:diagnostics)
      draft
    end

    def required_string(label, value)
      Validation.require_non_empty(label, value)
      value.strip
    end
    private_class_method :required_string

    def add_optional_string(draft, key, value)
      return if value.nil?

      draft[key] = required_string("support ticket #{key}", value)
    end
    private_class_method :add_optional_string

    def add_trace_id(draft, value)
      return if value.nil?

      normalized = value.to_s.strip.downcase
      unless normalized.match?(/\A[0-9a-f]{32}\z/) && !normalized.delete("0").empty?
        raise SdkError.new("validation_error", "support ticket trace_id must be 32 non-zero hex characters")
      end
      draft["trace_id"] = normalized
    end
    private_class_method :add_trace_id

    def add_diagnostics(draft, diagnostics)
      unless diagnostics.is_a?(Hash)
        raise SdkError.new("validation_error", "support ticket diagnostics must be an object")
      end

      sanitized = sanitize_diagnostic_hash(diagnostics, 0)
      draft["diagnostics"] = sanitized unless sanitized.empty?
    end
    private_class_method :add_diagnostics

    def sanitize_diagnostic_hash(value, depth)
      value.each_with_object({}) do |(key, child), safe|
        break safe if safe.length >= MAX_ARRAY_LENGTH

        normalized_key = key.to_s
        next if normalized_key.strip.empty?

        sanitized = if sensitive_key?(normalized_key)
                      REDACTED
                    else
                      sanitize_diagnostic_value(child, depth + 1)
                    end
        safe[normalized_key] = sanitized unless sanitized.nil?
      end
    end
    private_class_method :sanitize_diagnostic_hash

    def sanitize_diagnostic_value(value, depth)
      return { "type" => value.class.name } if value.is_a?(Exception)
      return nil if depth > MAX_DEPTH

      case value
      when nil, true, false, String, Integer
        sanitize_primitive(value)
      when Float
        value.finite? ? value : nil
      when Hash
        sanitize_diagnostic_hash(value, depth)
      when Array
        value.first(MAX_ARRAY_LENGTH).map { |item| sanitize_diagnostic_value(item, depth + 1) }.compact
      else
        nil
      end
    end
    private_class_method :sanitize_diagnostic_value

    def sanitize_primitive(value)
      return value unless value.is_a?(String)

      text = value.strip
      return "" if text.empty?
      return REDACTED if sensitive_string?(text)

      redacted = redact_url(redact_local_path(text))
      redacted.length > MAX_STRING_LENGTH ? "#{redacted[0, MAX_STRING_LENGTH]}..." : redacted
    end
    private_class_method :sanitize_primitive

    def sensitive_key?(key)
      normalized = key.downcase.gsub(/[^a-z0-9]/, "")
      SENSITIVE_KEY_MARKERS.any? { |marker| normalized.include?(marker) }
    end
    private_class_method :sensitive_key?

    def sensitive_string?(value)
      value.match?(/(?:authorization|api[_-]?key|token|secret|password|passwd|cookie)\s*[:=]/i) ||
        value.match?(/\bBearer\s+[A-Za-z0-9._~+\/=-]+/i) ||
        value.match?(/\blbw_(?:ingest|client|api)_[A-Za-z0-9._-]+/i) ||
        value.match?(/\b(?:github_pat|ghp|gho|npm|pypi|sk_live|sk_test|xox[baprs]|AKIA)[A-Za-z0-9._-]+/)
    end
    private_class_method :sensitive_string?

    def redact_local_path(value)
      return "[redacted-path]" if value.match?(/\A(?:\/Users\/|\/home\/|\/var\/folders\/|[A-Za-z]:\\)/)

      value
    end
    private_class_method :redact_local_path

    def redact_url(value)
      uri = URI.parse(value)
      return "[redacted-url]#{uri.path.empty? ? '/' : uri.path}" if uri.is_a?(URI::HTTP) && uri.host

      value.split(/[?#]/, 2)[0]
    rescue URI::InvalidURIError
      value.split(/[?#]/, 2)[0]
    end
    private_class_method :redact_url
  end
end
