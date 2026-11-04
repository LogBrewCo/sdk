#!/usr/bin/env bash
# Build the C SDK sources, with the libcurl HTTP transport, into a static library and header under $1.
set -euo pipefail

work="$1"
package="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/c/logbrew-c"
stamp="$(cat "${BASH_SOURCE[0]}" "$package"/include/*.h "$package"/src/* | shasum -a 256 | cut -d ' ' -f 1)"
if [[ -f "$work/.built" && "$(cat "$work/.built")" == "$stamp" ]]; then
  exit 0
fi

rm -rf "${work:?}/objects" "${work:?}/include" "${work:?}/lib"
mkdir -p "$work/objects" "$work/include" "$work/lib"
for source in "$package"/src/*.c; do
  cc -std=c99 -Wall -Wextra -Wpedantic -Werror -I"$package/include" -c "$source" -o "$work/objects/$(basename "$source" .c).o"
done
ar rcs "$work/lib/liblogbrew.a" "$work"/objects/*.o
cp "$package/include/logbrew.h" "$work/include/"
printf '%s' "$stamp" >"$work/.built"
