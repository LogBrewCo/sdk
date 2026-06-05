.PHONY: help run run-readme-example run-real-user-smoke

help:
	@printf '%s\n' 'run-readme-example -> make run-readme-example'
	@printf '%s\n' 'run (real-user-smoke) -> make run'
	@printf '%s\n' 'run-real-user-smoke -> make run-real-user-smoke'

run: run-real-user-smoke

run-readme-example:
	@ruby readme_example.rb

run-real-user-smoke:
	@ruby real_user_smoke.rb
