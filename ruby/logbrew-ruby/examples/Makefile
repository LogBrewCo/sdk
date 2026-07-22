.PHONY: help run run-readme-example run-real-user-smoke run-first-useful-telemetry run-http-trace-correlation run-persistent-worker-delivery run-automatic-delivery run-sidekiq-tracing

help:
	@printf '%s\n' 'run-readme-example -> make run-readme-example'
	@printf '%s\n' 'run (real-user-smoke) -> make run'
	@printf '%s\n' 'run-real-user-smoke -> make run-real-user-smoke'
	@printf '%s\n' 'run-first-useful-telemetry -> make run-first-useful-telemetry'
	@printf '%s\n' 'run-http-trace-correlation -> make run-http-trace-correlation'
	@printf '%s\n' 'run-persistent-worker-delivery -> make run-persistent-worker-delivery'
	@printf '%s\n' 'run-automatic-delivery -> make run-automatic-delivery'
	@printf '%s\n' 'run-sidekiq-tracing -> make run-sidekiq-tracing'

run: run-real-user-smoke

run-readme-example:
	@ruby readme_example.rb

run-real-user-smoke:
	@ruby real_user_smoke.rb

run-first-useful-telemetry:
	@ruby first_useful_telemetry.rb

run-http-trace-correlation:
	@ruby http_trace_correlation.rb

run-persistent-worker-delivery:
	@ruby persistent_worker_delivery.rb

run-automatic-delivery:
	@ruby automatic_delivery.rb

run-sidekiq-tracing:
	@ruby sidekiq_tracing.rb
