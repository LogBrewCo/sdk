#!/usr/bin/env bash

fetch_java_logback_deps() {
  local deps_dir="$1"
  local slf4j_version="${LOGBREW_SLF4J_VERSION:-2.0.18}"
  local logback_version="${LOGBREW_LOGBACK_VERSION:-1.5.34}"

  fetch_maven_jars "$deps_dir" \
    "org/slf4j/slf4j-api/$slf4j_version/slf4j-api-$slf4j_version" \
    "ch/qos/logback/logback-core/$logback_version/logback-core-$logback_version" \
    "ch/qos/logback/logback-classic/$logback_version/logback-classic-$logback_version"
}

fetch_java_opentelemetry_deps() {
  local deps_dir="$1"
  local opentelemetry_version="${LOGBREW_OPENTELEMETRY_VERSION:-1.63.0}"

  fetch_maven_jars "$deps_dir" \
    "io/opentelemetry/opentelemetry-api/$opentelemetry_version/opentelemetry-api-$opentelemetry_version" \
    "io/opentelemetry/opentelemetry-context/$opentelemetry_version/opentelemetry-context-$opentelemetry_version" \
    "io/opentelemetry/opentelemetry-common/$opentelemetry_version/opentelemetry-common-$opentelemetry_version" \
    "io/opentelemetry/opentelemetry-sdk-common/$opentelemetry_version/opentelemetry-sdk-common-$opentelemetry_version" \
    "io/opentelemetry/opentelemetry-sdk-trace/$opentelemetry_version/opentelemetry-sdk-trace-$opentelemetry_version"
}

fetch_java_servlet_deps() {
  local deps_dir="$1"
  local servlet_version="${LOGBREW_SERVLET_VERSION:-6.1.0}"

  fetch_maven_jars "$deps_dir" \
    "jakarta/servlet/jakarta.servlet-api/$servlet_version/jakarta.servlet-api-$servlet_version"
}

fetch_java_spring_boot_deps() {
  local deps_dir="$1"
  local spring_boot_version="${LOGBREW_SPRING_BOOT_VERSION:-4.1.0}"
  local spring_framework_version="${LOGBREW_SPRING_FRAMEWORK_VERSION:-7.0.8}"

  fetch_maven_jars "$deps_dir" \
    "org/springframework/boot/spring-boot/$spring_boot_version/spring-boot-$spring_boot_version" \
    "org/springframework/boot/spring-boot-autoconfigure/$spring_boot_version/spring-boot-autoconfigure-$spring_boot_version" \
    "org/springframework/spring-core/$spring_framework_version/spring-core-$spring_framework_version" \
    "org/springframework/spring-context/$spring_framework_version/spring-context-$spring_framework_version" \
    "org/springframework/spring-beans/$spring_framework_version/spring-beans-$spring_framework_version" \
    "commons-logging/commons-logging/1.3.5/commons-logging-1.3.5" \
    "org/jspecify/jspecify/1.0.0/jspecify-1.0.0"
}

fetch_java_spring_kafka_deps() {
  local deps_dir="$1"
  local spring_kafka_version="${LOGBREW_SPRING_KAFKA_VERSION:-4.1.0}"
  local spring_framework_version="${LOGBREW_SPRING_FRAMEWORK_VERSION:-7.0.8}"
  local kafka_clients_version="${LOGBREW_KAFKA_CLIENTS_VERSION:-4.2.1}"
  local micrometer_observation_version="${LOGBREW_MICROMETER_OBSERVATION_VERSION:-1.17.0}"

  fetch_maven_jars "$deps_dir" \
    "org/springframework/kafka/spring-kafka/$spring_kafka_version/spring-kafka-$spring_kafka_version" \
    "org/apache/kafka/kafka-clients/$kafka_clients_version/kafka-clients-$kafka_clients_version" \
    "org/springframework/spring-messaging/$spring_framework_version/spring-messaging-$spring_framework_version" \
    "org/springframework/spring-tx/$spring_framework_version/spring-tx-$spring_framework_version" \
    "io/micrometer/micrometer-observation/$micrometer_observation_version/micrometer-observation-$micrometer_observation_version"
}

