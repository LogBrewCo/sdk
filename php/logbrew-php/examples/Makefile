.PHONY: help run run-readme-example run-real-user-smoke run-first-useful-telemetry run-http-trace-correlation

help:
	@printf '%s\n' \
		'run-readme-example -> make run-readme-example' \
		'run (real-user-smoke) -> make run' \
		'run-real-user-smoke -> make run-real-user-smoke' \
		'run-first-useful-telemetry -> make run-first-useful-telemetry' \
		'run-http-trace-correlation -> make run-http-trace-correlation'

run: run-real-user-smoke

run-readme-example:
	@php readme_example.php

run-real-user-smoke:
	@php real_user_smoke.php

run-first-useful-telemetry:
	@php first_useful_telemetry.php

run-http-trace-correlation:
	@php http_trace_correlation.php
