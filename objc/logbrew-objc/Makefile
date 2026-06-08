OBJC ?= clang
OBJCFLAGS ?= -fobjc-arc -Wall -Wextra -Wpedantic -Werror -Iinclude
LDFLAGS ?= -framework Foundation
BUILD_DIR ?= build

.PHONY: all test examples clean

all: test examples

$(BUILD_DIR):
	@mkdir -p "$(BUILD_DIR)"

$(BUILD_DIR)/test_logbrew: src/LogBrew.m src/LBWHTTPTransport.m tests/test_logbrew.m include/LogBrew.h | $(BUILD_DIR)
	@$(OBJC) $(OBJCFLAGS) src/LogBrew.m src/LBWHTTPTransport.m tests/test_logbrew.m $(LDFLAGS) -o "$@"

test: $(BUILD_DIR)/test_logbrew
	@$(BUILD_DIR)/test_logbrew

examples:
	@$(MAKE) -C examples OBJC="$(OBJC)"

clean:
	rm -rf "$(BUILD_DIR)"
	@$(MAKE) -C examples clean
