package main

import "io"

const nugetProvenanceCommand = "nuget-provenance"

func runNugetProvenance(arguments []string, _, diagnostic io.Writer) int {
	options, valid := nugetProvenanceArguments(arguments)
	code := exitUsage
	if valid {
		if verifyNugetProvenance(options) {
			return exitOK
		}
		code = exitFailure
	}
	return writeText(diagnostic, "NuGet receipt provenance verification failed\n", code)
}

func nugetProvenanceArguments(arguments []string) (*nugetProvenance, bool) {
	var options nugetProvenance
	fields := map[string]*string{
		"--bound-dir": &options.boundDir, "--source-dir": &options.sourceDir,
		"--packages-dir": &options.packagesDir, "--assets": &options.assets,
		"--core-version": &options.coreVersion, "--httpclient-version": &options.httpclientVersion,
	}
	if len(arguments) != len(fields)*2 {
		return &options, false
	}
	for index := 0; index < len(arguments); index += 2 {
		field := fields[arguments[index]]
		value := arguments[index+1]
		if field == nil || *field != "" || value == "" || len(value) > outputLimit {
			return &options, false
		}
		*field = value
	}
	return &options, true
}
