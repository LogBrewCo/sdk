import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { modifyPodfile } = require("../expo.cjs");

const podfile = [
  "platform :ios, '15.1'",
  "",
  "target 'Example' do",
  "  use_expo_modules!",
  "end",
  ""
].join("\n");

test("Expo plugin adds the optional Apple diagnostics subspec exactly once", () => {
  const once = modifyPodfile(podfile);
  const twice = modifyPodfile(once);
  assert.equal(twice, once);
  assert.equal(
    count(once, "pod 'LogBrewReactNative/AppleNativeDiagnostics'"),
    1
  );
  assert.match(once, /require\.resolve\('@logbrew\/react-native'\)/u);
  assert.ok(once.indexOf("AppleNativeDiagnostics") < once.indexOf("use_expo_modules!"));
});

test("Expo plugin removes only its managed block when disabled", () => {
  const enabled = modifyPodfile(podfile);
  assert.equal(modifyPodfile(enabled, false), podfile);
});

test("Expo plugin fails clearly when the Podfile has no application target", () => {
  assert.throws(
    () => modifyPodfile("platform :ios, '15.1'\n"),
    /could not locate an iOS application target/u
  );
});

function count(value, needle) {
  return value.split(needle).length - 1;
}
