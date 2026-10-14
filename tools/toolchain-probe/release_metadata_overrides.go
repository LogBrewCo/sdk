package main

import "os"

const metadataOverridePairSize = 2

const (
	metadataNPMVersionFlag   = "--npm-version"
	metadataNugetVersionFlag = "--nuget-version"
)

func configureReleaseMetadataOverrides(checks map[string]func(*os.Root) bool, arguments []string) bool {
	var npm, nuget []string
	for len(arguments) != 0 {
		if len(arguments) < metadataOverridePairSize {
			return false
		}
		switch arguments[0] {
		case metadataNPMVersionFlag:
			npm = append(npm, arguments[1])
		case metadataNugetVersionFlag:
			nuget = append(nuget, arguments[1])
		default:
			return false
		}
		arguments = arguments[metadataOverridePairSize:]
	}
	if len(npm) != 0 {
		checks[areaJS] = jsMetadataOverrideCheck(npm)
	}
	if len(nuget) != 0 {
		checks[dotnetMetadataFamily] = dotnetMetadataOverrideCheck(nuget)
	}
	return checks[areaJS] != nil && checks[dotnetMetadataFamily] != nil
}
