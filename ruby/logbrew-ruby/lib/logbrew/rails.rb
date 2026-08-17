# frozen_string_literal: true

require "logbrew"
require "rails/railtie"
require_relative "rails_integration"

module LogBrew
  # Process-safe Rails integration installed by RailsRailtie.
  module Rails
    class << self
      def install(application:, environment: ENV)
        @installation_mutex ||= Mutex.new
        @installation_mutex.synchronize do
          return @runtime unless @runtime.nil?

          configuration = Configuration.from_environment(
            environment,
            application_name: application_name(application),
            rails_environment: ::Rails.env.to_s,
            rails_version: ::Rails.version.to_s
          )
          @runtime = Runtime.new(
            configuration,
            on_error: ->(stage, error) { log_capture_failure(application, stage, error) }
          )
          register_shutdown
          @runtime
        end
      end

      def client
        @runtime&.client
      end

      def delivery_health
        @runtime&.delivery_health
      end

      def shutdown
        @runtime&.shutdown
      end

      private

      def application_name(application)
        application_class = application.class
        if application_class.respond_to?(:module_parent_name)
          name = application_class.module_parent_name.to_s
          return name unless name.empty?
        end

        name = application_class.name.to_s.sub(/::Application\z/, "")
        name.empty? ? "rails" : name
      end

      def register_shutdown
        return if @shutdown_registered

        at_exit { shutdown }
        @shutdown_registered = true
      end

      def log_capture_failure(application, stage, error)
        logger = application.respond_to?(:logger) ? application.logger : nil
        logger ||= ::Rails.logger if ::Rails.respond_to?(:logger)
        return unless logger.respond_to?(:warn)

        logger.warn("LogBrew Rails #{stage} failed (#{error.class.name}); application behavior was preserved")
      rescue StandardError
        nil
      end
    end
  end

  class RailsRailtie < ::Rails::Railtie
    initializer "logbrew.install", after: :load_config_initializers do |application|
      runtime = LogBrew::Rails.install(application: application)
      if runtime.configuration.enabled?
        LogBrew::Rails.const_get(:RequestOperations).install(::ActiveSupport::Notifications)
        LogBrew::Rails.const_get(:OutboundHttp).install
      end
      ::ActiveSupport.on_load(:active_job) do
        prepend LogBrew::Rails::ActiveJobExtension unless ancestors.include?(LogBrew::Rails::ActiveJobExtension)
      end
      middleware = application.config.middleware
      if defined?(::ActionDispatch::ShowExceptions)
        middleware.insert_after(
          ::ActionDispatch::ShowExceptions,
          LogBrew::Rails::RequestMiddleware,
          runtime: runtime
        )
      else
        middleware.use(LogBrew::Rails::RequestMiddleware, runtime: runtime)
      end
    end

    config.after_initialize do |application|
      runtime = LogBrew::Rails.runtime
      next if runtime.nil? || !runtime.configuration.enabled?

      LogBrew::Rails.const_get(:ApplicationLogCapture).install(::Rails.logger, runtime, application_root: ::Rails.root)
      reporter = LogBrew::Rails::ErrorReporter.new(runtime)
      if ::Rails.respond_to?(:error) && ::Rails.error.respond_to?(:subscribe)
        ::Rails.error.subscribe(reporter)
      elsif application.respond_to?(:executor) && application.executor.respond_to?(:error_reporter)
        error_reporter = application.executor.error_reporter
        error_reporter.subscribe(reporter) if error_reporter.respond_to?(:subscribe)
      end
    end
  end
end
