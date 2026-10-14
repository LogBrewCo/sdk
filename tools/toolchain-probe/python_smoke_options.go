package main

import (
	"path/filepath"
	"strings"
)

const (
	pythonSmokeMode         = "python-public-consumer"
	pythonSmokeManifestFlag = "--manifest"
	pythonSmokeArtifactFlag = "--artifact-root"
	pythonSmokeReceiptEnv   = "LOGBREW_RELEASE_RECEIPT_MODE"
	pythonSmokeUVVersion    = "0.12.9"
	pythonSmokePipVersion   = "26.2.1"
	pythonPipCommand        = "pip"
	pythonTargetFlag        = "--python"
	pythonIsolatedFlag      = "--isolated"
	pythonExtraCelery       = "celery"
	pythonExtraARQ          = "arq"
	pythonExtraDramatiq     = "dramatiq"
)

type pythonSmokeOptions struct {
	versions            map[string]string
	manifest, artifacts string
	receipt             bool
}

func parsePythonSmokeOptions(arguments []string, lookup func(string) string) (pythonSmokeOptions, bool) {
	options := pythonSmokeDefaults(lookup)
	var versions []string
	for len(arguments) > 0 {
		argument := arguments[0]
		arguments = arguments[1:]
		switch argument {
		case pythonSmokeManifestFlag, pythonSmokeArtifactFlag:
			if len(arguments) == 0 || !options.setPath(argument, arguments[0]) {
				return pythonSmokeOptions{}, false
			}
			arguments = arguments[1:]
		default:
			if !validPythonPackageVersion(argument) || len(versions) == len(pythonReleaseCatalog()) {
				return pythonSmokeOptions{}, false
			}
			versions = append(versions, argument)
		}
	}
	if options.artifacts != "" && options.manifest == "" || options.manifest != "" && len(versions) != 0 {
		return pythonSmokeOptions{}, false
	}
	options.selectVersions(versions)
	valid := options.valid(lookup)
	return options, valid
}

func (options *pythonSmokeOptions) selectVersions(versions []string) {
	for index, catalogIndex := range []int{0, 1, 3, 2} {
		if index < len(versions) {
			options.versions[pythonReleaseCatalog()[catalogIndex].id] = versions[index]
		}
	}
}

func pythonSmokeDefaults(lookup func(string) string) pythonSmokeOptions {
	options := pythonSmokeOptions{
		versions: make(map[string]string), manifest: "", artifacts: "", receipt: lookup(pythonSmokeReceiptEnv) == "1",
	}
	defaults := []string{"0.1.14", "0.1.10", "0.1.5", "0.1.6"}
	for index, spec := range pythonReleaseCatalog() {
		version := lookup(pythonSmokeVersionEnv(spec.id))
		if version == "" {
			version = defaults[index]
		}
		options.versions[spec.id] = version
	}
	return options
}

func pythonSmokeVersionEnv(id string) string {
	return "LOGBREW_PYPI_" + strings.ToUpper(strings.TrimPrefix(id, "logbrew-")) + "_VERSION"
}

func (options *pythonSmokeOptions) setPath(flag, value string) bool {
	absolute, err := filepath.Abs(value)
	if value == "" || err != nil {
		return false
	}
	target := &options.manifest
	if flag == pythonSmokeArtifactFlag {
		target = &options.artifacts
	}
	if *target != "" {
		return false
	}
	*target = absolute
	return true
}

func (options *pythonSmokeOptions) valid(lookup func(string) string) bool {
	if options.receipt && (options.manifest != "" || options.artifacts != "") {
		return false
	}
	if options.manifest != "" {
		data, readable := readCheckFile(options.manifest)
		document, parsed := readPythonManifestDocument(data)
		selection, valid := pythonManifestIdentity(document)
		if !readable || !parsed || !valid {
			return false
		}
		options.versions = selection.versions
	}
	for _, spec := range pythonReleaseCatalog() {
		if !validPythonPackageVersion(options.versions[spec.id]) ||
			options.receipt && options.versions[spec.id] != lookup(pythonSmokeVersionEnv(spec.id)) {
			return false
		}
	}
	return true
}

func pythonSmokeExtras(id, version string) string {
	if id == pythonFastAPIID && pythonVersionAtLeast(version, "0.1.8") {
		return "[celery]"
	}
	if id != pythonCoreID {
		return ""
	}
	extras := "rq"
	if pythonVersionAtLeast(version, "0.1.15") {
		extras = "arq," + extras
	}
	if pythonVersionAtLeast(version, "0.1.16") {
		extras = "dramatiq," + extras
	}
	return "[" + extras + "]"
}

func pythonVersionAtLeast(version, minimum string) bool {
	if !validPythonPackageVersion(version) || !validPythonPackageVersion(minimum) {
		return false
	}
	base, _, _ := strings.Cut(version, "-")
	base, _, _ = strings.Cut(base, "+")
	parts := strings.Split(base, ".")
	for index, floor := range strings.Split(minimum, ".") {
		actual := strings.TrimLeft(parts[index], "0")
		floor = strings.TrimLeft(floor, "0")
		if len(actual) != len(floor) {
			return len(actual) > len(floor)
		}
		if actual != floor {
			return actual > floor
		}
	}
	return true
}
