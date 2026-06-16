CXX ?= c++
CXXFLAGS ?= -std=c++17 -Wall -Wextra -Wpedantic -Werror -I../include
SDK_SRC ?= ../src/logbrew.cpp
BUILD_DIR ?= build

.PHONY: help run run-readme-example run-real-user-smoke run-trace-correlation clean

help:
	@printf '%s\n' 'run-readme-example -> make run-readme-example'
	@printf '%s\n' 'run (real-user-smoke) -> make run'
	@printf '%s\n' 'run-real-user-smoke -> make run-real-user-smoke'
	@printf '%s\n' 'run-trace-correlation -> make run-trace-correlation'

run: run-real-user-smoke

run-readme-example:
	@mkdir -p "$(BUILD_DIR)"
	@$(CXX) $(CXXFLAGS) readme_example.cpp "$(SDK_SRC)" -o "$(BUILD_DIR)/readme_example"
	@"$(BUILD_DIR)/readme_example"

run-real-user-smoke:
	@mkdir -p "$(BUILD_DIR)"
	@$(CXX) $(CXXFLAGS) real_user_smoke.cpp "$(SDK_SRC)" -o "$(BUILD_DIR)/real_user_smoke"
	@"$(BUILD_DIR)/real_user_smoke"

run-trace-correlation:
	@mkdir -p "$(BUILD_DIR)"
	@$(CXX) $(CXXFLAGS) trace_correlation.cpp "$(SDK_SRC)" -o "$(BUILD_DIR)/trace_correlation"
	@"$(BUILD_DIR)/trace_correlation"

clean:
	rm -rf "$(BUILD_DIR)"
