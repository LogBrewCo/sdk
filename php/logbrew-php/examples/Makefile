.PHONY: help run run-readme-example run-real-user-smoke

help:
	@printf '%s\n' \
		'run-readme-example -> make run-readme-example' \
		'run (real-user-smoke) -> make run' \
		'run-real-user-smoke -> make run-real-user-smoke'

run: run-real-user-smoke

run-readme-example:
	@php readme_example.php

run-real-user-smoke:
	@php real_user_smoke.php
