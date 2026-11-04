#!/usr/bin/env bash
# Build the Java SDK jar the way scripts/check_java_package.sh compiles it, publish it to a local Maven
# repository in $1, and resolve a Spring Boot web app's runtime classpath against it into $1/classpath.txt.
set -euo pipefail

work="$1"
sdk="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
package="$sdk/java/logbrew-java"
spring_boot_version="4.1.2"
version="$(sed -n 's:^  <version>\(.*\)</version>$:\1:p' "$package/pom.xml" | head -n 1)"

stamp="$( (cat "${BASH_SOURCE[0]}" "$package/pom.xml"; find "$package/src/main" -type f | sort | xargs cat) | shasum -a 256 | cut -d ' ' -f 1)"
if [[ -f "$work/.installed" && "$(cat "$work/.installed")" == "$stamp" && -s "$work/classpath.txt" ]]; then
  exit 0
fi

# shellcheck source=scripts/java_logback_deps.sh
source "$sdk/scripts/java_logback_deps.sh"
rm -rf "$work/sdk-build"
mkdir -p "$work/sdk-build/classes"
optional="$(fetch_java_logback_deps "$work/deps"):$(fetch_java_opentelemetry_deps "$work/deps"):$(fetch_java_servlet_deps "$work/deps")"
optional="$optional:$(fetch_java_spring_boot_deps "$work/deps"):$(fetch_java_spring_kafka_deps "$work/deps"):$(fetch_java_spring_web_deps "$work/deps")"
find "$package/src/main/java" -name '*.java' | sort >"$work/sdk-build/sources.txt"
javac -Xlint:all -Werror --release 11 -cp "$optional" -d "$work/sdk-build/classes" @"$work/sdk-build/sources.txt"
cp -R "$package/src/main/resources/." "$work/sdk-build/classes/"
repository="$work/maven/co/logbrew/logbrew-sdk/$version"
mkdir -p "$repository"
jar --create --file "$repository/logbrew-sdk-$version.jar" -C "$work/sdk-build/classes" .
cp "$package/pom.xml" "$repository/logbrew-sdk-$version.pom"

app="$work/spring-boot-app"
mkdir -p "$app"
printf 'rootProject.name = "capture-probe-spring-boot"\n' >"$app/settings.gradle"
cat >"$app/build.gradle" <<EOF
plugins { id 'java' }
repositories {
    maven { url = uri('$work/maven') }
    mavenCentral()
}
dependencies {
    implementation 'co.logbrew:logbrew-sdk:$version'
    implementation 'org.springframework.boot:spring-boot-starter-web:$spring_boot_version'
}
tasks.register('writeClasspath') {
    def classpath = configurations.runtimeClasspath
    def output = file('$work/classpath.txt')
    doLast { output.text = classpath.asPath }
}
EOF
(cd "$app" && GRADLE_USER_HOME="$work/gradle-home" gradle --no-daemon --quiet writeClasspath)
printf '%s' "$stamp" >"$work/.installed"
