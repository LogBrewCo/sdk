package main

type registryVersionPolicy struct {
	overrides          map[string]map[string]string
	defaults           map[string]map[string]string
	version            string
	provenance, absent bool
}

type registryPlannedCheck struct {
	expected map[string]bool
	request  registryRequest
}

func registryPlanChecks(selection *registrySelection, policy *registryVersionPolicy) ([]registryPlannedCheck, bool) {
	if policy == nil || policy.version == "" || !registryValidSelectors(selection) {
		return nil, false
	}
	families, valid := registrySelectedFamilies(selection)
	if !valid {
		return nil, false
	}
	checks := make([]registryPlannedCheck, 0)
	for _, family := range families {
		for _, name := range registrySelectedPackages(selection, family) {
			check, ok := registryPlanCheck(family, name, policy)
			if !ok {
				return nil, false
			}
			checks = append(checks, check)
		}
	}
	return checks, true
}

func registryPlanCheck(family, name string, policy *registryVersionPolicy) (registryPlannedCheck, bool) {
	empty := new(registryPlannedCheck)
	label := name
	if family == mavenMetadataFamily {
		label = "co.logbrew:" + name
	}
	version := policy.version
	if value, found := policy.defaults[family][label]; found {
		version = value
	}
	if value, found := policy.overrides[family][label]; found {
		version = value
	}
	if version == "" {
		return *empty, false
	}
	expected := registryExpectedVersions(family, version)
	if policy.provenance && !policy.absent && family == registryNPMFamily {
		family = "npm-provenance"
		expected = map[string]bool{version: true}
	}
	request, valid := newRegistryRequest(family, name, version)
	if !valid {
		return *empty, false
	}
	return registryPlannedCheck{expected: expected, request: request}, true
}
