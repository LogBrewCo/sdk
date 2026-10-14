package main

import (
	"io"
	"slices"
	"strings"
	"testing"
)

const (
	expectedGoConsumers = "go python"
	expectedNativeAreas = "javascript react_native_native"
	expectedAreaCount   = 17
	goAreaFixture       = "go/a.go"
)

type areaCase struct{ path, enabled string }

func TestChangedAreas(t *testing.T) {
	t.Parallel()
	assertAreas(t, []areaCase{
		{"", ""},
		{"go", ""},
		{"./go", ""},
		{"gopher/main.go", ""},
		{"javascript/main.js", ""},
		{"maven/pom.xml", ""},
		{"release_artifacts/a.json", ""},
		{"Cargo.toml", areaRust},
		{"Cargo.lock", areaRust},
		{"rust/logbrew/src/lib.rs", areaRust},
		{"js/logbrew-js/src/index.ts", areaJS},
		{"python/logbrew_py/src/logbrew/__init__.py", areaPython},
		{"go/logbrew/logbrew.go", "go"},
		{"tools/toolchain-probe/main.go", expectedGoConsumers},
		{"tools/toolchain-probe/package_json.go", expectedGoConsumers},
		{"tools/toolchain-probe/.go-version", expectedGoConsumers},
		{"c/logbrew-c/src/logbrew.c", "c"},
		{"cpp/logbrew-cpp/include/logbrew.hpp", "cpp"},
		{"java/logbrew-java/src/main/java/co/logbrew/sdk/LogBrewClient.java", "java"},
		{"dotnet/logbrew-dotnet/src/LogBrew/LogBrew.cs", "dotnet"},
		{"unity/logbrew-unity/Runtime/LogBrew.cs", "unity"},
		{"ruby/logbrew-ruby/lib/logbrew.rb", "ruby"},
		{"php/logbrew-php/src/Client.php", "php"},
		{"swift/logbrew-swift/Sources/LogBrew/LogBrew.swift", "javascript react_native_native swift"},
		{"objc/logbrew-objc/Sources/LogBrew.m", "objc"},
		{"kotlin/logbrew-kotlin/src/main/kotlin/LogBrew.kt", "kotlin"},
		{"Package.swift", "swift"},
		{".github/workflows/publish-packages.yml", areaMaven},
		{".github/workflows/ci.yml", expectedGoConsumers},
	})
}

func TestScriptAndNativeAreas(t *testing.T) {
	t.Parallel()
	assertAreas(t, []areaCase{
		{mavenPublicSmoke, areaMaven},
		{"scripts/real_user_swift_build_executable.sh", areaSwift},
		{"scripts/real_user_next_release_artifact_smoke.sh", "release_artifacts"},
		{"scripts/real_user_native_release_public_smoke.sh", "c"},
		{"scripts/real_user_flask_smoke.sh", areaPython},
		{"scripts/check_fastapi_package.sh", areaPython},
		{"scripts/check_django_package.sh", areaPython},
		{"scripts/real_user_aws_sqs_smoke.sh", areaJS},
		{"scripts/real_user_react_native_smoke.sh", areaJS},
		{"scripts/build_maven_bundle.py", areaMaven},
		{"scripts/real_user_spring_smoke.sh", "java"},
		{"js/logbrew-next/release-artifact.ts", "javascript release_artifacts"},
		{"js/logbrew-react-native/README.md", areaJS},
		{"js/logbrew-react-native/ios/LBRNEventRecordStore.m", expectedNativeAreas},
		{"js/logbrew-react-native/android/src/Store.java", expectedNativeAreas},
		{"js/logbrew-react-native/src/NativeLogBrewFatalStore.ts", expectedNativeAreas},
		{"js/logbrew-react-native/index.native.js", expectedNativeAreas},
		{"js/logbrew-react-native/index.native.d.ts", expectedNativeAreas},
		{"js/logbrew-react-native/persistent-delivery.native.js", expectedNativeAreas},
		{"js/logbrew-react-native/test/run-native-store-tests.sh", expectedNativeAreas},
		{"swift/logbrew-swift/Sources/LogBrewCrash/CrashEngine.swift", "javascript react_native_native swift"},
	})
}

func assertAreas(t *testing.T, cases []areaCase) {
	t.Helper()
	for _, test := range cases {
		t.Run(test.path, func(t *testing.T) {
			t.Parallel()
			areas := classifyAreas([]string{" \t./" + test.path + " \n", test.path})
			if len(areas) != expectedAreaCount {
				t.Fatalf("area count = %d, want %d", len(areas), expectedAreaCount)
			}
			var enabled []string
			for name, active := range areas {
				if active {
					enabled = append(enabled, name)
				}
			}
			slices.Sort(enabled)
			if strings.Join(enabled, " ") != test.enabled {
				t.Fatalf("enabled areas = %q, want %q", enabled, test.enabled)
			}
		})
	}
}

func TestChangedAreasOutput(t *testing.T) {
	t.Parallel()
	var output strings.Builder
	if writeAreas(&output, []string{"python/a.py", goAreaFixture}) != exitOK {
		t.Fatal("area output failed")
	}
	want := "release_artifacts=false\nreact_native_native=false\nrust=false\njavascript=false\n" +
		"python=true\ngo=true\nc=false\ncpp=false\njava=false\ndotnet=false\nunity=false\n" +
		"ruby=false\nphp=false\nswift=false\nobjc=false\nkotlin=false\nmaven=false\n"
	if output.String() != want {
		t.Fatalf("area output = %q, want %q", output.String(), want)
	}
}

func TestChangedAreasArguments(t *testing.T) {
	t.Parallel()
	for _, paths := range [][]string{nil, {"--unknown"}, {goAreaFixture, "--github-output"}} {
		var output, diagnostic strings.Builder
		if code := runCISelection(paths, &output, &diagnostic); code != exitUsage || output.Len() != 0 {
			t.Fatalf("invalid area arguments: code=%d output=%q", code, output.String())
		}
		if diagnostic.String() != "CI selection requires explicit repository paths or --git\n" {
			t.Fatalf("unexpected area diagnostic: %q", diagnostic.String())
		}
	}
	if runCISelection([]string{goAreaFixture}, io.Discard, io.Discard) != exitOK {
		t.Fatal("explicit area path failed")
	}
}
