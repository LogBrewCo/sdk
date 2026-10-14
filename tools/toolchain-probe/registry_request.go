package main

import "strings"

type registryRequest struct {
	extract                func(any) map[string]bool
	label, address, family string
	text                   bool
}

func newRegistryRequest(family, name, version string) (registryRequest, bool) {
	request := registryRequest{label: name, family: family, address: "", extract: nil, text: false}
	encoded := registryQuotedVersion(name)
	switch family {
	case "npm":
		request.address, request.extract = "https://registry.npmjs.org/"+encoded, registryNPMVersions
	case "npm-provenance":
		request.label += " provenance"
		request.address = "https://registry.npmjs.org/" + encoded + "/" + registryQuotedVersion(version)
		request.extract = registryNPMProvenanceVersions
	case "pypi":
		request.address, request.extract = "https://pypi.org/pypi/"+name+"/json", registryPyPIVersions
	case "rubygems":
		request.address, request.extract = "https://rubygems.org/api/v1/gems/"+name+".json", registryRubyVersions
	case nugetJobName:
		request.address = "https://api.nuget.org/v3-flatcontainer/" + strings.ToLower(name) + "/index.json"
		request.extract = registryNugetVersions
	case "packagist":
		request.address = "https://repo.packagist.org/p2/" + name + ".json"
		request.extract = func(payload any) map[string]bool { return registryPackagistVersions(payload, name) }
	case "crates":
		request.address = "https://index.crates.io/" + registryCratesIndexPath(name)
		request.extract = registryCratesVersions
		request.text = true
	case "maven":
		request.label = "co.logbrew:" + name
		request.address = "https://repo1.maven.org/maven2/co/logbrew/" + name + "/maven-metadata.xml"
		request.extract, request.text = registryMavenVersions, true
	case "openupm":
		request.address, request.extract = "https://package.openupm.com/"+encoded, registryNPMVersions
	default:
		return registryRequest{}, false
	}
	return request, true
}