fetch_java_spring_web_deps() {
  local deps_dir="$1"
  local spring_framework_version="${LOGBREW_SPRING_FRAMEWORK_VERSION:-7.0.8}"
  local reactor_version="${LOGBREW_REACTOR_VERSION:-3.8.6}"
  local reactive_streams_version="${LOGBREW_REACTIVE_STREAMS_VERSION:-1.0.4}"
  local micrometer_version="${LOGBREW_MICROMETER_OBSERVATION_VERSION:-1.17.0}"

  fetch_maven_jars "$deps_dir" \
    "org/springframework/spring-web/$spring_framework_version/spring-web-$spring_framework_version" \
    "org/springframework/spring-webmvc/$spring_framework_version/spring-webmvc-$spring_framework_version" \
    "org/springframework/spring-webflux/$spring_framework_version/spring-webflux-$spring_framework_version" \
    "org/springframework/spring-test/$spring_framework_version/spring-test-$spring_framework_version" \
    "io/projectreactor/reactor-core/$reactor_version/reactor-core-$reactor_version" \
    "org/reactivestreams/reactive-streams/$reactive_streams_version/reactive-streams-$reactive_streams_version" \
    "io/micrometer/micrometer-commons/$micrometer_version/micrometer-commons-$micrometer_version"
}

fetch_maven_jars() {
  local deps_dir="$1"
  shift
  local artifact_path classpath="" result=0 pid
  local -a artifacts=("$@") pids=()

  mkdir -p "$deps_dir"
  for artifact_path in "${artifacts[@]}"; do
    fetch_maven_jar "$artifact_path" "$deps_dir" &
    pids+=("$!")
  done
  for pid in "${pids[@]}"; do
    wait "$pid" || result=1
  done
  (( result == 0 )) || return 1
  for artifact_path in "${artifacts[@]}"; do
    classpath="${classpath:+$classpath:}$deps_dir/$(basename "$artifact_path").jar"
  done
  printf '%s\n' "$classpath"
}

fetch_maven_jar() {
  local artifact_path="$1"
  local deps_dir="$2"
  local base_url="https://repo.maven.apache.org/maven2/$artifact_path"
  local artifact_name
  artifact_name="$(basename "$artifact_path")"
  local jar_path="$deps_dir/$artifact_name.jar"
  local checksum_path="$jar_path.sha256"
  local cached_path="${LOGBREW_MAVEN_REPO:-$HOME/.m2/repository}/$artifact_path.jar"
  local -a curl_args=(
    --fail --silent --show-error --location --retry 1 --retry-all-errors
    --connect-timeout 2 --max-time 5
  )
  local -a checksum_args=(--fail --silent --location --connect-timeout 2 --max-time 5)

  if [[ -f "$cached_path" && -f "$cached_path.sha256" ]]; then
    cp "$cached_path" "$jar_path"
    cp "$cached_path.sha256" "$checksum_path"
    verify_java_checksum 256 "$jar_path" "$checksum_path"
    return
  fi
  if [[ -f "$cached_path" && -f "$cached_path.sha1" ]]; then
    cp "$cached_path" "$jar_path"
    checksum_path="$jar_path.sha1"
    cp "$cached_path.sha1" "$checksum_path"
    verify_java_checksum 1 "$jar_path" "$checksum_path"
    return
  fi
  if ! curl "${curl_args[@]}" --output "$jar_path" "$base_url.jar"; then
    return 1
  fi
  if curl "${checksum_args[@]}" --output "$checksum_path" "$base_url.jar.sha256"; then
    verify_java_checksum 256 "$jar_path" "$checksum_path"
  else
    checksum_path="$jar_path.sha1"
    if ! curl "${checksum_args[@]}" --output "$checksum_path" "$base_url.jar.sha1"; then
      return 1
    fi
    verify_java_checksum 1 "$jar_path" "$checksum_path"
  fi
}

verify_java_checksum() {
  local algorithm="$1" artifact="$2" checksum_file="$3" expected actual
  expected="$(awk 'NR == 1 { print $1 }' "$checksum_file")"
  actual="$(shasum -a "$algorithm" "$artifact" | awk '{ print $1 }')"
  if [[ "$actual" != "$expected" ]]; then
    printf 'checksum mismatch for %s: expected %s, got %s\n' \
      "$(basename "$artifact")" "$expected" "$actual" >&2
    return 1
  fi
}
