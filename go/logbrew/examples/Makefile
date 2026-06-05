.PHONY: help run run-readme-example run-real-user-smoke

help:
	@printf '%s\n' \
		'run-readme-example -> make run-readme-example' \
		'run (real-user-smoke) -> make run' \
		'run-real-user-smoke -> make run-real-user-smoke'

run: run-real-user-smoke

run-readme-example:
	@go run ./readme_example

run-real-user-smoke:
	@go run ./real_user_smoke
