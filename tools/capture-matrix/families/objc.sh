#!/usr/bin/env bash
# Compile the Objective-C SDK sources, with LBWHTTPTransport, into object files and a header under $1.
set -euo pipefail

work="$1"
package="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/objc/logbrew-objc"
stamp="$(cat "${BASH_SOURCE[0]}" "$package"/include/*.h "$package"/src/* | shasum -a 256 | cut -d ' ' -f 1)"
if [[ -f "$work/.built" && "$(cat "$work/.built")" == "$stamp" ]]; then
  exit 0
fi

rm -rf "$work/objects" "$work/include"
mkdir -p "$work/objects" "$work/include"
for source in "$package"/src/*.m; do
  clang -fobjc-arc -Wall -Wextra -Wpedantic -Werror -I"$package/include" -c "$source" -o "$work/objects/$(basename "$source" .m).o"
done
cp "$package/include/LogBrew.h" "$work/include/"
printf '%s' "$stamp" >"$work/.built"
