#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/cpp/logbrew-cpp"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cxx_command="${CXX:-}"
if [[ -z "$cxx_command" ]]; then
  if command -v clang++ >/dev/null 2>&1; then
    cxx_command="clang++"
  else
    cxx_command="c++"
  fi
fi

cmake_args=(
  -S "$package_dir"
  -B "$tmp_dir/build"
  "-DCMAKE_CXX_COMPILER=$cxx_command"
  "-DCMAKE_CXX_FLAGS=-Wall -Wextra -Wpedantic -Werror"
  "-DCMAKE_INSTALL_PREFIX=$tmp_dir/install"
  -DLOGBREW_BUILD_TESTS=ON
  -DLOGBREW_BUILD_EXAMPLES=ON
)
if command -v curl-config >/dev/null 2>&1; then
  cmake_args+=(-DLOGBREW_BUILD_HTTP_TRANSPORT=ON)
fi
cmake "${cmake_args[@]}"
cmake --build "$tmp_dir/build" --parallel
ctest --test-dir "$tmp_dir/build" --output-on-failure
cmake --install "$tmp_dir/build"

"$tmp_dir/build/logbrew_readme_example" > "$tmp_dir/readme.stdout.json" 2> "$tmp_dir/readme.stderr.json"
"$tmp_dir/build/logbrew_real_user_smoke" > "$tmp_dir/smoke.stdout.json" 2> "$tmp_dir/smoke.stderr.json"
"$tmp_dir/build/logbrew_trace_correlation" > "$tmp_dir/trace.stdout.json" 2> "$tmp_dir/trace.stderr.json"
for fixture in readme smoke trace; do
  python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/$fixture.stdout.json" >/dev/null
done
python3 "$repo_root/scripts/check_sdk_parity.py" \
  --allow-additive-context \
  "$repo_root/fixtures/valid-batch.json" \
  "$tmp_dir/readme.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" \
  --allow-additive-context \
  "$repo_root/fixtures/valid-batch.json" \
  "$tmp_dir/smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_cpp_trace_correlation_payload.py" \
  "$tmp_dir/trace.stdout.json" \
  "$tmp_dir/trace.stderr.json"
grep -q '"ok":true' "$tmp_dir/readme.stderr.json"
grep -q '"retryAttempts":3' "$tmp_dir/smoke.stderr.json"

config_file="$(find "$tmp_dir/install" -type f -name LogBrewConfig.cmake -print -quit)"
test -n "$config_file"
consumer_dir="$tmp_dir/installed-consumer"
mkdir -p "$consumer_dir"
cp "$package_dir/examples/readme_example.cpp" "$consumer_dir/readme_example.cpp"
cp "$package_dir/examples/http_transport.cpp" "$consumer_dir/http_transport.cpp"
cat > "$consumer_dir/CMakeLists.txt" <<'EOF'
cmake_minimum_required(VERSION 3.16)
project(LogBrewInstalledConsumer LANGUAGES CXX)
find_package(LogBrew 0.2.3 EXACT CONFIG REQUIRED)
add_executable(installed_consumer readme_example.cpp)
target_link_libraries(installed_consumer PRIVATE LogBrew::LogBrew)
if(TARGET LogBrew::HttpTransport)
  add_executable(installed_http_consumer http_transport.cpp)
  target_link_libraries(installed_http_consumer PRIVATE LogBrew::HttpTransport)
endif()
EOF
cmake \
  -S "$consumer_dir" \
  -B "$consumer_dir/build" \
  "-DLogBrew_DIR=$(dirname "$config_file")" \
  "-DCMAKE_CXX_FLAGS=-Wall -Wextra -Wpedantic -Werror"
cmake --build "$consumer_dir/build" --parallel
"$consumer_dir/build/installed_consumer" \
  > "$tmp_dir/installed.stdout.json" \
  2> "$tmp_dir/installed.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/installed.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/installed.stderr.json"

archive="$tmp_dir/logbrew-cpp-0.2.3.tar.gz"
(cd "$package_dir" && tar -czf "$archive" README.md CMakeLists.txt Makefile cmake include src examples tests)
tar -tzf "$archive" > "$tmp_dir/archive-contents.txt"
for archived_path in \
  README.md \
  CMakeLists.txt \
  cmake/LogBrewConfig.cmake.in \
  Makefile \
  include/logbrew.hpp \
  src/logbrew.cpp \
  src/logbrew_http_transport.cpp \
  examples/readme_example.cpp \
  examples/real_user_smoke.cpp \
  examples/trace_correlation.cpp \
  examples/http_transport.cpp \
  examples/Makefile \
  tests/test_logbrew.cpp \
  tests/test_rich_context.cpp; do
  grep -qx "$archived_path" "$tmp_dir/archive-contents.txt"
done

package_root="$tmp_dir/package-root"
extracted_dir="$package_root/cpp/logbrew-cpp"
mkdir -p "$extracted_dir"
tar -xzf "$archive" -C "$extracted_dir"
python3 "$repo_root/scripts/check_release_metadata.py" --root "$package_root" --only-cpp
make --no-print-directory -C "$extracted_dir" CXX="$cxx_command"
cmake \
  -S "$extracted_dir" \
  -B "$extracted_dir/cmake-build" \
  "-DCMAKE_CXX_COMPILER=$cxx_command" \
  -DLOGBREW_BUILD_TESTS=ON
cmake --build "$extracted_dir/cmake-build" --parallel
ctest --test-dir "$extracted_dir/cmake-build" --output-on-failure

echo "c++ package checks passed with $($cxx_command --version | head -n 1)"
