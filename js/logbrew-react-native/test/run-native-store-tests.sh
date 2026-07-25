#!/usr/bin/env bash
set -euo pipefail

package_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"

remove_temp_directory() {
  rm -rf "$tmp_dir"
}
trap remove_temp_directory EXIT

ios_binary="$tmp_dir/ios-fatal-record-store-tests"
xcrun clang \
  -fobjc-arc \
  -fmodules \
  -framework Foundation \
  "$package_root/ios/LBRNFatalRecordStore.m" \
  "$package_root/ios/Tests/LBRNFatalRecordStoreTests.m" \
  -o "$ios_binary"
"$ios_binary"

ios_store="$tmp_dir/ios-process-store"
mkdir -p "$ios_store"
set +e
"$ios_binary" write-hard-exit "$ios_store"
ios_write_status=$?
set -e
test "$ios_write_status" -eq 93
"$ios_binary" read-mismatched-ack "$ios_store"
"$ios_binary" exact-ack "$ios_store"
"$ios_binary" read-empty "$ios_store"

android_classes="$tmp_dir/android-classes"
mkdir -p "$android_classes"
javac \
  -encoding UTF-8 \
  -source 8 \
  -target 8 \
  -d "$android_classes" \
  "$package_root/android/src/main/java/co/logbrew/reactnative/FatalRecordStore.java" \
  "$package_root/android/src/test/java/co/logbrew/reactnative/FatalRecordStoreTest.java"
java -ea -cp "$android_classes" co.logbrew.reactnative.FatalRecordStoreTest

android_store="$tmp_dir/android-process-store"
mkdir -p "$android_store"
set +e
java \
  -ea \
  -cp "$android_classes" \
  co.logbrew.reactnative.FatalRecordStoreTest \
  write-hard-exit \
  "$android_store"
android_write_status=$?
set -e
test "$android_write_status" -eq 93
java \
  -ea \
  -cp "$android_classes" \
  co.logbrew.reactnative.FatalRecordStoreTest \
  read-mismatched-ack \
  "$android_store"
java \
  -ea \
  -cp "$android_classes" \
  co.logbrew.reactnative.FatalRecordStoreTest \
  exact-ack \
  "$android_store"
java \
  -ea \
  -cp "$android_classes" \
  co.logbrew.reactnative.FatalRecordStoreTest \
  read-empty \
  "$android_store"

printf '%s\n' "native fatal record subprocess canaries: ios=4 android=4"
