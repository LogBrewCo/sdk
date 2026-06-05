OBJC ?= clang
OBJCFLAGS ?= -fobjc-arc -Wall -Wextra -Wpedantic -Werror -I../include
LDFLAGS ?= -framework Foundation
BUILD_DIR ?= build

.PHONY: all run-readme-example run run-real-user-smoke clean

all:
	@printf '%s\n' 'run-readme-example -> make run-readme-example'
	@printf '%s\n' 'run (real-user-smoke) -> make run'
	@printf '%s\n' 'run-real-user-smoke -> make run-real-user-smoke'

$(BUILD_DIR):
	@mkdir -p "$(BUILD_DIR)"

$(BUILD_DIR)/readme_example: readme_example.m ../src/LogBrew.m ../include/LogBrew.h | $(BUILD_DIR)
	@$(OBJC) $(OBJCFLAGS) ../src/LogBrew.m readme_example.m $(LDFLAGS) -o "$@"

$(BUILD_DIR)/real_user_smoke: real_user_smoke.m ../src/LogBrew.m ../include/LogBrew.h | $(BUILD_DIR)
	@$(OBJC) $(OBJCFLAGS) ../src/LogBrew.m real_user_smoke.m $(LDFLAGS) -o "$@"

run-readme-example: $(BUILD_DIR)/readme_example
	@$(BUILD_DIR)/readme_example

run: run-real-user-smoke

run-real-user-smoke: $(BUILD_DIR)/real_user_smoke
	@$(BUILD_DIR)/real_user_smoke

clean:
	rm -rf "$(BUILD_DIR)"
