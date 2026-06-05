CC ?= cc
CFLAGS ?= -std=c99 -Wall -Wextra -Wpedantic -Werror -Iinclude
BUILD_DIR ?= build

.PHONY: all test examples clean

all: test examples

test:
	@mkdir -p "$(BUILD_DIR)"
	$(CC) $(CFLAGS) src/logbrew.c tests/test_logbrew.c -o "$(BUILD_DIR)/test_logbrew"
	"$(BUILD_DIR)/test_logbrew"

examples:
	$(MAKE) -C examples CC="$(CC)" CFLAGS="-std=c99 -Wall -Wextra -Wpedantic -Werror -I../include" SDK_SRC="../src/logbrew.c" run-readme-example >/dev/null
	$(MAKE) -C examples CC="$(CC)" CFLAGS="-std=c99 -Wall -Wextra -Wpedantic -Werror -I../include" SDK_SRC="../src/logbrew.c" run-real-user-smoke >/dev/null

clean:
	rm -rf "$(BUILD_DIR)" examples/build
