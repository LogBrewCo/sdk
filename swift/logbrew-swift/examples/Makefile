.PHONY: help run run-readme-example run-real-user-smoke run-trace-correlation

SWIFT_RUN = swift run --package-path ..
ifneq ($(SWIFT_SCRATCH),)
SWIFT_RUN += --scratch-path $(SWIFT_SCRATCH)
endif

help:
	@printf 'run-readme-example -> make run-readme-example\n'
	@printf 'run (real-user-smoke) -> make run\n'
	@printf 'run-real-user-smoke -> make run-real-user-smoke\n'
	@printf 'run-trace-correlation -> make run-trace-correlation\n'

run: run-real-user-smoke

run-readme-example:
	@$(SWIFT_RUN) ReadmeExample

run-real-user-smoke:
	@$(SWIFT_RUN) RealUserSmoke

run-trace-correlation:
	@$(SWIFT_RUN) TraceCorrelationExample
