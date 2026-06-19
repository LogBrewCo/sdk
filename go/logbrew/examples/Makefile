.PHONY: help run run-agent-timeline run-first-useful-telemetry run-http-client-trace run-http-trace-correlation run-readme-example run-real-user-smoke

help:
	@printf '%s\n' \
		'run-agent-timeline -> make run-agent-timeline' \
		'run-first-useful-telemetry -> make run-first-useful-telemetry' \
		'run-http-client-trace -> make run-http-client-trace' \
		'run-http-trace-correlation -> make run-http-trace-correlation' \
		'run-readme-example -> make run-readme-example' \
		'run (real-user-smoke) -> make run' \
		'run-real-user-smoke -> make run-real-user-smoke'

run: run-real-user-smoke

run-agent-timeline:
	@go run ./agent_timeline

run-first-useful-telemetry:
	@go run ./first_useful_telemetry

run-http-client-trace:
	@go run ./http_client_trace

run-http-trace-correlation:
	@go run ./http_trace_correlation

run-readme-example:
	@go run ./readme_example

run-real-user-smoke:
	@go run ./real_user_smoke
