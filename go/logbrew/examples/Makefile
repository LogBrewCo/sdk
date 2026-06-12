.PHONY: help run run-agent-timeline run-readme-example run-real-user-smoke

help:
	@printf '%s\n' \
		'run-agent-timeline -> make run-agent-timeline' \
		'run-readme-example -> make run-readme-example' \
		'run (real-user-smoke) -> make run' \
		'run-real-user-smoke -> make run-real-user-smoke'

run: run-real-user-smoke

run-agent-timeline:
	@go run ./agent_timeline

run-readme-example:
	@go run ./readme_example

run-real-user-smoke:
	@go run ./real_user_smoke
