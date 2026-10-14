package main

const (
	publicationSuccess    = "success"
	publicationSkipped    = "skipped"
	publicationConclusion = "conclusion"
	publicationName       = "name"
	publicationPyPIJob    = "PyPI packages"
)

type publicationContract struct {
	required map[string]string
	job      string
	failed   string
	siblings []string
}

func publicationFamilyContract(family string) (publicationContract, bool) {
	contract := publicationContract{
		required: map[string]string{"Check out release ref": publicationSuccess},
		siblings: []string{
			"crates.io package", "Maven Central package", "RubyGems package", "Packagist package",
			"Public registry verification", "Public SwiftPM verification", "npm packages",
		}, job: "", failed: "",
	}
	var successful []string
	switch family {
	case registryPythonFamily:
		contract.job, contract.failed = publicationPyPIJob, "Verify public PyPI installs"
		contract.siblings = append(contract.siblings, "NuGet package")
		successful = []string{
			"Build Python distributions", "Create Python release manifest",
			"Verify packed Python distributions", "Upload Python release manifest", "Publish logbrew-sdk to PyPI",
			"Publish logbrew-fastapi to PyPI", "Publish logbrew-flask to PyPI", "Publish logbrew-django to PyPI",
			"Verify public PyPI packages",
		}
	case nugetJobName:
		contract.job, contract.failed = "NuGet package / NuGet package", "Verify public NuGet package"
		contract.siblings = append(contract.siblings, publicationPyPIJob)
		successful = []string{
			"Bind immutable release source", "Check out protected release control",
			"Bind protected release control", "Plan selected NuGet packages", "Validate NuGet release metadata",
			"Check NuGet version collision", "Pack NuGet package", "Publish NuGet package",
		}
		contract.required["Verify public NuGet install"] = publicationSkipped
	default:
		return contract, false
	}
	for _, name := range successful {
		contract.required[name] = publicationSuccess
	}
	contract.required[contract.failed] = publicationFailure
	return contract, true
}
