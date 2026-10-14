package main

import (
	"context"
	"io"
	"os"
	"slices"
	"strconv"
	"strings"
)

const (
	ciWorkflowPath        = ".github/workflows/ci.yml"
	readinessWorkflowPath = ".github/workflows/release-readiness.yml"
	publishWorkflowPath   = ".github/workflows/publish-packages.yml"
	knownAreas            = "release_artifacts react_native_native rust javascript python go c cpp java " +
		"dotnet unity ruby php swift objc kotlin maven"
	sourceAreas = "rust python go c cpp java dotnet unity ruby php swift objc kotlin"
	jsSmokes    = "js browser node prisma bullmq kafkajs amqplib aws_sqs express " +
		"fastify nestjs angular vue svelte react"
	areaRust    = "rust"
	areaJS      = "javascript"
	areaPython  = "python"
	areaGo      = "go"
	areaSwift   = "swift"
	areaMaven   = "maven"
	areaRelease = "release_artifacts"
	areaNative  = "react_native_native"
)

func runCISelection(paths []string, output, diagnostic io.Writer) int {
	snapshot := gitSnapshot{paths: paths, fullUnitDiscovery: false}
	if slices.Equal(paths, []string{"--git"}) {
		var ok bool
		snapshot, ok = changedGitSnapshot(context.Background(), "", gitSelection{
			event: os.Getenv("GITHUB_EVENT_NAME"), before: os.Getenv("GITHUB_EVENT_BEFORE"),
			head: os.Getenv("GITHUB_SHA"), base: os.Getenv("GITHUB_BASE_REF"),
		})
		if !ok {
			return writeText(diagnostic, "CI selection Git snapshot unavailable\n", exitFailure)
		}
	} else if len(paths) == 0 || slices.ContainsFunc(paths, func(path string) bool {
		return strings.HasPrefix(path, "-")
	}) {
		return writeText(diagnostic, "CI selection requires explicit repository paths or --git\n", exitUsage)
	}
	return snapshot.write(output)
}

func (snapshot gitSnapshot) write(output io.Writer) int {
	if writeAreas(output, snapshot.paths) != exitOK {
		return exitFailure
	}
	if snapshot.fullUnitDiscovery {
		return writeUnitTargets(output, nil)
	}
	return writeUnitTargets(output, snapshot.paths)
}

func classifyAreas(paths []string) map[string]bool {
	areas := make(map[string]bool)
	for name := range strings.FieldsSeq(knownAreas) {
		areas[name] = false
	}
	for _, path := range paths {
		path = strings.TrimPrefix(strings.TrimSpace(path), "./")
		directory, _, nested := strings.Cut(path, "/")
		if nested && slices.Contains(strings.Fields(sourceAreas), directory) {
			areas[directory] = true
		}
		classifyScript(path, areas)
		classifySpecialPath(path, areas)
	}
	return areas
}

func classifySpecialPath(path string, areas map[string]bool) {
	switch path {
	case ciWorkflowPath:
		areas[areaGo], areas[areaPython] = true, true
	case "Cargo.toml", "Cargo.lock":
		areas[areaRust] = true
	case "Package.swift":
		areas[areaSwift] = true
	case publishWorkflowPath:
		areas[areaMaven] = true
	default:
	}
	if strings.HasPrefix(path, "tools/toolchain-probe/") {
		areas[areaGo], areas[areaPython] = true, true
	}
	if strings.HasPrefix(path, "tools/toolchain-probe/js_") {
		areas[areaJS] = true
	}
	if strings.HasPrefix(path, "js/") {
		areas[areaJS] = true
		if strings.Contains(path, "release-artifact") || strings.Contains(path, "release_artifact") {
			areas[areaRelease] = true
		}
	}
	if nativeDurabilityPath(path) {
		areas[areaJS], areas[areaNative] = true, true
	}
}

func classifyScript(path string, areas map[string]bool) {
	name, script := strings.CutPrefix(path, "scripts/")
	if !script {
		return
	}
	if strings.Contains(name, "release_artifact") {
		areas[areaRelease] = true
	}
	for family := range strings.FieldsSeq(sourceAreas + " fastapi flask django maven") {
		if strings.HasPrefix(name, "check_"+family+"_") || strings.HasPrefix(name, "real_user_"+family+"_") {
			switch family {
			case "fastapi", "flask", "django":
				family = areaPython
			default:
			}
			areas[family] = true
		}
	}
	for family := range strings.FieldsSeq(jsSmokes) {
		if strings.HasPrefix(name, "real_user_"+family+"_") {
			areas[areaJS] = true
		}
	}
	for _, special := range [][2]string{
		{"check_js_", areaJS},
		{"build_maven_", areaMaven},
		{"real_user_spring_", "java"},
		{"real_user_native_release_public_", "c"},
	} {
		if strings.HasPrefix(name, special[0]) {
			areas[special[1]] = true
		}
	}
}

func nativeDurabilityPath(path string) bool {
	for _, prefix := range []string{
		"js/logbrew-react-native/android/", "js/logbrew-react-native/ios/",
		"js/logbrew-react-native/src/", "swift/logbrew-swift/Sources/LogBrew",
	} {
		if strings.HasPrefix(path, prefix) {
			return true
		}
	}
	switch path {
	case "js/logbrew-react-native/index.native.js", "js/logbrew-react-native/index.native.d.ts",
		"js/logbrew-react-native/persistent-delivery.native.js",
		"js/logbrew-react-native/test/run-native-store-tests.sh":
		return true
	default:
		return false
	}
}

func writeAreas(output io.Writer, paths []string) int {
	areas := classifyAreas(paths)
	names := strings.Fields(knownAreas)
	lines := make([]string, 0, len(names))
	for _, name := range names {
		lines = append(lines, name+"="+strconv.FormatBool(areas[name]))
	}
	return writeText(output, strings.Join(lines, "\n")+"\n", exitOK)
}
