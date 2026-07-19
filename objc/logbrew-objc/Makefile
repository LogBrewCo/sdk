OBJC ?= clang
OBJCFLAGS ?= -fobjc-arc -Wall -Wextra -Wpedantic -Werror -Iinclude
LDFLAGS ?= -framework Foundation
BUILD_DIR ?= build
CORE_SOURCES := src/LogBrew.m src/LBWDeliveryEngine.m src/LBWDeliveryEngineDurable.m src/LBWDurableDeliveryStore.m src/LogBrewTrace.m src/LogBrewNetworkValidation.m src/LogBrewURLSession.m src/LogBrewLifecycle.m

.PHONY: all test examples clean

all: test examples

$(BUILD_DIR):
	@mkdir -p "$(BUILD_DIR)"

$(BUILD_DIR)/test_logbrew: $(CORE_SOURCES) src/LBWHTTPTransport.m tests/test_logbrew.m include/LogBrew.h | $(BUILD_DIR)
	@$(OBJC) $(OBJCFLAGS) $(CORE_SOURCES) src/LBWHTTPTransport.m tests/test_logbrew.m $(LDFLAGS) -o "$@"

$(BUILD_DIR)/test_automatic_delivery: $(CORE_SOURCES) tests/test_automatic_delivery.m include/LogBrew.h | $(BUILD_DIR)
	@$(OBJC) $(OBJCFLAGS) $(CORE_SOURCES) tests/test_automatic_delivery.m $(LDFLAGS) -o "$@"

$(BUILD_DIR)/test_durable_delivery: $(CORE_SOURCES) tests/test_durable_delivery.m include/LogBrew.h | $(BUILD_DIR)
	@$(OBJC) $(OBJCFLAGS) $(CORE_SOURCES) tests/test_durable_delivery.m $(LDFLAGS) -o "$@"

$(BUILD_DIR)/test_durable_delivery_recovery: $(CORE_SOURCES) tests/test_durable_delivery_recovery.m include/LogBrew.h | $(BUILD_DIR)
	@$(OBJC) $(OBJCFLAGS) $(CORE_SOURCES) tests/test_durable_delivery_recovery.m $(LDFLAGS) -o "$@"

test: $(BUILD_DIR)/test_logbrew $(BUILD_DIR)/test_automatic_delivery $(BUILD_DIR)/test_durable_delivery $(BUILD_DIR)/test_durable_delivery_recovery
	@$(BUILD_DIR)/test_logbrew
	@$(BUILD_DIR)/test_automatic_delivery
	@$(BUILD_DIR)/test_durable_delivery
	@$(BUILD_DIR)/test_durable_delivery_recovery

examples:
	@$(MAKE) -C examples OBJC="$(OBJC)"

clean:
	rm -rf "$(BUILD_DIR)"
	@$(MAKE) -C examples clean
