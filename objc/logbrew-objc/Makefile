OBJC ?= clang
OBJCFLAGS ?= -fobjc-arc -Wall -Wextra -Wpedantic -Werror -Iinclude
LDFLAGS ?= -framework Foundation
BUILD_DIR ?= build
CORE_SOURCES := src/LogBrew.m src/LogBrewTrace.m src/LogBrewNetworkValidation.m src/LogBrewURLSession.m

.PHONY: all test examples clean

all: test examples

$(BUILD_DIR):
	@mkdir -p "$(BUILD_DIR)"

$(BUILD_DIR)/test_logbrew: $(CORE_SOURCES) src/LBWHTTPTransport.m tests/test_logbrew.m include/LogBrew.h | $(BUILD_DIR)
	@$(OBJC) $(OBJCFLAGS) $(CORE_SOURCES) src/LBWHTTPTransport.m tests/test_logbrew.m $(LDFLAGS) -o "$@"

test: $(BUILD_DIR)/test_logbrew
	@$(BUILD_DIR)/test_logbrew

examples:
	@$(MAKE) -C examples OBJC="$(OBJC)"

clean:
	rm -rf "$(BUILD_DIR)"
	@$(MAKE) -C examples clean
