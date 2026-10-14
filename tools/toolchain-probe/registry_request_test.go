package main

import "testing"

func TestRegistryRequestEndpoints(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		family, name, address string
		text                  bool
	}{
		{"npm", jsMetadataCore, "https://registry.npmjs.org/%40logbrew%2Fsdk", false},
		{"npm-provenance", jsMetadataCore, "https://registry.npmjs.org/%40logbrew%2Fsdk/1.2.3%2Bbuild", false},
		{"pypi", pythonCoreID, "https://pypi.org/pypi/logbrew-sdk/json", false},
		{"rubygems", pythonCoreID, "https://rubygems.org/api/v1/gems/logbrew-sdk.json", false},
		{nugetJobName, dotnetMetadataCore, "https://api.nuget.org/v3-flatcontainer/logbrew/index.json", false},
		{"packagist", "logbrew/sdk", "https://repo.packagist.org/p2/logbrew/sdk.json", false},
		{"crates", releaseMetadataKeyword, "https://index.crates.io/lo/gb/logbrew", true},
		{"maven", pythonCoreID, "https://repo1.maven.org/maven2/co/logbrew/logbrew-sdk/maven-metadata.xml", true},
		{"openupm", "co.logbrew.unity", "https://package.openupm.com/co.logbrew.unity", false},
	} {
		request, valid := newRegistryRequest(test.family, test.name, "1.2.3+build")
		if !valid || request.address != test.address || request.text != test.text || request.extract == nil {
			t.Errorf("registry request contract changed for %s", test.family)
		}
	}
	if _, valid := newRegistryRequest("unknown", "name", ""); valid {
		t.Fatal("unknown registry accepted")
	}
}
