.PHONY: help run run-readme-example run-real-user-smoke run-first-useful-telemetry run-http-server-request run-axum-request-middleware

help:
	@printf '%s\n' \
		'run-readme-example -> make run-readme-example' \
		'run (real-user-smoke) -> make run' \
		'run-real-user-smoke -> make run-real-user-smoke' \
		'run-first-useful-telemetry -> make run-first-useful-telemetry' \
		'run-http-server-request -> make run-http-server-request' \
		'run-axum-request-middleware -> make run-axum-request-middleware'

run: run-real-user-smoke

run-readme-example:
	@cargo run --quiet --example readme_example --manifest-path ../Cargo.toml

run-real-user-smoke:
	@cargo run --quiet --example real_user_smoke --manifest-path ../Cargo.toml

run-first-useful-telemetry:
	@cargo run --quiet --example first_useful_telemetry --manifest-path ../Cargo.toml

run-http-server-request:
	@cargo run --quiet --example http_server_request --manifest-path ../Cargo.toml

run-axum-request-middleware:
	@cargo run --quiet --example axum_request_middleware --manifest-path ../Cargo.toml
