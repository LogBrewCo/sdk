CC ?= cc
CFLAGS ?= -std=c99 -Wall -Wextra -Wpedantic -Werror -Iinclude
BUILD_DIR ?= build
SDK_SRC = src/logbrew.c src/logbrew_metric.c src/logbrew_recording_transport.c src/logbrew_timeline.c src/logbrew_trace.c
HTTP_SDK_SRC = $(SDK_SRC) src/logbrew_http_transport.c

.PHONY: all test examples clean

all: test examples

test:
	@mkdir -p "$(BUILD_DIR)"
	$(CC) $(CFLAGS) $(SDK_SRC) tests/test_logbrew.c -o "$(BUILD_DIR)/test_logbrew"
	"$(BUILD_DIR)/test_logbrew"

examples:
	$(MAKE) -C examples CC="$(CC)" CFLAGS="-std=c99 -Wall -Wextra -Wpedantic -Werror -I../include" SDK_SRC="../src/logbrew.c ../src/logbrew_metric.c ../src/logbrew_recording_transport.c ../src/logbrew_timeline.c ../src/logbrew_trace.c" run-readme-example >/dev/null
	$(MAKE) -C examples CC="$(CC)" CFLAGS="-std=c99 -Wall -Wextra -Wpedantic -Werror -I../include" SDK_SRC="../src/logbrew.c ../src/logbrew_metric.c ../src/logbrew_recording_transport.c ../src/logbrew_timeline.c ../src/logbrew_trace.c" run-real-user-smoke >/dev/null

clean:
	rm -rf "$(BUILD_DIR)" examples/build
