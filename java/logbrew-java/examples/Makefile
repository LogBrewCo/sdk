.PHONY: help run run-readme-example run-first-useful-telemetry run-http-trace-correlation run-delivery-reliability run-encrypted-restart-delivery run-real-user-smoke
.DEFAULT_GOAL := help

LOGBREW_JAVA_EXTRA_CP ?=
EXAMPLE_CP = build/classes$(if $(LOGBREW_JAVA_EXTRA_CP),:$(LOGBREW_JAVA_EXTRA_CP))
SDK_SOURCES_CMD = find src/main/java -name '*.java'
ifeq ($(strip $(LOGBREW_JAVA_EXTRA_CP)),)
SDK_SOURCES_CMD = find src/main/java -name '*.java' ! -name 'LogBrewLogbackAppender.java' ! -name 'LogBrewOpenTelemetry.java' ! -name 'LogBrewOpenTelemetrySdk.java' ! -name 'LogBrewOpenTelemetrySpanExporter.java' ! -name 'LogBrewServletFilter.java' ! -name 'LogBrewSpringBootAutoConfiguration.java' ! -name 'LogBrewSpringBootCacheAutoConfiguration.java' ! -name 'LogBrewSpringBootCacheManagerPostProcessor.java' ! -name 'LogBrewSpringCacheTracing.java' ! -name 'LogBrewSpringBootJdbcAutoConfiguration.java' ! -name 'LogBrewSpringBootJdbcDataSourcePostProcessor.java' ! -name 'LogBrewSpringBootKafkaAutoConfiguration.java' ! -name 'LogBrewSpringBootKafkaBeanPostProcessor.java' ! -name 'LogBrewSpringKafkaTracing.java'
endif

help:
	@printf '%s\n' 'run-readme-example -> make run-readme-example'
	@printf '%s\n' 'run-first-useful-telemetry -> make run-first-useful-telemetry'
	@printf '%s\n' 'run-http-trace-correlation -> make run-http-trace-correlation'
	@printf '%s\n' 'run-delivery-reliability -> make run-delivery-reliability'
	@printf '%s\n' 'run-encrypted-restart-delivery -> make run-encrypted-restart-delivery'
	@printf '%s\n' 'run (real-user-smoke) -> make run'
	@printf '%s\n' 'run-real-user-smoke -> make run-real-user-smoke'

run: run-real-user-smoke

run-readme-example:
	@cd .. && mkdir -p build/classes build/examples && javac -Xlint:all -Werror --release 11 -cp "$(LOGBREW_JAVA_EXTRA_CP)" -d build/classes $$($(SDK_SOURCES_CMD) | sort) && javac -Xlint:all -Werror --release 11 -cp "$(EXAMPLE_CP)" -d build/examples examples/ReadmeExample.java && java -cp "$(EXAMPLE_CP):build/examples" ReadmeExample

run-first-useful-telemetry:
	@cd .. && mkdir -p build/classes build/examples && javac -Xlint:all -Werror --release 11 -cp "$(LOGBREW_JAVA_EXTRA_CP)" -d build/classes $$($(SDK_SOURCES_CMD) | sort) && javac -Xlint:all -Werror --release 11 -cp "$(EXAMPLE_CP)" -d build/examples examples/FirstUsefulTelemetry.java && java -cp "$(EXAMPLE_CP):build/examples" FirstUsefulTelemetry

run-http-trace-correlation:
	@cd .. && mkdir -p build/classes build/examples && javac -Xlint:all -Werror --release 11 -cp "$(LOGBREW_JAVA_EXTRA_CP)" -d build/classes $$($(SDK_SOURCES_CMD) | sort) && javac -Xlint:all -Werror --release 11 -cp "$(EXAMPLE_CP)" -d build/examples examples/HttpTraceCorrelation.java && java -cp "$(EXAMPLE_CP):build/examples" HttpTraceCorrelation

run-delivery-reliability:
	@cd .. && mkdir -p build/classes build/examples && javac -Xlint:all -Werror --release 11 -cp "$(LOGBREW_JAVA_EXTRA_CP)" -d build/classes $$($(SDK_SOURCES_CMD) | sort) && javac -Xlint:all -Werror --release 11 -cp "$(EXAMPLE_CP)" -d build/examples examples/DeliveryReliability.java && java -cp "$(EXAMPLE_CP):build/examples" DeliveryReliability

run-encrypted-restart-delivery:
	@cd .. && mkdir -p build/classes build/examples && javac -Xlint:all -Werror --release 11 -cp "$(LOGBREW_JAVA_EXTRA_CP)" -d build/classes $$($(SDK_SOURCES_CMD) | sort) && javac -Xlint:all -Werror --release 11 -cp "$(EXAMPLE_CP)" -d build/examples examples/EncryptedRestartDelivery.java && java -cp "$(EXAMPLE_CP):build/examples" EncryptedRestartDelivery

run-real-user-smoke:
	@cd .. && mkdir -p build/classes build/examples && javac -Xlint:all -Werror --release 11 -cp "$(LOGBREW_JAVA_EXTRA_CP)" -d build/classes $$($(SDK_SOURCES_CMD) | sort) && javac -Xlint:all -Werror --release 11 -cp "$(EXAMPLE_CP)" -d build/examples examples/ReadmeExample.java examples/RealUserSmoke.java && java -cp "$(EXAMPLE_CP):build/examples" RealUserSmoke
