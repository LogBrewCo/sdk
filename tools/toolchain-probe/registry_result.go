package main

import "net/http"

func registryExpectedVersions(family, version string) map[string]bool {
	if family == mavenMetadataFamily {
		return map[string]bool{version: true}
	}
	if version != "" && version[0] == 'v' {
		version = version[1:]
	}
	return map[string]bool{version: true, "v" + version: true}
}

func registryVersionsIntersect(found, expected map[string]bool) bool {
	for version := range found {
		if expected[version] {
			return true
		}
	}
	return false
}

// A missing page proves absence only through an HTTP status, not error text.
func registryAbsentResult(status int, readable bool, found, forbidden map[string]bool) bool {
	if status == http.StatusNotFound {
		return true
	}
	return status == http.StatusOK && readable && len(found) != 0 && !registryVersionsIntersect(found, forbidden)
}
