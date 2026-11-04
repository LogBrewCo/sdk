#!/usr/bin/env bash
# Build the Kotlin SDK and OkHttp integration jars the way scripts/check_kotlin_package.sh compiles them, fetch
# OkHttp and kotlinx-coroutines, and write the probes' classpath into $1/classpath.txt.
set -euo pipefail

work="$1"
sdk="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
core="$sdk/kotlin/logbrew-kotlin"
okhttp="$sdk/kotlin/logbrew-kotlin-okhttp"
coroutines_version="1.10.2"

stamp="$( (cat "${BASH_SOURCE[0]}" "$core/pom.xml" "$okhttp/pom.xml"; find "$core/src/main" "$okhttp/src/main" -type f | sort | xargs cat) | shasum -a 256 | cut -d ' ' -f 1)"
if [[ -f "$work/.installed" && "$(cat "$work/.installed")" == "$stamp" && -s "$work/classpath.txt" ]]; then
  exit 0
fi

# shellcheck source=scripts/kotlin_okhttp_deps.sh
source "$sdk/scripts/kotlin_okhttp_deps.sh"
# shellcheck source=scripts/java_logback_deps.sh
source "$sdk/scripts/java_logback_deps.sh"
kotlin_flags=(-jvm-target 11 -Xjdk-release=11 -Werror)
kotlinc "$core"/src/main/kotlin/co/logbrew/sdk/*.kt "${kotlin_flags[@]}" -d "$work/logbrew-kotlin.jar"
okhttp_deps="$(fetch_kotlin_okhttp_deps "$work/deps")"
find "$okhttp/src/main/kotlin" -name '*.kt' | sort >"$work/okhttp-sources.txt"
kotlinc @"$work/okhttp-sources.txt" -classpath "$work/logbrew-kotlin.jar:$okhttp_deps" "${kotlin_flags[@]}" -d "$work/logbrew-kotlin-okhttp.jar"
coroutines="$(fetch_maven_jars "$work/deps" \
  "org/jetbrains/kotlinx/kotlinx-coroutines-core-jvm/$coroutines_version/kotlinx-coroutines-core-jvm-$coroutines_version")"
printf '%s' "$work/logbrew-kotlin.jar:$work/logbrew-kotlin-okhttp.jar:$okhttp_deps:$coroutines" >"$work/classpath.txt"
printf '%s' "$stamp" >"$work/.installed"
