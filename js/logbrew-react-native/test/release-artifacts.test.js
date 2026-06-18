import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareLogBrewReactNativeReleaseArtifacts } from "../release-artifacts.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "logbrew-rn-release-artifacts-"));
}

function writeReactNativeBundle(buildDir) {
  fs.mkdirSync(buildDir, { recursive: true });
  const appRoot = path.resolve(buildDir, "..");
  const sourcePath = path.join(appRoot, "index.js");
  const bundlePath = path.join(buildDir, "index.android.bundle");
  const sourcemapPath = `${bundlePath}.map`;
  const sourceMap = {
    version: 3,
    file: "index.android.bundle",
    sources: ["__prelude__", sourcePath],
    sourcesContent: ["", "const localSourceMarker = 'should not ship';"],
    names: [],
    mappings: "AAAA",
  };
  fs.writeFileSync(
    bundlePath,
    "global.__checkoutProbe=function(){throw new Error('checkout exploded')};\n//# sourceMappingURL=index.android.bundle.map\n",
    "utf8",
  );
  fs.writeFileSync(sourcemapPath, JSON.stringify(sourceMap), "utf8");
  return { appRoot, bundlePath, sourcemapPath };
}

test("React Native release-artifact helper prepares bundle output and writes a ready manifest", () => {
  const root = tempDir();
  try {
    const buildDir = path.join(root, "dist");
    const { appRoot, bundlePath, sourcemapPath } = writeReactNativeBundle(buildDir);

    const result = prepareLogBrewReactNativeReleaseArtifacts({
      bundle: bundlePath,
      sourcemap: sourcemapPath,
      platform: "android",
      release: "2026.06.18-react-native-helper",
      environment: "production",
      service: "checkout-react-native",
      root: appRoot,
      repositoryUrl: "https://github.com/LogBrewCo/sdk",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
    });

    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
    const sourceMap = JSON.parse(fs.readFileSync(sourcemapPath, "utf8"));
    const bundleSource = fs.readFileSync(bundlePath, "utf8");

    assert.equal(result.prepareReport.validation.status, "ready");
    assert.equal(result.prepareReport.writeApplied, true);
    assert.equal(result.manifestReport.validation.status, "ready");
    assert.equal(manifest.validation.status, "ready");
    assert.equal(manifest.release, "2026.06.18-react-native-helper");
    assert.equal(manifest.environment, "production");
    assert.equal(manifest.service, "checkout-react-native");
    assert.equal(manifest.artifacts.length, 1);
    assert.equal(manifest.artifacts[0].minifiedSource.path, "index.android.bundle");
    assert.equal(
      manifest.artifacts[0].minifiedSource.minifiedUrl,
      "app:///react-native/android/index.android.bundle",
    );
    assert.equal(manifest.artifacts[0].sourceMap.hasSourcesContent, false);
    assert.equal(sourceMap.sourcesContent, undefined);
    assert.deepEqual(sourceMap.sources, ["__prelude__", "index.js"]);
    assert.match(bundleSource, /debugId=[0-9a-f-]{36}/u);
    assert.match(manifest.artifacts[0].debugId, /^[0-9a-f-]{36}$/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("React Native release-artifact helper requires explicit platform and preserves custom prefix", () => {
  const root = tempDir();
  try {
    const buildDir = path.join(root, "dist");
    const { bundlePath } = writeReactNativeBundle(buildDir);

    assert.throws(
      () =>
        prepareLogBrewReactNativeReleaseArtifacts({
          bundle: bundlePath,
          release: "2026.06.18-react-native-helper",
          environment: "production",
          service: "checkout-react-native",
        }),
      /requires platform/u,
    );

    const result = prepareLogBrewReactNativeReleaseArtifacts({
      bundle: bundlePath,
      platform: "ios",
      release: "2026.06.18-react-native-helper",
      environment: "production",
      service: "checkout-react-native",
      minifiedPathPrefix: "app:///rn-ios?cache=hidden#fragment",
    });

    assert.equal(
      result.manifestReport.artifacts[0].minifiedSource.minifiedUrl,
      "app:///rn-ios/index.android.bundle",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("React Native release-artifact helper resolves relative build paths from the app root", () => {
  const root = tempDir();
  try {
    const buildDir = path.join(root, "mobile", "dist");
    writeReactNativeBundle(buildDir);

    const result = prepareLogBrewReactNativeReleaseArtifacts({
      root,
      buildDir: "mobile/dist",
      bundle: "mobile/dist/index.android.bundle",
      platform: "android",
      release: "2026.06.18-react-native-helper",
      environment: "production",
      service: "checkout-react-native",
      manifestPath: "mobile/dist/logbrew-custom-manifest.json",
    });

    assert.equal(result.buildDir, buildDir);
    assert.equal(result.manifestPath, path.join(buildDir, "logbrew-custom-manifest.json"));
    assert.equal(fs.existsSync(result.manifestPath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
