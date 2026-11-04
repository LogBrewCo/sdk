#!/usr/bin/env bash
# Build and install the C++ SDK with its libcurl HTTP transport through CMake into $1/prefix.
set -euo pipefail

work="$1"
package="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/cpp/logbrew-cpp"
stamp="$(cat "${BASH_SOURCE[0]}" "$package/CMakeLists.txt" "$package"/cmake/* "$package"/include/* "$package"/src/* | shasum -a 256 | cut -d ' ' -f 1)"
if [[ -f "$work/.installed" && "$(cat "$work/.installed")" == "$stamp" ]]; then
  exit 0
fi

rm -rf "$work/build" "$work/prefix"
cmake -S "$package" -B "$work/build" -DLOGBREW_BUILD_HTTP_TRANSPORT=ON -DCMAKE_INSTALL_PREFIX="$work/prefix"
cmake --build "$work/build"
cmake --install "$work/build"
printf '%s' "$stamp" >"$work/.installed"
