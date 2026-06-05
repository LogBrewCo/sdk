.PHONY: help run run-readme-example run-real-user-smoke

help:
	@printf '%s\n' \
		'run-readme-example -> make run-readme-example' \
		'run (real-user-smoke) -> make run' \
		'run-real-user-smoke -> make run-real-user-smoke'

run: run-real-user-smoke

run-readme-example:
	@cargo run --quiet --example readme_example --manifest-path ../Cargo.toml

run-real-user-smoke:
	@cargo run --quiet --example real_user_smoke --manifest-path ../Cargo.toml
