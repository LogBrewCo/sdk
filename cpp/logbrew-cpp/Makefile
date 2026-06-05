CXX ?= c++
CXXFLAGS ?= -std=c++17 -Wall -Wextra -Wpedantic -Werror -Iinclude
BUILD_DIR ?= build

.PHONY: all test examples clean

all: test examples

test:
	@mkdir -p "$(BUILD_DIR)"
	$(CXX) $(CXXFLAGS) src/logbrew.cpp tests/test_logbrew.cpp -o "$(BUILD_DIR)/test_logbrew"
	"$(BUILD_DIR)/test_logbrew"

examples:
	$(MAKE) -C examples CXX="$(CXX)" CXXFLAGS="-std=c++17 -Wall -Wextra -Wpedantic -Werror -I../include" SDK_SRC="../src/logbrew.cpp" run-readme-example >/dev/null
	$(MAKE) -C examples CXX="$(CXX)" CXXFLAGS="-std=c++17 -Wall -Wextra -Wpedantic -Werror -I../include" SDK_SRC="../src/logbrew.cpp" run-real-user-smoke >/dev/null

clean:
	rm -rf "$(BUILD_DIR)" examples/build
