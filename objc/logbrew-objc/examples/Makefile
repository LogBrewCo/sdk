OBJC ?= clang
OBJCFLAGS ?= -fobjc-arc -Wall -Wextra -Wpedantic -Werror -I../include
LDFLAGS ?= -framework Foundation
BUILD_DIR ?= build
CORE_SOURCES := ../src/LogBrew.m ../src/LogBrewTrace.m

.PHONY: all run-readme-example run run-real-user-smoke run-trace-correlation clean

all:
	@printf '%s\n' 'run-readme-example -> make run-readme-example'
	@printf '%s\n' 'run (real-user-smoke) -> make run'
	@printf '%s\n' 'run-real-user-smoke -> make run-real-user-smoke'
	@printf '%s\n' 'run-trace-correlation -> make run-trace-correlation'

$(BUILD_DIR):
	@mkdir -p "$(BUILD_DIR)"

$(BUILD_DIR)/readme_example: readme_example.m $(CORE_SOURCES) ../include/LogBrew.h | $(BUILD_DIR)
	@$(OBJC) $(OBJCFLAGS) $(CORE_SOURCES) readme_example.m $(LDFLAGS) -o "$@"

$(BUILD_DIR)/real_user_smoke: real_user_smoke.m $(CORE_SOURCES) ../include/LogBrew.h | $(BUILD_DIR)
	@$(OBJC) $(OBJCFLAGS) $(CORE_SOURCES) real_user_smoke.m $(LDFLAGS) -o "$@"

$(BUILD_DIR)/trace_correlation: trace_correlation.m $(CORE_SOURCES) ../include/LogBrew.h | $(BUILD_DIR)
	@$(OBJC) $(OBJCFLAGS) $(CORE_SOURCES) trace_correlation.m $(LDFLAGS) -o "$@"

run-readme-example: $(BUILD_DIR)/readme_example
	@$(BUILD_DIR)/readme_example

run: run-real-user-smoke

run-real-user-smoke: $(BUILD_DIR)/real_user_smoke
	@$(BUILD_DIR)/real_user_smoke

run-trace-correlation: $(BUILD_DIR)/trace_correlation
	@$(BUILD_DIR)/trace_correlation

clean:
	rm -rf "$(BUILD_DIR)"
